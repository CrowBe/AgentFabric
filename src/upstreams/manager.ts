import { createHash } from 'node:crypto';
import { Client, type ElicitResult, type Transport } from '@modelcontextprotocol/client';
import { ElicitRequestParamsSchema, ElicitResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import type { UpstreamOAuthManager } from '../auth/upstream-oauth.js';
import type { Elicitation } from '../mcp/gateway.js';
import type * as T from '../types/index.js';
import { GatewayError } from '../types/index.js';
import { checkSecrets, executeCliWrapper, requireLocalCli } from './cli-wrapper.js';
import { executeComposite, validateComposite } from './composite.js';
import { fetchGitHubSkills } from './github-skills.js';
import { httpTransport } from './mcp-http.js';
import { stdioTransport } from './mcp-stdio.js';
import { checkShare, filePathSchema, listShare, readShare, sharePath, shareUri } from './shared-folders.js';
import { repoSkillCapabilities, skillCapabilities, skillMimeType } from './skills.js';

type Entry = Pick<T.CapabilityRecord, 'kind' | 'originalName' | 'description'> & Partial<T.CapabilityRecord>;
type Emit = (input: { name: string; sourceId?: string; data: Record<string, unknown> }) => Promise<unknown>;
const objectSchema = z.record(z.string(), z.unknown());
const modeSchema = z.array(z.enum(['poll', 'push', 'webhook'])).min(1);
const eventListSchema = z.object({
  events: z.array(z.object({
    name: z.string().min(1), description: z.string().optional(), inputSchema: objectSchema,
    payloadSchema: objectSchema, delivery: modeSchema.optional(), supportedModes: modeSchema.optional(),
  }).refine(event => event.delivery !== undefined || event.supportedModes !== undefined)),
  nextCursor: z.string().optional(),
});
const eventCursor = z.string().max(2048).nullable().default(null);
const eventPayload = z.object({
  eventId: z.string(), name: z.string(), timestamp: z.iso.datetime({ offset: true }),
  data: objectSchema, cursor: eventCursor,
});
const eventPollSchema = z.object({
  events: z.array(eventPayload), cursor: eventCursor,
  truncated: z.boolean().default(false), hasMore: z.boolean().default(false), nextPollMs: z.number().nonnegative().optional(),
});
const streamNotifications = {
  active: z.object({ cursor: eventCursor, truncated: z.boolean().default(false), heartbeatMs: z.int().positive() }),
  event: eventPayload,
  heartbeat: z.object({ cursor: eventCursor }),
  error: z.object({ error: z.object({ code: z.int() }) }),
  terminated: z.object({ error: z.object({ code: z.int() }) }),
};

type CallContext = Elicitation & { signal?: AbortSignal };
const decline: ElicitResult = { action: 'decline' };

function safeElicitationUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch { return false; }
}

function pausableDeadline(ms: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let paused = 0;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
    timer.unref();
  };
  arm();
  return {
    signal: controller.signal,
    async during<R>(work: () => Promise<R>) {
      if (paused++ === 0) clearTimeout(timer);
      try { return await work(); } finally { if (--paused === 0 && !controller.signal.aborted) arm(); }
    },
    clear: () => clearTimeout(timer),
  };
}

function catalogFingerprint(caps: T.CapabilityRecord[], events: T.McpEventTypeRecord[]) {
  return JSON.stringify([
    [...caps].sort((a, b) => a.id.localeCompare(b.id)).map(({ lastSeenAt: _seen, ...cap }) => cap),
    [...events].sort((a, b) => a.name.localeCompare(b.name)),
  ]);
}

export class UpstreamManager {
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly calls = new Map<string, Promise<void>>();
  private readonly elicitations = new WeakMap<Client, Elicitation>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private reconfiguring = false;

  constructor(
    private readonly storage: T.StorageAdapter, private readonly secrets: T.SecretStore,
    private readonly mode: T.GatewayMode, private readonly homeDir: string, private readonly emit: Emit,
    private readonly handoff: (source: T.SourceRecord, reason: string) => Promise<T.AuthHandoffInfo>,
    private readonly upstreamOAuth?: UpstreamOAuthManager,
  ) {}

  async source(id: string) {
    const source = await this.storage.getSource(id);
    if (!source) throw new GatewayError('NOT_FOUND', 'Source does not exist');
    return source;
  }

