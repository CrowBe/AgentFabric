import { randomUUID } from 'node:crypto';
import { UnsupportedProtocolVersionError } from '@modelcontextprotocol/server';
import { authenticateClient, challenge, type ClientIdentity } from '../auth/middleware.js';
import { GatewayError, type SecretStore, type StorageAdapter } from '../types/index.js';
import { capabilities, type McpGateway, serverInfo } from './gateway.js';

export const supportedProtocolVersions = ['2026-07-28', '2025-11-25', '2025-03-26'];
const latest = supportedProtocolVersions[0];
const protocolKey = 'io.modelcontextprotocol/protocolVersion';
const clientInfoKey = 'io.modelcontextprotocol/clientInfo';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const subscriptionIdKey = 'io.modelcontextprotocol/subscriptionId';
type RpcId = string | number;
type Send = (message: Record<string, unknown>, cursor?: string) => boolean;
type StreamSetup = (send: Send, close: () => void) => () => void;
type Session = {
  identity: ClientIdentity; version: string; clientName?: string; expires: number; streams: Set<() => void>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorBody(id: RpcId | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function notification(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', method: 'notifications/' + method, ...(params ? { params } : {}) };
}

const cacheable = new Set(['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read']);

function resultBody(id: RpcId, result: unknown, modern: boolean, method?: string) {
  const payload = isObject(result) ? result : {};
  return {
    jsonrpc: '2.0', id,
    result: modern ? { ...payload, ...(method && cacheable.has(method) ? { ttlMs: 0, cacheScope: 'private' } : {}),
      resultType: 'complete',
      _meta: { ...(isObject(payload._meta) ? payload._meta : {}), [serverInfoKey]: serverInfo } } : payload,
  };
}

function rpcGatewayError(id: RpcId | null, error: unknown, secrets: SecretStore) {
  if (!(error instanceof GatewayError)) return errorBody(id, -32603, 'Internal gateway error');
  const { rpcCode, ...details } = error.details ?? {};
  const code = typeof rpcCode === 'number' ? rpcCode :
    error.code === 'INVALID_INPUT' ? -32602 :
    error.code === 'FORBIDDEN' || error.code === 'CAPABILITY_DENIED' ? -32024 :
    error.code === 'CAPABILITY_NOT_FOUND' || error.code === 'NOT_FOUND' ? -32023 : -32000;
  return errorBody(id, code, secrets.redact(error.message), {
    ...secrets.redactValue(details), code: error.code, ...(error.authHandoff ? { authHandoff: error.authHandoff } : {}),
    ...(error.approval ? { approval: secrets.redactValue(error.approval) } : {}),
  });
}

function negotiate(...versions: unknown[]) {
  for (const version of versions) {
    if (version === undefined || version === null) continue;
    if (typeof version !== 'string' || !supportedProtocolVersions.includes(version)) {
      throw new UnsupportedProtocolVersionError({ supported: supportedProtocolVersions, requested: String(version) });
    }
  }
  const provided = versions.filter((version): version is string => typeof version === 'string');
  if (new Set(provided).size > 1) throw new GatewayError('INVALID_INPUT', 'Conflicting MCP protocol versions');
  return provided[0] ?? latest;
}

function catalogNotifications(filter: Record<string, unknown>) {
  return [
    ['toolsListChanged', 'tools/list_changed'], ['promptsListChanged', 'prompts/list_changed'],
    ['resourcesListChanged', 'resources/list_changed'], ['eventsListChanged', 'events/list_changed'],
  ].filter(([key]) => filter[key] === true);
}

export class McpTransport {
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Set<() => void>();
  private closed = false;

  constructor(private readonly storage: StorageAdapter, private readonly secrets: SecretStore,
    private readonly publicUrl: string, private readonly gateway: McpGateway,
    private readonly onConnect: () => Promise<unknown>) {}

  private sse(request: Request, headers: Headers, setup: StreamSetup, session?: Session) {
    const encoder = new TextEncoder();
    let dispose: (() => void) | undefined;
    let finish: () => void;
    let shutdown = false;
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        const close = () => {
          if (shutdown) return;
          shutdown = true;
          request.signal.removeEventListener('abort', close);
          this.streams.delete(close);
          session?.streams.delete(close);
          dispose?.();
          try { controller.close(); } catch {}
        };
        finish = close;
        const send: Send = (message, cursor) => {
          if (shutdown) return false;
          if ((controller.desiredSize ?? 0) < -200) { close(); return false; }
          controller.enqueue(encoder.encode(`${cursor ? 'id: ' + cursor + '\n' : ''}data: ${JSON.stringify(message)}\n\n`));
          return true;
        };
        this.streams.add(close);
        session?.streams.add(close);
        request.signal.addEventListener('abort', close, { once: true });
        if (request.signal.aborted) { close(); return; }
        try {
          dispose = setup(send, close);
          if (shutdown) dispose();
        } catch (error) { close(); throw error; }
      },
      cancel: () => finish?.(),
    });
    headers.set('Content-Type', 'text/event-stream');
    headers.set('Cache-Control', 'no-cache, no-transform');
    headers.set('X-Accel-Buffering', 'no');
    return new Response(stream, { headers });
  }

  private catalogStream(identity: ClientIdentity, filter: Record<string, unknown>, id?: RpcId) {
    const entries = catalogNotifications(filter);
    const selected = Object.fromEntries(entries.map(([key]) => [key, true]));
    const metadata = id === undefined ? undefined : { [subscriptionIdKey]: id };
    return (send: Send, close: () => void) => {
      if (id !== undefined) send(notification('subscriptions/acknowledged', { notifications: selected, _meta: metadata }));
      const stop = this.gateway.events.onChange(event => {
        if (event.name !== 'fabric.catalog.changed') return;
        void (async () => {
          if (!(await this.gateway.events.identityActive(identity))) { close(); return; }
          if (!(await this.gateway.events.canSee(identity.profile.id, event))) return;
          for (const [, method] of entries) send(notification(method, metadata ? { _meta: metadata } : undefined));
        })().catch(close);
      });
      const timer = setInterval(() => {
        void this.gateway.events.identityActive(identity).then(active => {
          if (!active) close();
        }, close);
      }, 15_000);
      timer.unref();
      return () => { clearInterval(timer); stop(); };
    };
  }

  private removeSession(id: string) {
    const current = this.sessions.get(id);
    this.sessions.delete(id);
    if (current) for (const close of current.streams) close();
  }

  async handle(request: Request, profileName: string | null): Promise<Response> {
    if (this.closed) return new Response(null, { status: 503 });
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(this.publicUrl).origin) return Response.json(errorBody(null, -32024, 'Invalid Origin'), { status: 403, headers });
    let identity: ClientIdentity;
    try { identity = await authenticateClient(request, profileName, this.storage); }
    catch (error) {
      const status = error instanceof GatewayError ? error.httpStatus : 500;
      if (status === 401) headers.set('WWW-Authenticate', challenge(this.publicUrl));
      return Response.json(rpcGatewayError(null, error, this.secrets), { status, headers });
    }
    const sessionId = request.headers.get('mcp-session-id') ?? undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && (!session || session.expires <= Date.now() ||
      session.identity.principal !== identity.principal || session.identity.profile.id !== identity.profile.id)) {
      if (session && session.expires <= Date.now()) this.removeSession(sessionId);
      return Response.json(errorBody(null, -32023, 'Unknown MCP session'), { status: 404, headers });
    }
    if (sessionId && session) headers.set('Mcp-Session-Id', sessionId);
    if (session) session.expires = Date.now() + 60 * 60_000;
    let id: RpcId | null = null;
    let method: string | undefined;
    try {
      if (request.method === 'GET' || request.method === 'DELETE') {
        const version = negotiate(request.headers.get('mcp-protocol-version'), session?.version);
        headers.set('MCP-Protocol-Version', version);
        if (request.method === 'DELETE') {
          if (sessionId) this.removeSession(sessionId);
          return new Response(null, { status: 204, headers });
        }
        return this.sse(request, headers, this.catalogStream(identity, Object.fromEntries(
          ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'].map(key => [key, true]))), session);
      }
      if (request.method !== 'POST') {
        headers.set('Allow', 'GET, POST, DELETE');
        return new Response(null, { status: 405, headers });
      }
      const body: unknown = await request.json().catch(() => undefined);
      if (body === undefined) return Response.json(errorBody(null, -32700, 'Invalid JSON'), { status: 400, headers });
      if (isObject(body) && (typeof body.id === 'string' || (typeof body.id === 'number' && Number.isSafeInteger(body.id)))) id = body.id;
      if (!isObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string'
        || (Object.hasOwn(body, 'id') && id === null) || (Object.hasOwn(body, 'params') && !isObject(body.params))) {
        return Response.json(errorBody(id, -32600, 'Invalid JSON-RPC request'), { status: 400, headers });
      }
      method = body.method;
      const params = isObject(body.params) ? body.params : {};
      const meta = isObject(params._meta) ? params._meta : {};
      const version = negotiate(request.headers.get('mcp-protocol-version'), meta[protocolKey], session?.version,
        method === 'initialize' ? params.protocolVersion : undefined);
      headers.set('MCP-Protocol-Version', version);
      const modern = version === latest;
      const clientInfo = method === 'initialize' ? params.clientInfo : meta[clientInfoKey];
      const clientName = isObject(clientInfo) && typeof clientInfo.name === 'string'
        ? this.secrets.redact(clientInfo.name.slice(0, 200)) : session?.clientName;
      if (id === null) return new Response(null, { status: 202, headers });
      if (method === 'initialize') {
        for (const [key, value] of this.sessions) if (value.expires <= Date.now()) this.removeSession(key);
        const key = randomUUID();
        this.sessions.set(key, { identity, version, clientName, expires: Date.now() + 60 * 60_000, streams: new Set() });
        headers.set('Mcp-Session-Id', key);
        await this.onConnect();
        return Response.json(resultBody(id, { protocolVersion: version, capabilities, serverInfo }, modern), { headers });
      }
      if (method === 'server/discover') {
        await this.onConnect();
        return Response.json(resultBody(id, { supportedVersions: [latest], capabilities }, modern, method), { headers });
      }
      if (method === 'subscriptions/listen') {
        if (params.notifications !== undefined && !isObject(params.notifications)) throw new GatewayError('INVALID_INPUT', 'Expected a notification filter');
        return this.sse(request, headers, this.catalogStream(identity, (params.notifications as Record<string, unknown> | undefined) ??
          { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, eventsListChanged: true }, id), session);
      }
      if (method === 'events/stream') {
        const streamParams = { ...params, cursor: params.cursor ?? request.headers.get('last-event-id') };
        return this.sse(request, headers, await this.gateway.events.openStream(identity, streamParams, id), session);
      }
      const result = await this.gateway.dispatch(method, params, identity, { profileId: identity.profile.id, sessionId, clientName, identity });
      return Response.json(resultBody(id, result, modern, method), { headers });
    } catch (error) {
      if (error instanceof UnsupportedProtocolVersionError) {
        return Response.json(errorBody(id, error.code, 'UnsupportedProtocolVersionError', error.data), { status: 400, headers });
      }
      return Response.json(rpcGatewayError(id, error, this.secrets), { headers });
    }
  }

  close() {
    this.closed = true;
    for (const close of this.streams) close();
    this.sessions.clear();
  }
}
