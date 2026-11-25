import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList } from 'node:net';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { effectivePermissions } from '../governance/policy.js';
import { GatewayError } from '../types/index.js';
import type * as T from '../types/index.js';
import type { ClientIdentity } from '../auth/middleware.js';
import type { UpstreamManager } from '../upstreams/manager.js';
import { emptySchema, validateArguments } from '../validation/schema.js';

export const eventsExtension = 'io.modelcontextprotocol/events';
const definitions = {
  'fabric.source.health_changed': 'A gateway source changed health',
  'fabric.approval.requested': 'A gateway call requires an operator decision',
  'fabric.approval.decided': 'An operator decision was recorded or an approval expired',
  'fabric.proposal.created': 'An agent submitted a capability proposal',
  'fabric.catalog.changed': 'The gateway capability catalog changed',
};
export const deliveryModes = ['poll', 'push', 'webhook'] as const;
const payloadSchema = { type: 'object', additionalProperties: true };

const dataSchema = z.record(z.string(), z.unknown());
const subscriptionParams = {
  name: z.string().min(1), arguments: dataSchema.default({}), cursor: z.string().max(2048).nullable().optional(),
  maxAgeMs: z.int().nonnegative().optional(), _meta: dataSchema.optional(),
};
const pollParams = z.strictObject({ ...subscriptionParams, maxEvents: z.int().min(1).max(1000).default(100) });
const streamParams = z.strictObject({ ...subscriptionParams, heartbeatMs: z.int().positive().optional() });
const deliveryParams = z.strictObject({
  mode: z.enum(deliveryModes).default('webhook'),
  url: z.string().max(2048).optional(), secret: z.string().max(100).optional(),
});
const subscribeParams = z.strictObject({
  ...subscriptionParams, delivery: deliveryParams.optional(), ttlMs: z.int().positive().nullable().optional(),
  mode: z.enum(deliveryModes).optional(), callbackUrl: z.string().max(2048).optional(), signingSecret: z.string().max(100).optional(),
});
const unsubscribeParams = z.strictObject({
  id: z.string().optional(), subscriptionId: z.string().optional(), name: z.string().optional(),
  arguments: dataSchema.default({}),
  delivery: z.strictObject({ url: z.string().max(2048), mode: z.literal('webhook').optional() }).optional(), _meta: dataSchema.optional(),
});

type Subscription = T.McpEventSubscriptionRecord & { principal: string; sourceId: string };
type PublicEvent = Omit<T.McpEventOccurrence, 'sourceId' | 'cursor'> & { cursor: string | null };
type PollPage = { events: PublicEvent[]; cursor: string | null; hasMore: boolean; truncated: boolean; nextPollMs: number };
type StreamSend = (message: Record<string, unknown>, cursor?: string) => boolean;
const seqPerMs = 1024;
const complete = { resultType: 'complete' };

function input<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const result = schema.safeParse(params);
  if (!result.success) throw new GatewayError('INVALID_INPUT', 'Invalid event request parameters', {
    details: { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) },
  });
  return result.data;
}

export function eventProtocolError(code: number, message: string, data: Record<string, unknown>) {
  return new GatewayError(code === -32024 ? 'FORBIDDEN' : code === -32023 ? 'NOT_FOUND' : 'INVALID_INPUT',
    message, { details: { rpcCode: code, ...data } });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, member]) => JSON.stringify(key) + ':' + canonical(member)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function subscriptionId(identity: ClientIdentity, name: string, args: Record<string, unknown>, url: string) {
  return 'sub_' + createHash('sha256').update(canonical([identity.principal, identity.profile.id, url, name, args])).digest('hex').slice(0, 32);
}