  private timeout(source: T.SourceRecord) {
    return 'timeoutMs' in source.config ? source.config.timeoutMs ?? 15_000 : 15_000;
  }

  private async newClient(source: T.SourceRecord) {
    const client = new Client({ name: 'AgentFabric', version: '0.1.0' }, {
      versionNegotiation: { mode: 'auto' },
      capabilities: { elicitation: { form: {}, url: {} }, extensions: { 'io.modelcontextprotocol/events': {} } },
    });
    client.setRequestHandler('elicitation/create', request => this.elicit(client, request.params));
    client.setNotificationHandler('notifications/elicitation/complete', notification => {
      this.elicitations.get(client)?.notifyElicitationComplete?.(this.secrets.redactValue(notification.params));
    });
    let transport: Transport | undefined;
    try {
      await checkSecrets(source, this.secrets);
      if (source.config.kind === 'mcp_stdio') transport = await stdioTransport({ ...source, config: source.config }, this.secrets);
      else if (source.config.kind === 'mcp_http') transport = await httpTransport({ ...source, config: source.config }, this.secrets, this.upstreamOAuth);
      else throw new GatewayError('UPSTREAM_ERROR', 'Source is not an MCP adapter');
      const timeout = this.timeout(source);
      await client.connect(transport, { timeout, signal: AbortSignal.timeout(timeout) });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      await transport?.close().catch(() => {});
      throw error;
    }
  }

  private client(source: T.SourceRecord) {
    const existing = this.clients.get(source.id);
    if (existing) return existing;
    const pending = this.newClient(source);
    this.clients.set(source.id, pending);
    const clear = () => { if (this.clients.get(source.id) === pending) this.clients.delete(source.id); };
    void pending.then(client => {
      client.onclose = () => {
        if (this.clients.get(source.id) !== pending) return;
        clear();
        void this.markHealth(source, 'degraded', 'Upstream connection closed').catch(() => {});
      };
    }, clear);
    return pending;
  }

  private async disconnect(id: string) {
    const pending = this.clients.get(id);
    this.clients.delete(id);
    if (pending) await pending.then(client => client.close()).catch(() => {});
  }

  private async markHealth(source: T.SourceRecord, health: T.SourceHealthStatus, lastError?: string) {
    const current = await this.storage.getSource(source.id);
    if (!current || current.updatedAt !== source.updatedAt || current.health === 'disabled' || !current.enabled) return;
    const updated = { ...current, health, lastError };
    await this.storage.upsertSource(updated);
    if (current.health !== health) await this.emit({
      name: 'fabric.source.health_changed', sourceId: source.id,
      data: { sourceId: source.id, previousHealth: current.health, health },
    }).catch(() => {});
  }

