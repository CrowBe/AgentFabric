import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { MemoryStorageAdapter, MemoryTraceStore } from '../../src/storage/memory.js';
import { InMemorySecretStore } from '../../src/storage/secrets.js';
import type { GatewayRuntime } from '../../src/types/index.js';
import { publicWebhookAddress } from '../../src/mcp/events.js';

const network = vi.hoisted(() => ({ deliveries: [] as { headers: Record<string, string>; body: string }[] }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [{ address: host === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }],
}));
vi.mock('node:https', () => ({
  request: (_url: URL, options: { headers: Record<string, string> }, receive: (response: EventEmitter & { statusCode: number }) => void) => {
    const request = new EventEmitter();
    return Object.assign(request, {
      end: (body: string) => queueMicrotask(() => {
        network.deliveries.push({ headers: options.headers, body });
        const payload = JSON.parse(body);
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        receive(response);
        response.emit('data', Buffer.from(payload.type === 'verification' ? JSON.stringify({ challenge: payload.challenge }) : '{}'));
        response.emit('end');
      }),
      destroy: (error: Error) => request.emit('error', error),
    });
  },
}));

const url = 'https://fabric.example';
const running: GatewayRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(runtime => runtime.close()));
  network.deliveries.length = 0;
});

async function start() {
  const storage = new MemoryStorageAdapter();
  const secrets = new InMemorySecretStore();
  const runtime = await createGatewayRuntime({
    mode: 'remote', publicUrl: url, homeDir: '/unused', storage, secrets, traceStore: new MemoryTraceStore(),
  });
  running.push(runtime);
  const { token } = await runtime.createToken({ profileId: 'default', label: 'one' });
  return { runtime, token, storage, secrets };
}
function rpc(runtime: GatewayRuntime, token: string, method: string, params: Record<string, unknown> = {}) {
  return runtime.handleMcpRequest(new Request(url + '/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 12, method, params }),
  }), null);
}

const name = 'fabric.proposal.created';

it('paginates from a cursor and filters foreign profile events', async () => {
  const { runtime, token } = await start();
  const initial = await (await rpc(runtime, token, 'events/poll', { name, cursor: null })).json();
  for (const [id, profileId] of [['one', 'default'], ['private', 'other'], ['two', 'default']]) {
    await runtime.emitEvent({ name, data: { id, profileId } });
  }
  const first = await (await rpc(runtime, token, 'events/poll', { name, cursor: initial.result.cursor, maxEvents: 1 })).json();
  expect(first.result).toMatchObject({ hasMore: true, events: [{ data: { id: 'one' } }] });
  const second = await (await rpc(runtime, token, 'events/poll', { name, cursor: first.result.cursor, maxEvents: 1 })).json();
  expect(second.result).toMatchObject({ hasMore: false, events: [{ data: { id: 'two' } }], nextPollMs: 2000 });
  const tail = await (await rpc(runtime, token, 'events/poll', { name, cursor: second.result.cursor })).json();
  expect(tail.result.events).toEqual([]);
});

it('replays push events with correlation and heartbeat cursors, and forwards catalog change signals', async () => {
  const { runtime, token } = await start();
  const { result } = await (await rpc(runtime, token, 'events/poll', { name })).json();
  await runtime.emitEvent({ name, data: { id: 'replay' } });
  const response = await rpc(runtime, token, 'events/stream', { name, cursor: result.cursor, heartbeatMs: 1000 });
  const reader = response.body!.getReader();
  async function frame() {
    const data = new TextDecoder().decode((await reader.read()).value);
    return JSON.parse(data.split('\n').find(line => line.startsWith('data: '))!.slice(6));
  }
  expect(await frame()).toMatchObject({ method: 'notifications/events/active', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 12 } } });
  expect(await frame()).toMatchObject({ method: 'notifications/events/event', params: { data: { id: 'replay' } } });
  expect(await frame()).toMatchObject({ method: 'notifications/events/heartbeat', params: { cursor: expect.any(String) } });
  await reader.cancel();
  const catalog = await rpc(runtime, token, 'subscriptions/listen', { notifications: { toolsListChanged: true, eventsListChanged: true } });
  const catalogReader = catalog.body!.getReader();
  expect(new TextDecoder().decode((await catalogReader.read()).value)).toContain('notifications/subscriptions/acknowledged');
  await runtime.emitEvent({ name: 'fabric.catalog.changed', data: {} });
  expect(new TextDecoder().decode((await catalogReader.read()).value)).toContain('notifications/tools/list_changed');
  expect(new TextDecoder().decode((await catalogReader.read()).value)).toContain('notifications/events/list_changed');
  await catalogReader.cancel();
});

it('verifies and signs webhook deliveries, keeps signing material in the vault, and binds subscriptions to their principal', async () => {
  const { runtime, token, storage, secrets } = await start();
  const key = Buffer.alloc(32, 2);
  const secret = 'whsec_' + key.toString('base64');
  const args = { name, delivery: { mode: 'webhook', url: 'https://hooks.example/callback', secret } };
  const subscribed = await (await rpc(runtime, token, 'events/subscribe', args)).json();
  const id = subscribed.result.id;
  expect(JSON.stringify(subscribed)).not.toContain(secret);
  expect(network.deliveries.map(delivery => JSON.parse(delivery.body).type)).toEqual(['verification']);
  const [stored] = await storage.listEventSubscriptions();
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect(await secrets.get(stored.secretName!)).toBe(secret);
  expect(await runtime.listEventSubscriptions()).toEqual([expect.not.objectContaining({ secretName: expect.anything() })]);
  await runtime.emitEvent({ name, data: { id: 'delivered' } });
  await vi.waitFor(() => expect(network.deliveries).toHaveLength(2), { timeout: 3500 });
  const { headers, body } = network.deliveries[1];
  const signature = createHmac('sha256', key).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
  expect(headers['webhook-signature']).toBe('v1,' + signature);
  expect(headers['X-MCP-Subscription-Id']).toBe(id);
  expect(JSON.parse(body)).toMatchObject({ name, data: { id: 'delivered' } });
  const another = await runtime.createToken({ label: 'two', profileId: 'default' });
  expect((await (await rpc(runtime, another.token, 'events/unsubscribe', { id })).json()).error.code).toBe(-32023);
  expect((await (await rpc(runtime, token, 'events/unsubscribe', { id })).json()).result.resultType).toBe('complete');
  expect(await secrets.get(stored.secretName!)).toBeNull();
});

it('rejects private and insecure callback URLs before any outbound HTTP request', async () => {
  const { runtime, token } = await start();
  const secret = 'whsec_' + Buffer.alloc(32).toString('base64');
  for (const endpoint of ['http://external.example/hook', 'https://private.example/hook']) {
    expect((await (await rpc(runtime, token, 'events/subscribe', {
      name, delivery: { mode: 'webhook', url: endpoint, secret },
    })).json()).error).toBeDefined();
  }
  expect(network.deliveries).toEqual([]);
  expect(publicWebhookAddress('::ffff:127.0.0.1', 6)).toBe(false);
  expect(publicWebhookAddress('169.254.169.254', 4)).toBe(false);
  expect(publicWebhookAddress('2606:4700::1111', 6)).toBe(true);
});
