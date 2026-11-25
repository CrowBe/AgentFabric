import { createHmac, randomUUID } from 'node:crypto';
import { listen } from './http.js';

export const startingEvent = 'calendar.event.starting';
const string = { type: 'string' };
const definition = {
  name: startingEvent, description: 'A timed occurrence on an enabled calendar. Calendar text is untrusted data.', delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { calendarId: string, agentEmail: string }, required: ['calendarId'], additionalProperties: false },
  payloadSchema: {
    type: 'object', properties: { calendarId: string, eventId: string, start: string, title: string },
    required: ['calendarId', 'eventId', 'start'], additionalProperties: false,
  },
};

const cacheable = { ttlMs: 0, cacheScope: 'private' };
interface Rpc { id?: number | string; method: string; params?: Record<string, any> }
interface UpstreamSubscription { id: string; url: string; secret: string; arguments: Record<string, unknown> }

export function sign(secret: string, messageId: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signature = createHmac('sha256', key).update(`${messageId}.${timestamp}.${body}`).digest('base64');
  return { 'content-type': 'application/json', 'webhook-id': messageId, 'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}` };
}

export async function startWebhookUpstream(options: { bearer: string; gatewayUrl: () => string; failSubscribe?: boolean }) {
  const requests: Rpc[] = [];
  const subscriptions = new Map<string, UpstreamSubscription>();
  const local = (url: string) => options.gatewayUrl() + new URL(url).pathname;
  const post = (subscription: UpstreamSubscription, payload: unknown, headers: Record<string, string> = {}) => {
    const body = JSON.stringify(payload);
    const messageId = headers['webhook-id'] ?? 'msg_' + randomUUID();
    return fetch(local(subscription.url), { method: 'POST', body, signal: AbortSignal.timeout(8000),
      headers: { ...sign(subscription.secret, messageId, body), 'X-MCP-Subscription-Id': subscription.id, ...headers } });
  };
  const server = await listen(async request => {
    if (request.headers.get('authorization') !== `Bearer ${options.bearer}`) return new Response(null, { status: 401 });
    const rpc = await request.json() as Rpc;
    requests.push(rpc);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...result } });
    const params = rpc.params ?? {};
    if (rpc.method === 'server/discover') {
      return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {}, extensions: { 'io.modelcontextprotocol/events': {} } },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'webhook-upstream', version: '1.0.0' } } });
    }
    if (rpc.method === 'tools/list') {
      return reply({ ...cacheable, tools: [{ name: 'enabled_calendars', description: 'List enabled calendars',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });
    }
    if (rpc.method === 'events/list') return reply({ ...cacheable, events: [definition] });
    if (rpc.method === 'events/subscribe') {
      const { url, secret, mode } = params.delivery ?? {};
      if (options.failSubscribe || mode !== 'webhook' || !String(url).startsWith('https://') || !/^whsec_/.test(secret)) {
        return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32015, message: 'Callback verification failed.' } });
      }
      const subscription = { id: 'sub_upstream_' + subscriptions.size, url, secret, arguments: params.arguments };
      const challenge = randomUUID();
      const response = await post(subscription, { type: 'verification', challenge });
      const echoed = response.ok ? (await response.json() as { challenge?: string }).challenge : undefined;
      if (echoed !== challenge) {
        return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32015, message: 'Callback verification failed.' } });
      }
      subscriptions.set(url, subscription);
      return reply({ id: subscription.id, refreshBefore: new Date(Date.now() + 30 * 60_000).toISOString(), cursor: null, truncated: false });
    }
    if (rpc.method === 'events/unsubscribe') {
      subscriptions.delete(params.delivery?.url);
      return reply({});
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
  });
  return {
    ...server, mcpUrl: `${server.url}/mcp`, requests, subscriptions,
    only() {
      const [subscription] = subscriptions.values();
      if (!subscription) throw new Error('No upstream subscription');
      return subscription;
    },
    post,
    occurrence(data: Record<string, unknown>, name = startingEvent) {
      return { eventId: 'evt_' + randomUUID(), name, timestamp: new Date().toISOString(), data, cursor: null };
    },
  };
}