  private async upstreamError(source: T.SourceRecord, error: unknown) {
    const err = error as { code?: unknown; status?: unknown; name?: unknown; message?: string; cause?: unknown } | undefined;
    const auth = [err?.status, err?.code].some(code => code === 401 || code === 403 || code === 'AUTH_REQUIRED')
      || err?.name === 'UnauthorizedError';
    const cause = err?.cause instanceof GatewayError && err.cause.code === 'AUTH_REQUIRED';
    if (auth || cause) {
      const reason = 'Upstream credentials are required or were rejected';
      await this.markHealth(source, 'auth_required', reason);
      await this.disconnect(source.id);
      return new GatewayError('AUTH_REQUIRED', reason, { authHandoff: await this.handoff(source, reason) });
    }
    if (error instanceof GatewayError && !['UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT', 'UPSTREAM_UNAVAILABLE'].includes(error.code)) return error;
    const timedOut = err?.code === 'UPSTREAM_TIMEOUT' || err?.code === -32001 || err?.name === 'TimeoutError'
      || /timed?\s*out|timeout|deadline/i.test(err?.message ?? '');
    const message = timedOut
      ? 'Upstream operation timed out'
      : source.kind === 'skill_repo' && error instanceof GatewayError && error.code === 'UPSTREAM_ERROR'
        ? this.secrets.redact(error.message)
        : 'Upstream operation failed';
    await this.markHealth(source, 'degraded', message).catch(() => {});
    await this.disconnect(source.id);
    return new GatewayError(timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', message);
  }

  private async discover(source: T.SourceRecord) {
    const config = source.config;
    const capabilities: Entry[] = [];
    const eventTypes: T.McpEventTypeRecord[] = [];
    if (!source.enabled) return { capabilities, eventTypes };
    if (config.kind === 'cli_wrapper' || config.kind === 'mcp_stdio') requireLocalCli(this.mode);
    await checkSecrets(source, this.secrets);
    if (config.kind === 'mcp_stdio' || config.kind === 'mcp_http') {
      const client = await this.client(source);
      const advertised = client.getServerCapabilities();
      const options = { timeout: this.timeout(source), cacheMode: 'refresh' as const };
      const [tools, prompts, resources, templates] = await Promise.all([
        advertised?.tools ? client.listTools(undefined, options) : undefined,
        advertised?.prompts ? client.listPrompts(undefined, options) : undefined,
        advertised?.resources ? client.listResources(undefined, options) : undefined,
        advertised?.resources ? client.listResourceTemplates(undefined, options).catch(error => {
          if (error?.code !== -32601) throw error;
          return undefined;
        }) : undefined,
      ]);
      for (const tool of tools?.tools ?? []) capabilities.push({
        kind: 'tool', originalName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
      });
      for (const prompt of prompts?.prompts ?? []) capabilities.push({
        kind: 'prompt', originalName: prompt.name, description: prompt.description ?? '', promptArguments: prompt.arguments,
        inputSchema: {
          type: 'object', properties: Object.fromEntries((prompt.arguments ?? []).map(arg => [arg.name, {
            type: 'string', description: arg.description,
          }])), required: (prompt.arguments ?? []).filter(arg => arg.required).map(arg => arg.name),
        },
      });
      for (const resource of resources?.resources ?? []) capabilities.push({
        kind: 'resource', originalName: resource.name, description: resource.description ?? '', uri: resource.uri, mimeType: resource.mimeType,
      });
      for (const resource of templates?.resourceTemplates ?? []) capabilities.push({
        kind: 'resource', originalName: resource.name, description: resource.description ?? '',
        uri: resource.uriTemplate, mimeType: resource.mimeType, metadata: { uriTemplate: resource.uriTemplate },
      });
      if (advertised?.extensions?.['io.modelcontextprotocol/events'] !== undefined || (advertised && 'events' in advertised)) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        const cursors = new Set<string>();
        do {
          const result = await client.request({ method: 'events/list', params: { cursor } }, eventListSchema, options);
          for (const event of result.events) {
            if (seen.has(event.name)) throw new GatewayError('UPSTREAM_ERROR', 'Upstream returned a duplicate event type');
            seen.add(event.name);
            eventTypes.push({
              name: event.name, sourceId: source.id, description: event.description ?? '',
              inputSchema: event.inputSchema, payloadSchema: event.payloadSchema, supportedModes: event.delivery ?? event.supportedModes!,
            });
          }
          cursor = result.nextCursor;
          if (cursor) {
            if (cursors.has(cursor) || cursors.size >= 100) throw new GatewayError('UPSTREAM_ERROR', 'Upstream event pagination stalled');
            cursors.add(cursor);
          }
          if (seen.size > 10000) throw new GatewayError('UPSTREAM_ERROR', 'Upstream event catalog exceeds the discovery limit');
        } while (cursor);
      }
    } else if (config.kind === 'skill') {
      capabilities.push(...skillCapabilities(config));
    } else if (config.kind === 'skill_repo') {
      const bearerToken = source.authConfig.kind === 'bearer_secret' && source.authConfig.secretName
        ? await this.secrets.get(source.authConfig.secretName)
        : undefined;
      const skills = await fetchGitHubSkills(config, { ...(bearerToken ? { bearerToken } : {}) });
      for (const skill of skills) {
        capabilities.push(...repoSkillCapabilities(skill, {
          url: config.url,
          ...(config.ref ? { ref: config.ref } : {}),
          ...(config.path ? { path: config.path } : {}),
        }));
      }
    } else if (config.kind === 'shared_folder') {
      await checkShare(config);
      capabilities.push(
        { kind: 'resource', originalName: config.shareName, description: config.description ?? 'Shared workspace',
          uri: shareUri(config), metadata: { uriTemplate: shareUri(config) + '{+path}', share: true } },
        { kind: 'tool', originalName: config.shareName + '_list', description: 'List a shared directory',
          inputSchema: { ...filePathSchema, required: [] } },
        { kind: 'tool', originalName: config.shareName + '_read', description: 'Read a shared file', inputSchema: filePathSchema },
      );
    } else {
      if (config.kind === 'composite') validateComposite(config);
      else await executeCliWrapper({ ...source, config }, null, this.mode, this.secrets);
      capabilities.push({ kind: 'tool', originalName: config.toolName, description: config.description, inputSchema: config.inputSchema });
    }
    return { capabilities, eventTypes };
  }

