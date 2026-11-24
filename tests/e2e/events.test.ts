import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { EncryptedSecretStore } from '../../src/storage/secrets.js';
import type { McpEventSubscriptionRecord, SecretMetadata } from '../../src/types/index.js';
import { eventName as upstreamEvent } from './fixtures/mcp-responses.mjs';
import { callbackAddress, callbackHost, type Delivery } from './fixtures/webhook.js';
import { addSource, api, clientToken, httpMcp, httpSource, json, mcpClient, openSse, startGateway } from './harness.js';

const callbacks = vi.hoisted(() => ({ attempts: [] as string[], deliveries: [] as Delivery[] }));
vi.mock('node:dns/promises', async importOriginal => {
  const dns = await importOriginal<typeof import('node:dns/promises')>();
  const { callbackAddress, callbackHost } = await import('./fixtures/webhook.js');
  return {
    ...dns,
    lookup: (hostname: string, ...args: unknown[]) => hostname === callbackHost
      ? Promise.resolve([callbackAddress]) : Reflect.apply(dns.lookup, undefined, [hostname, ...args]),
  };
});
vi.mock('node:https', async importOriginal => {
  const https = await importOriginal<typeof import('node:https')>();
  const { webhookRequest } = await import('./fixtures/webhook.js');
  return { ...https, request: webhookRequest(callbacks.attempts, callbacks.deliveries) };
});
beforeEach(() => {
  callbacks.attempts.length = 0;
  callbacks.deliveries.length = 0;
});

const version = '2026-07-28';
const protocolKey = 'io.modelcontextprotocol/protocolVersion';
const subscriptionKey = 'io.modelcontextprotocol/subscriptionId';
const name = 'fabric.proposal.created';
interface Page {
  events: { eventId: string; name: string; cursor: string; data: { id: string } }[];
  cursor: string;
  hasMore: boolean;
}

it('negotiates MCP 2026-07-28 via the header and request metadata and rejects unsupported versions', async () => {
  const gateway = await startGateway();
  const mcp = mcpClient(gateway, await clientToken(gateway));
  for (const [headers, params] of [
    [{ 'MCP-Protocol-Version': version }, {}],
    [{}, { _meta: { [protocolKey]: version } }],
    [{ 'MCP-Protocol-Version': version }, { _meta: { [protocolKey]: version } }],
  ] satisfies [HeadersInit, Record<string, unknown>][]) {
    const { id, response } = mcp.request('server/discover', params, headers);
    const discovery = await response;
    expect(discovery.headers.get('mcp-protocol-version')).toBe(version);
    expect(await json(discovery)).toMatchObject({ id, result: {
      resultType: 'complete', supportedVersions: [version],
      capabilities: { extensions: { 'io.modelcontextprotocol/events': { listChanged: true } },
        events: { deliveryModes: ['poll', 'push', 'webhook'] } },
    } });
  }
  const unknown = '2099-01-01';
  for (const [headers, params] of [
    [{ 'MCP-Protocol-Version': unknown }, {}], [{}, { _meta: { [protocolKey]: unknown } }],
  ] satisfies [HeadersInit, Record<string, unknown>][]) {
    const { id, response } = mcp.request('ping', params, headers);
    expect(await json(await response, 400)).toEqual({ jsonrpc: '2.0', id, error: {
      code: -32022, message: 'UnsupportedProtocolVersionError', data: { requested: unknown,
        supported: [version, '2025-11-25', '2025-03-26'] },
    } });
  }
  const conflict = mcp.request('ping', { _meta: { [protocolKey]: '2025-11-25' } }, { 'MCP-Protocol-Version': version });
  expect(await json(await conflict.response)).toMatchObject({ error: { data: { code: 'INVALID_INPUT' } } });
});

