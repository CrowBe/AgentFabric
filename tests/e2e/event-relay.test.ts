import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SecretMetadata } from '../../src/types/index.js';
import { sign, startingEvent, startWebhookUpstream } from './fixtures/webhook-upstream.js';
import { addSource, api, clientToken, httpSource, mcpClient, startGateway, track } from './harness.js';

interface Delivery { headers: Record<string, string>; body: string }
const downstream = vi.hoisted(() => ({ host: 'agent-host.test', deliveries: [] as { headers: Record<string, string>; body: string }[], status: 200 }));
vi.mock('node:dns/promises', async importOriginal => {
  const dns = await importOriginal<typeof import('node:dns/promises')>();
  return { ...dns, lookup: (hostname: string, ...args: unknown[]) => hostname === downstream.host
    ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : Reflect.apply(dns.lookup, undefined, [hostname, ...args]) };
});
vi.mock('node:https', async importOriginal => {
  const https = await importOriginal<typeof import('node:https')>();
  const request = (url: URL, options: { headers: Record<string, string> },
    receive: (response: EventEmitter & { statusCode: number }) => void) => Object.assign(new EventEmitter(), {
    end(body: string) {
      queueMicrotask(() => {
        downstream.deliveries.push({ headers: options.headers, body });
        const payload = JSON.parse(body);
        const response = Object.assign(new EventEmitter(), { statusCode: payload.type === 'verification' ? 200 : downstream.status });
        receive(response);
        response.emit('data', Buffer.from(JSON.stringify(payload.type === 'verification' ? { challenge: payload.challenge } : {})));
        response.emit('end');
      });
    },
    destroy() {},
  });
  return { ...https, request };
});
beforeEach(() => {
  downstream.deliveries.length = 0;
  downstream.status = 200;
});

const ingressUrl = 'https://fabric.example.test';
const callbackUrl = `https://${downstream.host}/hooks`;
const calendar = { calendarId: 'primary', agentEmail: 'agent@example.test' };

async function relayGateway(options: { failSubscribe?: boolean; ingress?: boolean } = {}) {
  const bearer = randomBytes(24).toString('hex');
  let gatewayUrl = '';
  const upstream = track(await startWebhookUpstream({ bearer, gatewayUrl: () => gatewayUrl, failSubscribe: options.failSubscribe }));
  const gateway = await startGateway(options.ingress === false ? { publicUrl: 'https://gateway.example.test' } : { ingressUrl, ingressPort: 0 });
  gatewayUrl = gateway.ingress?.url ?? gateway.url;
  await api(gateway, '/secrets/calendar-bridge', 'PUT', { value: bearer });
  const source = await addSource(gateway, { ...httpSource(upstream.mcpUrl, 'calendar'),
    authConfig: { kind: 'bearer_secret', secretName: 'calendar-bridge' } });
  expect(source.health, JSON.stringify(source)).toBe('healthy');
  const mcp = mcpClient({ ...gateway, mcpUrl: `${gateway.url}/mcp` }, await clientToken(gateway));
  const key = randomBytes(32);
  const secret = `whsec_${key.toString('base64')}`;
  const subscribe = () => mcp.reply<{ id: string; refreshBefore: string }>('events/subscribe', {
    name: startingEvent, arguments: calendar, delivery: { mode: 'webhook', url: callbackUrl, secret } });
  return { upstream, gateway, mcp, key, secret, subscribe };
}