  private async exclusive<R>(id: string, signal: AbortSignal | undefined, fn: () => Promise<R>) {
    const previous = this.calls.get(id) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => turn);
    this.calls.set(id, tail);
    try {
      if (signal) {
        let onAbort: (() => void) | undefined;
        await Promise.race([previous, new Promise<never>((_, reject) => {
          onAbort = () => reject(new GatewayError('UPSTREAM_UNAVAILABLE', 'Caller cancelled before execution'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })]).finally(() => signal.removeEventListener('abort', onAbort!));
      } else await previous;
      return await fn();
    } finally {
      release();
      void tail.then(() => { if (this.calls.get(id) === tail) this.calls.delete(id); });
    }
  }

  private async elicit(client: Client, raw: unknown): Promise<ElicitResult> {
    const caller = this.elicitations.get(client);
    const parsed = ElicitRequestParamsSchema.safeParse(raw);
    if (!caller?.elicit || !parsed.success) return decline;
    const { _meta: _upstreamMeta, task: _task, ...params } = this.secrets.redactValue(parsed.data);
    if (params.mode === 'url' && !safeElicitationUrl(params.url)) return decline;
    const answer = ElicitResultSchema.safeParse(await caller.elicit(params).catch(() => undefined));
    if (!answer.success) return { action: 'cancel' };
    const { action, content } = answer.data;
    return action === 'accept' && content ? { action, content } : { action };
  }

  private serial<T>(id: string, fn: () => Promise<T>) {
    if (this.closed || this.reconfiguring) {
      return Promise.reject(new GatewayError('UPSTREAM_UNAVAILABLE', 'Gateway source configuration is unavailable'));
    }
    const previous = this.work.get(id);
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(fn);
    this.work.set(id, current);
    return current.finally(() => { if (this.work.get(id) === current) this.work.delete(id); });
  }

  refresh(id: string) {
    return this.serial(id, async () => {
      const source = await this.source(id);
      try {
        await this.disconnect(id);
        const discovered = await this.discover(source);
        const timestamp = new Date().toISOString();
        const capabilities = discovered.capabilities.map(entry => ({
          ...entry,
          id: createHash('sha256').update(JSON.stringify([id, entry.kind, entry.uri ?? entry.originalName])).digest('hex'),
          sourceId: id, available: true, lastSeenAt: timestamp,
        }));
        if (new Set(capabilities.map(cap => cap.id)).size !== capabilities.length) {
          throw new GatewayError('UPSTREAM_ERROR', 'Upstream returned duplicate capability identifiers');
        }
        const [oldCaps, allEvents] = await Promise.all([this.storage.listCapabilities(id), this.storage.listEventTypes()]);
        const oldEvents = allEvents.filter(event => event.sourceId === id);
        await this.storage.replaceSourceCapabilities(id, capabilities);
        if (JSON.stringify([...oldEvents].sort((a, b) => a.name.localeCompare(b.name))) !==
          JSON.stringify([...discovered.eventTypes].sort((a, b) => a.name.localeCompare(b.name)))) {
          await this.storage.deleteEventTypesBySource(id);
          for (const event of discovered.eventTypes) await this.storage.upsertEventType(event);
        }
        const health = source.enabled ? 'healthy' : 'disabled';
        await this.markHealth(source, health);
        const updated: T.SourceRecord = { ...source, health, lastError: undefined, lastRefreshedAt: timestamp };
        await this.storage.upsertSource(updated);
        if (catalogFingerprint(oldCaps, oldEvents) !== catalogFingerprint(capabilities, discovered.eventTypes)) {
          await this.emit({ name: 'fabric.catalog.changed', sourceId: id, data: { sourceId: id } }).catch(() => {});
        }
        return { source: updated, capabilities };
      } catch (error) {
        const normalized = await this.upstreamError(source, error);
        if (!['AUTH_REQUIRED', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT'].includes(normalized.code)) {
          await this.markHealth(source, 'error', this.secrets.redact(normalized.message));
        }
        throw normalized;
      }
    });
  }

  async reconfigure<R>(operation: () => Promise<R>) {
    if (this.closed || this.reconfiguring) throw new GatewayError('CONFLICT', 'Gateway configuration is being changed');
    this.reconfiguring = true;
    try {
      await Promise.allSettled(this.work.values());
      const result = await operation();
      await Promise.allSettled([...this.clients.keys()].map(id => this.disconnect(id)));
      for (const id of this.timers.keys()) this.unschedule(id);
      for (const source of await this.storage.listSources()) this.schedule(source);
      return result;
    } finally { this.reconfiguring = false; }
  }

  async refreshAll(sources: T.SourceRecord[]) { return Promise.allSettled(sources.map(source => this.refresh(source.id))); }

  schedule(source: T.SourceRecord) {
    clearInterval(this.timers.get(source.id));
    this.timers.delete(source.id);
    if (!source.enabled || source.refreshPolicy.mode !== 'interval') return;
    const ms = Math.max(1, Math.min(2_147_483_647, Math.ceil((source.refreshPolicy.intervalSeconds ?? 60) * 1000)));
    const timer = setInterval(() => {
      if (!this.work.has(source.id)) void this.refresh(source.id).catch(() => {});
    }, ms);
    timer.unref();
    this.timers.set(source.id, timer);
  }

  mutate(id: string, operation: () => Promise<void>) {
    return this.serial(id, async () => {
      try {
        await operation();
      } finally {
        await this.disconnect(id);
      }
    });
  }

  unschedule(id: string) {
    clearInterval(this.timers.get(id));
    this.timers.delete(id);
  }

  async invoke(
    source: T.SourceRecord, cap: T.CapabilityRecord, args: Record<string, unknown>,
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>, context: CallContext = {},
    beforeExecute?: () => Promise<void>,
  ): Promise<unknown> {
    if (this.closed || this.reconfiguring || !source.enabled) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source is unavailable');
    await this.assertUnchanged(source);
    if (source.config.kind === 'cli_wrapper' || source.config.kind === 'mcp_stdio') requireLocalCli(this.mode);
    if (source.config.kind !== 'mcp_http' && source.config.kind !== 'mcp_stdio') return this.execute(source, cap, args, call, context);
    return this.exclusive(source.id, context.signal, async () => {
      await this.assertUnchanged(source);
      await beforeExecute?.();
      return this.execute(source, cap, args, call, context);
    });
  }

  private async assertUnchanged(source: T.SourceRecord) {
    const current = await this.source(source.id);
    if (!current.enabled || current.updatedAt !== source.updatedAt || this.reconfiguring || this.closed) {
      throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source configuration changed before execution');
    }
  }

  private async execute(
    source: T.SourceRecord, cap: T.CapabilityRecord, args: Record<string, unknown>,
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>, context: CallContext,
  ): Promise<unknown> {
    const config = source.config;
    try {
      await checkSecrets(source, this.secrets);
      if (config.kind === 'cli_wrapper') return await executeCliWrapper({ ...source, config }, args, this.mode, this.secrets);
      if (config.kind === 'composite') return await executeComposite(config, args, call);
      if (config.kind === 'skill') {
        return cap.kind === 'prompt'
          ? { description: config.description, messages: [{ role: 'user', content: { type: 'text', text: config.content } }] }
          : { contents: [{ uri: cap.uri, mimeType: 'text/markdown', text: config.content }] };
      }
      if (config.kind === 'skill_repo') {
        const content = typeof cap.metadata?.skillContent === 'string' ? cap.metadata.skillContent : '';
        if (cap.kind === 'prompt') {
          return { description: cap.description, messages: [{ role: 'user', content: { type: 'text', text: content } }] };
        }
        const requestedUri = String(args.uri ?? cap.uri);
        if (requestedUri === cap.uri || requestedUri === `${cap.uri}/SKILL.md`) {
          return { contents: [{ uri: requestedUri, mimeType: 'text/markdown', text: content }] };
        }
        const files = (cap.metadata?.skillFiles ?? {}) as Record<string, string>;
        if (cap.uri && requestedUri.startsWith(`${cap.uri}/`)) {
          const relPath = requestedUri.slice(cap.uri.length + 1);
          if (Object.hasOwn(files, relPath)) {
            return { contents: [{ uri: requestedUri, mimeType: skillMimeType(relPath), text: files[relPath] }] };
          }
        }
        throw new GatewayError('CAPABILITY_NOT_FOUND', 'Skill file does not exist');
      }
      if (config.kind === 'shared_folder') {
        if (cap.kind === 'tool') return cap.originalName === config.shareName + '_list'
          ? await listShare(config, (args.path as string | undefined) ?? '', this.homeDir)
          : await readShare(config, args.path as string, this.homeDir);
        const uri = String(args.uri ?? cap.uri);
        const path = sharePath(config, uri);
        const contents = path ? await readShare(config, path, this.homeDir) : { mimeType: 'application/json', text: JSON.stringify(await listShare(config, '', this.homeDir)) };
        return { contents: [{ uri, ...contents }] };
      }
      return await this.callMcp(source, cap, args, context);
    } catch (error) {
      if (config.kind === 'composite' && error instanceof GatewayError && error.code !== 'AUTH_REQUIRED') throw error;
      if (config.kind === 'composite' && error instanceof GatewayError && error.authHandoff) throw error;
      throw await this.upstreamError(source, error);
    }
  }

  private async callMcp(source: T.SourceRecord, cap: T.CapabilityRecord, args: Record<string, unknown>, context: CallContext) {
    const client = await this.client(source);
    const deadline = pausableDeadline(this.timeout(source));
    const { elicit, notifyElicitationComplete } = context;
    this.elicitations.set(client, {
      elicit: elicit && (params => deadline.during(() => elicit(params))),
      notifyElicitationComplete,
    });
    const options = { timeout: 2_147_483_647, signal: deadline.signal };
    try {
      if (cap.kind === 'tool') return await client.callTool({ name: cap.originalName, arguments: args }, options);
      if (cap.kind === 'prompt') return await client.getPrompt({ name: cap.originalName, arguments: args as Record<string, string> }, options);
      return await client.readResource({ uri: String(args.uri ?? cap.uri) }, { ...options, cacheMode: 'bypass' });
    } catch (error) {
      throw deadline.signal.aborted ? new GatewayError('UPSTREAM_TIMEOUT', 'Upstream operation timed out') : error;
    } finally {
      deadline.clear();
      this.elicitations.delete(client);
    }
  }

  async pollEvent(event: T.McpEventTypeRecord, params: Record<string, unknown>) {
    const source = await this.source(event.sourceId);
    if (!source.enabled) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source is disabled');
    try {
      await checkSecrets(source, this.secrets);
      return await this.exclusive(source.id, undefined, async () => (await this.client(source))
        .request({ method: 'events/poll', params }, eventPollSchema, { timeout: this.timeout(source) }));
    } catch (error) { throw await this.upstreamError(source, error); }
  }

  async streamEvent(event: T.McpEventTypeRecord, params: Record<string, unknown>, signal: AbortSignal,
    notify: (method: string, params: Record<string, unknown>) => void) {
    const source = await this.source(event.sourceId);
    if (this.closed || this.reconfiguring || !source.enabled) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source is unavailable');
    let client: Client | undefined;
    let timer: NodeJS.Timeout | undefined;
    const liveness = new AbortController();
    const refreshTimer = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => liveness.abort(), delay);
      timer.unref();
    };
    try {
      client = await this.newClient(source);
      signal.throwIfAborted();
      let interval = 30_000;
      let activated = false;
      refreshTimer(this.timeout(source));
      for (const [method, schema] of Object.entries(streamNotifications)) {
        client.setNotificationHandler(`notifications/events/${method}`, { params: schema }, params => {
          if (method === 'active' && 'heartbeatMs' in params) {
            activated = true;
            interval = Math.max(1000, Math.min(120_000, params.heartbeatMs));
          }
          if (!activated && !['terminated', 'error'].includes(method)) return;
          refreshTimer(interval * 3);
          notify(method, params);
        });
      }
      await client.request({ method: 'events/stream', params }, z.object({}),
        { signal: AbortSignal.any([signal, liveness.signal]), timeout: 2_147_483_647 });
      if (!activated) throw new GatewayError('UPSTREAM_ERROR', 'Upstream did not acknowledge the event stream');
    } catch (error) {
      if (signal.aborted) return;
      if (liveness.signal.aborted) throw new GatewayError('UPSTREAM_TIMEOUT', 'Upstream event stream timed out');
      throw await this.upstreamError(source, error);
    } finally {
      clearTimeout(timer);
      await client?.close().catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    await Promise.allSettled(this.work.values());
    await Promise.allSettled([...this.clients.keys()].map(id => this.disconnect(id)));
  }
}