it('replays scoped event pages and streams replay, live events, and cursor heartbeats over SSE', async () => {
  const gateway = await startGateway();
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const poll = (params: Record<string, unknown> = {}) => mcp.result<Page>('events/poll', { name, ...params });
  const emit = async (id: string, profileId = 'default') => {
    const { occurrence } = await api<{ occurrence: { eventId: string; cursor: string; timestamp: string } }>(
      gateway, '/events/emit', 'POST', { name, data: { id, profileId } }, 201);
    const { eventId, cursor, timestamp } = occurrence;
    return { eventId, cursor, timestamp, name, data: { id, profileId } };
  };
  expect(await mcp.result('events/list')).toMatchObject({ events: expect.arrayContaining([
    expect.objectContaining({ name, delivery: ['poll', 'push', 'webhook'] }),
  ]) });
  const initial = await poll({ cursor: null });
  expect(initial).toMatchObject({ events: [], cursor: expect.any(String), hasMore: false });
  const one = await emit('one');
  await emit('foreign', 'other-profile');
  const two = await emit('two');
  const first = await poll({ cursor: initial.cursor, maxEvents: 1 });
  expect(first).toMatchObject({ hasMore: true, events: [one] });
  const second = await poll({ cursor: first.cursor, maxEvents: 1 });
  expect(second).toMatchObject({ hasMore: false, events: [two] });
  expect(await poll({ cursor: second.cursor })).toMatchObject({ events: [], cursor: second.cursor });
  await mcp.error('events/poll', { name, cursor: 'invalid' }, 'INVALID_INPUT');

  const request = mcp.request('events/stream', { name, heartbeatMs: 1000 }, { 'Last-Event-ID': one.cursor });
  const stream = await openSse(await request.response);
  try {
    expect(await stream.next()).toMatchObject({ id: one.cursor, message: { method: 'notifications/events/active',
      params: { cursor: one.cursor, heartbeatMs: 1000, _meta: { [subscriptionKey]: request.id } } } });
    expect(await stream.next()).toMatchObject({ id: two.cursor, message: { method: 'notifications/events/event',
      params: { ...two, _meta: { [subscriptionKey]: request.id } } } });
    const live = await emit('live');
    expect(await stream.next()).toMatchObject({ id: live.cursor, message: { method: 'notifications/events/event', params: live } });
    expect(await stream.next()).toMatchObject({ id: live.cursor, message: { method: 'notifications/events/heartbeat',
      params: { cursor: live.cursor, _meta: { [subscriptionKey]: request.id } } } });
    expect(await poll({ cursor: live.cursor })).toMatchObject({ events: [], hasMore: false });
  } finally {
    await stream.close();
  }
});

it('discovers events and forwards poll and push payloads from a real HTTP MCP upstream', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  expect((await addSource(gateway, httpSource(upstream.mcpUrl))).health).toBe('healthy');
  const mcp = mcpClient(gateway, await clientToken(gateway));
  expect(await mcp.result('events/list')).toMatchObject({ events: expect.arrayContaining([
    expect.objectContaining({ name: upstreamEvent, delivery: ['poll', 'push'] }),
  ]) });
  expect(await mcp.result('events/poll', { name: upstreamEvent, cursor: 'fixture-previous' })).toMatchObject({
    events: [{ name: upstreamEvent, eventId: 'fixture-event-1', data: { value: 'upstream change' } }], cursor: 'fixture-next',
  });
  expect(upstream.requests.find(request => request.method === 'events/poll')?.params)
    .toMatchObject({ name: upstreamEvent, cursor: 'fixture-previous' });
  const request = mcp.request('events/stream', { name: upstreamEvent, cursor: 'fixture-push-start', heartbeatMs: 1000 });
  const stream = await openSse(await request.response);
  try {
    expect(await stream.next()).toMatchObject({ message: { method: 'notifications/events/active',
      params: { cursor: 'fixture-push-start', _meta: { [subscriptionKey]: request.id } } } });
    expect(await stream.next()).toMatchObject({ message: { method: 'notifications/events/event',
      params: { name: upstreamEvent, eventId: 'fixture-event-1', data: { value: 'upstream change' }, cursor: 'fixture-push-next' } } });
    expect(await stream.next()).toMatchObject({ message: { method: 'notifications/events/heartbeat', params: { cursor: 'fixture-push-next' } } });
    expect(await stream.next()).toMatchObject({ message: { id: request.id, result: { resultType: 'complete' } } });
  } finally {
    await stream.close();
  }
});

it('persists poll and push subscriptions and restricts unsubscribe to the owning client', async () => {
  const gateway = await startGateway();
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const other = mcpClient(gateway, await clientToken(gateway));
  const modes = ['poll', 'push'] as const;
  const start = await mcp.result<Page>('events/poll', { name });
  const subscriptions = [];
  for (const mode of modes) {
    const sub = await mcp.result<{ id: string; cursor: string }>('events/subscribe', { name, cursor: start.cursor, delivery: { mode } });
    expect(sub).toMatchObject({ id: expect.any(String), cursor: start.cursor, expiresAt: expect.any(String) });
    subscriptions.push({ id: sub.id, mode });
  }
  expect(subscriptions[0].id).not.toBe(subscriptions[1].id);
  expect(await api(gateway, '/events/subscriptions')).toMatchObject({ subscriptions: expect.arrayContaining(
    subscriptions.map(subscription => expect.objectContaining({ ...subscription, name })),
  ) });
  for (const { id } of subscriptions) {
    expect(await other.error('events/unsubscribe', { id }, 'NOT_FOUND')).toMatchObject({ code: -32023 });
    expect(await mcp.result('events/unsubscribe', { id })).toMatchObject({ resultType: 'complete' });
  }
  expect(await api(gateway, '/events/subscriptions')).toEqual({ subscriptions: [] });
});