function verifyDownstream(delivery: Delivery, key: Buffer) {
  const { headers, body } = delivery;
  const signature = createHmac('sha256', key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  expect(headers['webhook-signature']).toBe(`v1,${signature}`);
  return JSON.parse(body);
}

const events = (body: Record<string, unknown>[]) => body.filter(item => item.type === undefined);

it('relays a webhook-only upstream event to a webhook subscriber with gateway-held upstream credentials', async () => {
  const { upstream, gateway, mcp, key, secret, subscribe } = await relayGateway();
  expect(await mcp.result('events/list')).toMatchObject({ events: expect.arrayContaining([
    expect.objectContaining({ name: startingEvent, delivery: ['webhook'] }),
  ]) });
  const { result } = await subscribe();
  expect(result).toMatchObject({ id: expect.stringMatching(/^sub_/), refreshBefore: expect.any(String) });
  const relayed = upstream.only();
  expect(relayed.url).toBe(`${ingressUrl}/events/ingress/${result!.id}`);
  expect(relayed.arguments).toEqual(calendar);
  expect(relayed.secret).toMatch(/^whsec_/);
  expect(relayed.secret).not.toBe(secret);
  expect(JSON.stringify(await api(gateway, '/events/subscriptions'))).not.toContain(relayed.secret);
  expect(JSON.stringify(await api(gateway, '/sources'))).not.toContain(relayed.secret);

  const occurrence = upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z', title: 'Standup' });
  const response = await upstream.post(relayed, occurrence, { 'webhook-id': 'msg_upstream_1' });
  expect(response.status).toBe(200);
  const delivered = downstream.deliveries.at(-1)!;
  expect(delivered.headers['webhook-id']).toBe('msg_upstream_1');
  expect(delivered.headers['X-MCP-Subscription-Id']).toBe(result!.id);
  expect(verifyDownstream(delivered, key)).toEqual({ ...occurrence, cursor: null });

  expect(await mcp.result('events/unsubscribe', { id: result!.id })).toMatchObject({ resultType: 'complete' });
  expect(upstream.requests.filter(rpc => rpc.method === 'events/unsubscribe')).toMatchObject([
    { params: { name: startingEvent, arguments: calendar, delivery: { mode: 'webhook', url: relayed.url } } },
  ]);
  expect((await api<{ secrets: SecretMetadata[] }>(gateway, '/secrets')).secrets.map(item => item.name)).toEqual(['calendar-bridge']);
  expect((await upstream.post(relayed, occurrence)).status).toBe(404);
});

it('rejects forged, stale, foreign, and schema-breaking ingress deliveries before they reach the subscriber', async () => {
  const { upstream, subscribe } = await relayGateway();
  const { result } = await subscribe();
  const relayed = upstream.only();
  const before = downstream.deliveries.length;
  const valid = upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z' });
  const forged = { ...relayed, secret: `whsec_${randomBytes(32).toString('base64')}` };
  expect((await upstream.post(forged, valid)).status).toBe(401);
  const stale = sign(relayed.secret, 'msg_stale', JSON.stringify(valid), Math.floor(Date.now() / 1000) - 600);
  expect((await upstream.post(relayed, valid, stale)).status).toBe(401);
  expect((await upstream.post(relayed, valid, { 'X-MCP-Subscription-Id': 'sub_someone_else' })).status).toBe(401);
  expect((await upstream.post(relayed, upstream.occurrence({ calendarId: 'primary', eventId: 'x', start: 's' }, 'other.event'))).status).toBe(400);
  expect((await upstream.post(relayed, upstream.occurrence({ ...valid.data, injected: true }))).status).toBe(400);
  expect(downstream.deliveries.length).toBe(before);
  expect(result!.id).toMatch(/^sub_/);
});

it('fails closed when policy revokes a relayed event, terminating downstream and unsubscribing upstream', async () => {
  const { upstream, gateway, subscribe } = await relayGateway();
  await subscribe();
  const relayed = upstream.only();
  const before = downstream.deliveries.length;
  await api(gateway, '/policies', 'POST', { name: 'Block calendar starts', capabilityPattern: startingEvent, action: 'deny' }, 201);
  const response = await upstream.post(relayed, upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z' }));
  expect([404, 410]).toContain(response.status);
  await vi.waitFor(() => expect(upstream.subscriptions.size).toBe(0), { timeout: 5000 });
  const sent = downstream.deliveries.slice(before).map(item => JSON.parse(item.body));
  expect(sent).toEqual([{ type: 'terminated', error: { code: -32023, message: 'NotFound' } }]);
  expect(await api(gateway, '/events/subscriptions')).toEqual({ subscriptions: [] });
});

it('returns 502 when the subscriber does not acknowledge so the upstream keeps retrying', async () => {
  const { upstream, subscribe } = await relayGateway();
  await subscribe();
  downstream.status = 500;
  const response = await upstream.post(upstream.only(), upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z' }));
  expect(response.status).toBe(502);
  expect(events(downstream.deliveries.map(item => JSON.parse(item.body)))).toHaveLength(1);
});

it('leaves no subscription or signing material behind when the upstream refuses the subscription', async () => {
  const { gateway, subscribe } = await relayGateway({ failSubscribe: true });
  const { error } = await subscribe();
  expect(error).toMatchObject({ data: { code: expect.any(String) } });
  expect(await api(gateway, '/events/subscriptions')).toEqual({ subscriptions: [] });
  expect((await api<{ secrets: SecretMetadata[] }>(gateway, '/secrets')).secrets.map(item => item.name)).toEqual(['calendar-bridge']);
});

it('hides webhook-only upstream events unless a dedicated ingress is configured, even behind an HTTPS public URL', async () => {
  const { upstream, mcp, subscribe } = await relayGateway({ ingress: false });
  const listed = await mcp.result<{ events: { name: string }[] }>('events/list');
  expect(listed.events.map(event => event.name)).not.toContain(startingEvent);
  const { error } = await subscribe();
  expect(error).toMatchObject({ code: -32023 });
  expect(upstream.subscriptions.size).toBe(0);
});

it('relays a captured delivery only once, so replays inside the signature window are acknowledged but not forwarded', async () => {
  const { upstream, subscribe } = await relayGateway();
  await subscribe();
  const relayed = upstream.only();
  const occurrence = upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z' });
  const headers = sign(relayed.secret, 'msg_captured', JSON.stringify(occurrence));
  expect((await upstream.post(relayed, occurrence, headers)).status).toBe(200);
  const forwarded = downstream.deliveries.length;
  expect((await upstream.post(relayed, occurrence, headers)).status).toBe(200);
  expect(downstream.deliveries.length).toBe(forwarded);
});

it('retries a delivery the subscriber rejected instead of treating it as a replay', async () => {
  const { upstream, subscribe } = await relayGateway();
  await subscribe();
  const relayed = upstream.only();
  const occurrence = upstream.occurrence({ calendarId: 'primary', eventId: 'abc', start: '2026-12-01T09:00:00Z' });
  downstream.status = 500;
  expect((await upstream.post(relayed, occurrence, { 'webhook-id': 'msg_retry' })).status).toBe(502);
  downstream.status = 200;
  expect((await upstream.post(relayed, occurrence, { 'webhook-id': 'msg_retry' })).status).toBe(200);
  expect(events(downstream.deliveries.map(item => JSON.parse(item.body)))).toHaveLength(2);
});

it('serves nothing but signed event ingress on the dedicated listener', async () => {
  const { gateway } = await relayGateway();
  const base = gateway.ingress!.url;
  for (const [method, path] of [['GET', '/'], ['GET', '/healthz'], ['POST', '/mcp'], ['GET', '/api/sources'], ['GET', '/.well-known/oauth-authorization-server'],
    ['POST', '/oauth/register'], ['GET', '/events/ingress/sub_00000000000000000000000000000000'], ['POST', '/events/ingress/../../api/sources']] as const) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${gateway.operatorToken}`, 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined });
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(await response.text()).toBe('');
  }
  const unknown = await fetch(base + '/events/ingress/sub_00000000000000000000000000000000', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  expect(unknown.status).toBe(404);
});

it('refuses to start relay ingress without a dedicated listener', async () => {
  await expect(startGateway({ ingressUrl })).rejects.toThrow(/dedicated ingress port/);
  await expect(startGateway({ ingressUrl: 'http://fabric.example.test', ingressPort: 0 })).rejects.toThrow(/bare HTTPS origin/);
});