function callback(value: string | undefined) {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new GatewayError('INVALID_INPUT', 'Webhook callback requires an HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new GatewayError('INVALID_INPUT', 'Invalid webhook callback URL');
  return url;
}

const privateAddresses = new BlockList();
for (const [host, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) privateAddresses.addSubnet(host, prefix);
for (const [host, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  privateAddresses.addSubnet(host, prefix, 'ipv6');
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

export function publicWebhookAddress(address: string, family: number) {
  return family === 6 ? globalIpv6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6')
    : family === 4 && !privateAddresses.check(address);
}

function signingKey(secret: string | undefined) {
  if (!secret?.startsWith('whsec_')) throw new GatewayError('INVALID_INPUT', 'Expected a Standard Webhooks signing secret');
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) {
    throw new GatewayError('INVALID_INPUT', 'Invalid webhook signing secret');
  }
  return key;
}

export function webhookHeaders(id: string, key: Buffer, messageId: string, timestamp: string, body: string) {
  const signature = createHmac('sha256', key).update(`${messageId}.${timestamp}.${body}`).digest('base64');
  return { 'Content-Type': 'application/json', 'webhook-id': messageId, 'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`, 'X-MCP-Subscription-Id': id };
}

async function deliver(url: URL, id: string, key: Buffer, messageId: string, payload: unknown) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => !publicWebhookAddress(address, family))) {
    throw new GatewayError('INVALID_INPUT', 'Webhook callback must resolve to public IP addresses');
  }
  const selected = addresses[0];
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST', agent: false, family: selected.family, signal: AbortSignal.timeout(5000),
      lookup: (_hostname, options, found) => {
        if (options.all) found(null, [selected]);
        else found(null, selected.address, selected.family);
      },
      headers: { ...webhookHeaders(id, key, messageId, timestamp, body), 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) request.destroy(new Error('Webhook response exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

export class Events {
  private readonly bus = new EventEmitter().setMaxListeners(0);
  private readonly webhookWork = new Map<string, Promise<void>>();
  private readonly changes = new Map<string, Promise<unknown>>();
  private readonly verified = new Map<string, number>();
  private readonly verificationAttempts = new Map<string, number>();
  private readonly verificationWork = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly messages = new Map<string, { cursor: string | null; id: string }>();
  private readonly timer: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private head = Date.now() * seqPerMs;
  private closed = false;

  constructor(private readonly storage: T.StorageAdapter, private readonly secrets: T.SecretStore,
    private readonly upstream: Pick<UpstreamManager, 'pollEvent' | 'streamEvent'>) {
    this.timer = setInterval(() => { void this.drainWebhooks().catch(() => {}); }, 2000);
    this.timer.unref();
  }

  async initialize() {
    await Promise.all(Object.entries(definitions).map(([name, description]) => this.storage.upsertEventType({
      name, description, sourceId: 'gateway', inputSchema: emptySchema, payloadSchema, supportedModes: [...deliveryModes],
    })));
    for (;;) {
      const tail = await this.storage.listEventOccurrences({ afterCursor: String(this.head), limit: 1000 });
      if (!tail.length) break;
      this.head = Number(tail.at(-1)!.cursor);
    }
  }

  onChange(listener: (event: T.McpEventOccurrence) => void) {
    this.bus.on('event', listener);
    return () => { this.bus.off('event', listener); };
  }

  async identityActive(identity: ClientIdentity) {
    if (identity.expiry !== undefined && Date.now() >= identity.expiry) return false;
    const token = (await this.storage.listClientTokens()).find(record => record.id === identity.principal);
    return !!token && !token.revokedAt && token.profileId === identity.profile.id && token.scopes.includes('mcp');
  }

  async listTypes(profileId?: string) {
    if (!profileId) return this.storage.listEventTypes();
    return (await this.profileTypes(profileId)).map(({ originalName: _name, ...type }) => type);
  }

  private async profileTypes(profileId: string) {
    const types = await this.storage.listEventTypes();
    const [profile, sources, policies] = await Promise.all([
      this.storage.getProfile(profileId), this.storage.listSources(), this.storage.listPolicies(),
    ]);
    if (!profile || profile.id !== profileId) return [];
    const byId = new Map(sources.map(source => [source.id, source]));
    const visible = types.filter(type => {
      const source = byId.get(type.sourceId);
      const gateway = type.sourceId === 'gateway';
      if (!gateway && (!source?.enabled || source.health !== 'healthy'
        || !type.supportedModes.some(mode => mode === 'poll' || mode === 'push'))) return false;
      const access = effectivePermissions(profile, policies, { id: type.name, originalName: type.name, exposedName: type.name,
        sourceId: type.sourceId, semanticGroup: source?.name ?? 'gateway' });
      return access.permission === 'allow' && access.exposure !== 'hidden';
    }).sort((a, b) => a.name.localeCompare(b.name) || (a.sourceId === 'gateway' ? -1 : b.sourceId === 'gateway' ? 1 : a.sourceId.localeCompare(b.sourceId)));
    const natural = new Set(visible.map(type => type.name));
    const used = new Set<string>();
    return visible.map(type => {
      let name = type.name;
      if (used.has(name)) {
        const base = `${type.sourceId}.${name}`;
        let suffix = 2;
        name = base;
        while (used.has(name) || natural.has(name)) name = `${base}.${suffix++}`;
      }
      used.add(name);
      return {
        ...type, name, originalName: type.name,
        supportedModes: type.sourceId === 'gateway' ? type.supportedModes : type.supportedModes.filter(mode => mode === 'poll' || mode === 'push'),
      };
    });
  }

  private async visible(profileId: string, event: T.McpEventOccurrence) {
    if (typeof event.data.profileId === 'string' && event.data.profileId !== profileId) return false;
    if (event.sourceId === 'gateway') return true;
    const [source, profile, policies] = await Promise.all([
      this.storage.getSource(event.sourceId), this.storage.getProfile(profileId), this.storage.listPolicies(),
    ]);
    if (!profile || profile.id !== profileId) return false;
    const access = effectivePermissions(profile, policies, {
      id: event.name, sourceId: event.sourceId, semanticGroup: source?.name ?? '',
      originalName: event.name, exposedName: event.name,
    });
    return access.permission === 'allow' && access.exposure !== 'hidden';
  }

  async canSee(profileId: string, event: T.McpEventOccurrence) { return this.visible(profileId, event); }

  emit(event: { name: string; sourceId?: string; data: Record<string, unknown> }) {
    if (this.closed) return Promise.reject(new GatewayError('UPSTREAM_UNAVAILABLE', 'Event service is closed'));
    const operation = this.queue.then(async () => {
      const sourceId = event.sourceId ?? 'gateway';
      const type = (await this.storage.listEventTypes()).find(item =>
        item.name === event.name && (item.sourceId === sourceId || item.sourceId === 'gateway'));
      if (!type) throw new GatewayError('NOT_FOUND', 'Unknown event type');
      const data = this.secrets.redactValue(event.data);
      validateArguments(type.payloadSchema, data);
      const next = Math.max(this.head + 1, Date.now() * seqPerMs);
      const occurrence: T.McpEventOccurrence = { eventId: randomUUID(), name: event.name, sourceId,
        timestamp: new Date().toISOString(), data, cursor: String(next) };
      await this.storage.appendEventOccurrence(occurrence);
      this.head = next;
      this.bus.emit('event', occurrence);
      void this.drainWebhooks().catch(() => {});
      return occurrence;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async target(profileId: string, name: string, args: Record<string, unknown>, mode: T.McpEventDeliveryMode) {
    const event = (await this.profileTypes(profileId)).find(type => type.name === name);
    if (!event) throw eventProtocolError(-32023, 'NotFound', { kind: 'event' });
    if (!event.supportedModes.includes(mode)) throw eventProtocolError(-32026, 'Unsupported', { feature: 'deliveryMode', value: mode });
    validateArguments(event.inputSchema, args);
    return event;
  }

  private initial(cursor: string | null | undefined, maxAgeMs?: number) {
    if (cursor == null) return { cursor: String(this.head), truncated: false };
    if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > this.head) {
      throw new GatewayError('INVALID_INPUT', 'Invalid event cursor');
    }
    const floor = maxAgeMs === undefined ? 0 : Math.min(this.head, Math.max(0, Date.now() - maxAgeMs) * seqPerMs);
    return { cursor: String(Math.max(Number(cursor), floor)), truncated: Number(cursor) < floor };
  }

  private async page(profileId: string, name: string, cursor: string, maxEvents: number): Promise<PollPage> {
    const head = this.head;
    const events: PublicEvent[] = [];
    let watermark = cursor;
    for (;;) {
      const candidates = await this.storage.listEventOccurrences({ name, afterCursor: watermark, limit: 200 });
      for (const occurrence of candidates) {
        if (Number(occurrence.cursor) > head) break;
        if (await this.visible(profileId, occurrence)) {
          if (events.length === maxEvents) return { events, cursor: watermark, hasMore: true, truncated: false, nextPollMs: 2000 };
          const { sourceId: _sourceId, ...payload } = occurrence;
          events.push(payload);
        }
        watermark = occurrence.cursor;
      }
      if (candidates.length < 200 || Number(candidates.at(-1)?.cursor) >= head) break;
    }
    return { events, cursor: String(head), hasMore: false, truncated: false, nextPollMs: 2000 };
  }

  async poll(identity: ClientIdentity, params: unknown) {
    const request = input(pollParams, params);
    const target = await this.target(identity.profile.id, request.name, request.arguments, 'poll');
    if (target.sourceId !== 'gateway') {
      const { _meta: _clientMeta, ...poll } = request;
      const upstream = { ...target, name: target.originalName };
      const result = await this.upstream.pollEvent(upstream, { ...poll, name: upstream.name });
      for (const event of result.events) {
        if (event.name !== upstream.name) throw new GatewayError('UPSTREAM_ERROR', 'Upstream returned a foreign event');
        validateArguments(upstream.payloadSchema, event.data);
      }
      return this.secrets.redactValue({ ...complete, ...result, nextPollMs: Math.max(1000, result.nextPollMs ?? 2000),
        events: result.events.map(event => ({ ...event, name: target.name })) });
    }
    const initial = this.initial(request.cursor, request.maxAgeMs);
    const page = await this.page(identity.profile.id, request.name, initial.cursor, request.maxEvents);
    return { ...complete, ...page, truncated: initial.truncated };
  }

  async openStream(identity: ClientIdentity, params: unknown, id: string | number) {
    const request = input(streamParams, params);
    const type = await this.target(identity.profile.id, request.name, request.arguments, 'push');
    const metadata = { 'io.modelcontextprotocol/subscriptionId': id };
    const notification = (method: string, params: Record<string, unknown>) => ({
      jsonrpc: '2.0', method: `notifications/events/${method}`, params: { ...params, _meta: metadata },
    });
    if (type.sourceId !== 'gateway') {
      return (send: StreamSend, close: () => void) => {
        const controller = new AbortController();
        const { _meta: _clientMeta, ...stream } = request;
        const upstream = { ...type, name: type.originalName };
        let queue = Promise.resolve();
        let terminated = false;
        const terminate = (code: number, message: string) => {
          if (terminated || controller.signal.aborted) return;
          terminated = true;
          send(notification('terminated', { error: { code, message } }));
          send({ jsonrpc: '2.0', id, result: { ...complete, _meta: metadata } });
          close();
        };
        const check = async () => {
          if (!(await this.identityActive(identity))) throw new GatewayError('FORBIDDEN', 'Access revoked');
          const current = await this.target(identity.profile.id, request.name, request.arguments, 'push');
          if (current.sourceId !== upstream.sourceId || current.originalName !== upstream.name) {
            throw new GatewayError('NOT_FOUND', 'Upstream event changed');
          }
        };
        const timer = setInterval(() => { void check().catch(() => terminate(-32024, 'Access revoked')); }, 2000);
        timer.unref();
        void this.upstream.streamEvent(upstream, { ...stream, name: upstream.name }, controller.signal, (method, params) => {
          queue = queue.then(async () => {
            if (controller.signal.aborted) return;
            await check();
            if (method === 'event') {
              if (params.name !== upstream.name) throw new GatewayError('UPSTREAM_ERROR', 'Upstream returned a foreign event');
              validateArguments(upstream.payloadSchema, params.data);
              send(notification('event', this.secrets.redactValue({ ...params, name: type.name })));
            } else if (method === 'error') {
              send(notification('error', { error: { code: -32603, message: 'Upstream event delivery failed' } }));
            } else if (method === 'terminated') {
              terminate(-32603, 'Upstream event stream ended');
            } else {
              send(notification(method, this.secrets.redactValue(params)));
            }
          }).catch(() => terminate(-32024, 'Event stream is unavailable'));
        }).then(async () => {
          await queue;
          if (!controller.signal.aborted) {
            send({ jsonrpc: '2.0', id, result: { ...complete, _meta: metadata } });
            close();
          }
        }, () => terminate(-32603, 'Upstream event stream failed'));
        return () => { clearInterval(timer); controller.abort(); };
      };
    }
    const initial = this.initial(request.cursor, request.maxAgeMs);
    const heartbeatMs = Math.min(60_000, Math.max(1000, request.heartbeatMs ?? 30_000));
    return (send: StreamSend, close: () => void) => {
      let cursor = initial.cursor;
      let closed = false;
      let working = false;
      let dirty = false;
      let heartbeat = false;
      const drain = async () => {
        if (working || closed) return;
        working = true;
        try {
          do {
            dirty = false;
            if (!(await this.identityActive(identity))) throw new GatewayError('FORBIDDEN', 'Access revoked');
            await this.target(identity.profile.id, request.name, request.arguments, 'push');
            let page: PollPage;
            do {
              page = await this.page(identity.profile.id, request.name, cursor, 100);
              for (const event of page.events) if (!closed) send(notification('event', event), event.cursor ?? undefined);
              cursor = page.cursor ?? cursor;
            } while (!closed && page.hasMore);
            if (heartbeat && !closed) {
              heartbeat = false;
              send(notification('heartbeat', { cursor }), cursor);
            }
          } while (dirty && !closed);
        } catch (error) {
          if (!closed) {
            const rpcCode = error instanceof GatewayError && error.code === 'FORBIDDEN' ? -32024 : -32023;
            send(notification('terminated', { error: { code: rpcCode, message: rpcCode === -32024 ? 'Forbidden' : 'NotFound' } }));
            send({ jsonrpc: '2.0', id, result: { ...complete, _meta: metadata } });
            close();
          }
        } finally { working = false; }
      };
      send(notification('active', { ...initial, heartbeatMs }), cursor);
      const unsubscribe = this.onChange(event => {
        if (event.name !== request.name && event.name !== 'fabric.catalog.changed') return;
        dirty = true;
        void drain();
      });
      const timer = setInterval(() => { heartbeat = true; dirty = true; void drain(); }, heartbeatMs);
      timer.unref();
      void drain();
      return () => { closed = true; clearInterval(timer); unsubscribe(); };
    };
  }

  private serial<T>(id: string, operation: () => Promise<T>) {
    const previous = this.changes.get(id);
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    this.changes.set(id, next);
    return next.finally(() => { if (this.changes.get(id) === next) this.changes.delete(id); });
  }

  private async verify(id: string, principal: string, url: URL, key: Buffer) {
    const cacheKey = JSON.stringify([principal, url.href]);
    const now = Date.now();
    for (const [item, until] of this.verified) if (until <= now) this.verified.delete(item);
    for (const [item, until] of this.verificationAttempts) if (until <= now) this.verificationAttempts.delete(item);
    if (this.verified.has(cacheKey)) return;
    const active = this.verificationWork.get(cacheKey);
    if (active) return active;
    if (this.verificationAttempts.has(url.hostname)) throw eventProtocolError(-32027, 'CallbackEndpointError', { reason: 'challenge_failed' });
    this.verificationAttempts.set(url.hostname, now + 2000);
    const check = (async () => {
      try {
        const challenge = randomUUID();
        const response = await deliver(url, id, key, 'msg_verification_' + randomUUID(), { type: 'verification', challenge });
        const echoed = response.status >= 200 && response.status < 300 ? JSON.parse(response.body).challenge : undefined;
        if (typeof echoed !== 'string' || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge)
          || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw new Error('Challenge failed');
        this.verified.set(cacheKey, Date.now() + 60 * 60_000);
      } catch {
        throw eventProtocolError(-32027, 'CallbackEndpointError', { reason: 'challenge_failed' });
      }
    })();
    this.verificationWork.set(cacheKey, check);
    try { await check; } finally { this.verificationWork.delete(cacheKey); }
  }

  async subscribe(identity: ClientIdentity, params: unknown) {
    const request = input(subscribeParams, params);
    const mode = request.delivery?.mode ?? request.mode ?? 'webhook';
    const type = await this.target(identity.profile.id, request.name, request.arguments, mode);
    const uri = mode === 'webhook' ? callback(request.delivery?.url ?? request.callbackUrl) : undefined;
    const rawSecret = request.delivery?.secret ?? request.signingSecret;
    const key = uri ? signingKey(rawSecret) : undefined;
    const id = subscriptionId(identity, request.name, request.arguments, uri?.href ?? mode);
    const subscription = await this.serial(id, async () => {
      if (uri && key) await this.verify(id, identity.principal, uri, key);
      const existing = await this.storage.getEventSubscription(id);
      const ttlMs = Math.min(request.ttlMs ?? 60 * 60_000, 60 * 60_000);
      const now = Date.now();
      const expiresAt = new Date(now + ttlMs).toISOString();
      const live = existing && Date.parse(existing.expiresAt) > now;
      const initial = live ? { cursor: existing.cursor ?? String(this.head), truncated: false }
        : this.initial(request.cursor, request.maxAgeMs);
      const secretName = uri ? `webhook:${id}:${randomUUID()}` : undefined;
      const record: Subscription = {
        id, profileId: identity.profile.id, principal: identity.principal, sourceId: type.sourceId, name: request.name,
        arguments: request.arguments, mode, callbackUrl: uri?.href, secretName, cursor: initial.cursor,
        ttlMs, expiresAt, refreshBefore: expiresAt, createdAt: live ? existing.createdAt : new Date(now).toISOString(),
      };
      if (secretName) await this.secrets.set(secretName, rawSecret!);
      try { await this.storage.upsertEventSubscription(record); }
      catch (error) { if (secretName) await this.secrets.delete(secretName).catch(() => {}); throw error; }
      if (existing?.secretName) await this.secrets.delete(existing.secretName).catch(() => {});
      return { ...complete, id, subscriptionId: id, refreshBefore: expiresAt, expiresAt, ...initial };
    });
    if (uri) void this.drainWebhooks().catch(() => {});
    return subscription;
  }

  async unsubscribe(identity: ClientIdentity, params: unknown) {
    const request = input(unsubscribeParams, params);
    const id = request.id ?? request.subscriptionId ?? (request.name && request.delivery
      ? subscriptionId(identity, request.name, request.arguments, callback(request.delivery.url).href) : undefined);
    if (!id) throw new GatewayError('INVALID_INPUT', 'Subscription identifier is required');
    await this.serial(id, async () => {
      const record = await this.storage.getEventSubscription(id) as Subscription | null;
      if (!record || record.principal !== identity.principal || record.profileId !== identity.profile.id) {
        throw eventProtocolError(-32023, 'NotFound', { kind: 'subscription' });
      }
      await this.remove(record);
    });
    return complete;
  }

  private async remove(record: T.McpEventSubscriptionRecord) {
    await this.storage.deleteEventSubscription(record.id);
    if (record.secretName) await this.secrets.delete(record.secretName);
    this.retryAt.delete(record.id);
    this.messages.delete(record.id);
  }

  delete(id: string) {
    return this.serial(id, async () => {
      const record = await this.storage.getEventSubscription(id);
      if (!record) throw new GatewayError('NOT_FOUND', 'Subscription does not exist');
      await this.remove(record);
    });
  }

  async listSubscriptions(profileId?: string) {
    return (await this.storage.listEventSubscriptions(profileId)).filter(record => Date.parse(record.expiresAt) > Date.now())
      .map(({ id, profileId, name, arguments: args, mode, callbackUrl, cursor, ttlMs, refreshBefore, expiresAt, createdAt }) => ({
        id, profileId, name, arguments: args, mode, callbackUrl, cursor, ttlMs, refreshBefore, expiresAt, createdAt,
      }));
  }

  private async drainWebhooks() {
    if (this.closed) return;
    const all = await this.storage.listEventSubscriptions();
    for (const record of all) {
      if (this.closed || this.webhookWork.has(record.id) || (this.retryAt.get(record.id) ?? 0) > Date.now()) continue;
      if (record.mode !== 'webhook' && Date.parse(record.expiresAt) > Date.now()) continue;
      const task = this.serial(record.id, async () => {
        const current = await this.storage.getEventSubscription(record.id) as Subscription | null;
        if (!current) return;
        if (Date.parse(current.expiresAt) <= Date.now()) { await this.remove(current); return; }
        if (!current.callbackUrl || !current.secretName || this.closed) return;
        let termination: { code: number; message: string } | undefined;
        const profile = await this.storage.getProfile(current.profileId);
        if (!profile || profile.id !== current.profileId || !(await this.identityActive({ profile, principal: current.principal }))) {
          termination = { code: -32024, message: 'Forbidden' };
        } else {
          try { await this.target(current.profileId, current.name, current.arguments, 'webhook'); }
          catch (error) {
            if (!(error instanceof GatewayError)) throw error;
            termination = { code: -32023, message: 'NotFound' };
          }
        }
        if (termination) {
          try {
            const key = signingKey(await this.secrets.get(current.secretName) ?? undefined);
            await deliver(callback(current.callbackUrl), current.id, key, 'msg_terminated_' + randomUUID(),
              { type: 'terminated', error: termination });
          } catch {}
          await this.remove(current);
          return;
        }
        const currentCursor = current.cursor ?? String(this.head);
        const page = await this.page(current.profileId, current.name, currentCursor, 1);
        const event = page.events[0];
        if (event) {
          const key = signingKey(await this.secrets.get(current.secretName) ?? undefined);
          const pending = this.messages.get(current.id);
          const messageId = pending && pending.cursor === event.cursor ? pending.id : 'msg_' + randomUUID();
          this.messages.set(current.id, { cursor: event.cursor, id: messageId });
          const response = await deliver(callback(current.callbackUrl), current.id, key, messageId, { ...event, cursor: currentCursor });
          if (response.status < 200 || response.status >= 300) throw new Error('Webhook not acknowledged');
        }
        if (page.cursor !== current.cursor) await this.storage.upsertEventSubscription({ ...current, cursor: page.cursor ?? undefined });
        this.messages.delete(record.id);
        this.retryAt.delete(record.id);
      }).catch(() => { this.retryAt.set(record.id, Date.now() + 5000); });
      this.webhookWork.set(record.id, task);
      void task.finally(() => { if (this.webhookWork.get(record.id) === task) this.webhookWork.delete(record.id); });
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.queue;
    await Promise.allSettled([...this.webhookWork.values(), ...this.changes.values()]);
    this.bus.removeAllListeners();
  }
}