it('blocks insecure, localhost, and private webhook targets before an outbound HTTPS request', async () => {
  const gateway = await startGateway();
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const secret = `whsec_${randomBytes(32).toString('base64')}`;
  for (const url of ['http://localhost/events', `http://${callbackHost}/events`]) {
    expect(await mcp.error('events/subscribe', { name, delivery: { mode: 'webhook', url, secret } }, 'INVALID_INPUT'))
      .toMatchObject({ code: -32602 });
  }
  for (const url of ['https://localhost/events', 'https://127.0.0.1/events', 'https://192.168.1.4/events', 'https://[::1]/events']) {
    expect(await mcp.error('events/subscribe', { name, delivery: { mode: 'webhook', url, secret } }, 'INVALID_INPUT'))
      .toMatchObject({ code: -32027, message: 'CallbackEndpointError', data: { reason: 'challenge_failed' } });
  }
  expect(callbacks.attempts).toEqual([]);
  expect(await api(gateway, '/events/subscriptions')).toEqual({ subscriptions: [] });
  expect(await api(gateway, '/secrets')).toEqual({ secrets: [] });
});

it('verifies an HTTPS webhook challenge, signs delivery, and deletes the encrypted signing key on unsubscribe', async () => {
  const gateway = await startGateway();
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const key = randomBytes(32);
  const secret = `whsec_${key.toString('base64')}`;
  const url = `https://${callbackHost}/events`;
  const sub = await mcp.result<{ id: string; cursor: string }>('events/subscribe', { name, delivery: { mode: 'webhook', url, secret } });
  expect(sub).toMatchObject({ id: expect.any(String), cursor: expect.any(String) });
  expect(JSON.stringify(sub)).not.toContain(secret);
  const { subscriptions } = await api<{ subscriptions: McpEventSubscriptionRecord[] }>(gateway, '/events/subscriptions');
  expect(subscriptions).toMatchObject([{ id: sub.id, name, mode: 'webhook', callbackUrl: url }]);
  expect(subscriptions[0]).not.toHaveProperty('secretName');
  const secrets = await api<{ secrets: SecretMetadata[] }>(gateway, '/secrets');
  expect(secrets.secrets).toHaveLength(1);
  expect(JSON.stringify(secrets)).not.toContain(secret);
  const secretName = secrets.secrets[0].name;
  expect(secretName).toContain(sub.id);
  expect((await readFile(join(gateway.homeDir, 'secrets.enc'))).includes(Buffer.from(secret))).toBe(false);
  expect(await (await EncryptedSecretStore.open(gateway.homeDir)).get(secretName)).toBe(secret);

  const checkSignature = (delivery: Delivery) => {
    const { headers, body, addresses } = delivery;
    expect(addresses).toEqual([callbackAddress]);
    expect(headers['X-MCP-Subscription-Id']).toBe(sub.id);
    expect(headers['webhook-id']).toEqual(expect.stringMatching(/^msg_/));
    expect(headers['webhook-timestamp']).toEqual(expect.stringMatching(/^\d+$/));
    const signature = createHmac('sha256', key)
      .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${signature}`);
  };
  expect(callbacks.deliveries).toHaveLength(1);
  expect(JSON.parse(callbacks.deliveries[0].body)).toMatchObject({ type: 'verification', challenge: expect.any(String) });
  checkSignature(callbacks.deliveries[0]);
  const { occurrence } = await api<{ occurrence: { eventId: string } }>(gateway, '/events/emit', 'POST', {
    name, data: { id: 'webhook-delivery', profileId: 'default' },
  }, 201);
  await vi.waitFor(() => expect(callbacks.deliveries).toHaveLength(2), { timeout: 4000 });
  const delivered = callbacks.deliveries[1];
  checkSignature(delivered);
  expect(delivered.headers['webhook-id']).not.toBe(callbacks.deliveries[0].headers['webhook-id']);
  expect(JSON.parse(delivered.body)).toMatchObject({ name, eventId: occurrence.eventId, cursor: sub.cursor,
    data: { id: 'webhook-delivery', profileId: 'default' } });

  expect(await mcp.result('events/unsubscribe', { id: sub.id })).toMatchObject({ resultType: 'complete' });
  expect(await api(gateway, '/events/subscriptions')).toEqual({ subscriptions: [] });
  expect(await api(gateway, '/secrets')).toEqual({ secrets: [] });
  expect(await (await EncryptedSecretStore.open(gateway.homeDir)).get(secretName)).toBeNull();
});
