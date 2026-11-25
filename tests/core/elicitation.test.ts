import { randomBytes, randomUUID } from 'node:crypto';
import { createMcpHandler, fromJsonSchema, inputRequired, inputResponse, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { expect, test, vi } from 'vitest';
import type { RunningNodeServer } from '../../src/deploy/node.js';
import { listen } from '../e2e/fixtures/http.js';
import { addSource, api, clientToken, openSse, startGateway, track } from '../e2e/harness.js';

type Rpc = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: any };
const empty = fromJsonSchema<Record<string, never>>({ type: 'object' });
const nameSchema = { type: 'object' as const, properties: { name: { type: 'string' as const } }, required: ['name'] };

async function upstreams() {
  const answers: unknown[] = [];
  const legacyServer = () => {
    const server = new McpServer({ name: 'elicit-legacy', version: '1.0.0' });
    server.registerTool('ask', {
      description: 'Ask the caller via 2025-era elicitation/create',
      inputSchema: fromJsonSchema<{ mode: 'form' | 'url'; message: string; url?: string }>({ type: 'object', properties: {
        mode: { type: 'string', enum: ['form', 'url'] }, message: { type: 'string' }, url: { type: 'string' },
      }, required: ['mode', 'message'] }),
    }, async ({ mode, message, url }, ctx) => {
      const answer = mode === 'url'
        ? await ctx.mcpReq.elicitInput({ mode: 'url', elicitationId: 'upstream-1', url: url ?? '', message })
        : await ctx.mcpReq.elicitInput({ mode: 'form', message, requestedSchema: nameSchema });
      answers.push(answer);
      if (mode === 'url' && answer.action === 'accept') {
        await ctx.mcpReq.notify({ method: 'notifications/elicitation/complete', params: { elicitationId: 'upstream-1' } });
      }
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    });
    server.registerTool('plain', { description: 'No elicitation', inputSchema: empty },
      async () => ({ content: [{ type: 'text', text: '"plain"' }] }));
    return server;
  };
  const modernServer = () => {
    const server = new McpServer({ name: 'elicit-modern', version: '1.0.0' });
    server.registerTool('ask_modern', {
      description: 'Ask the caller via a 2026-era input_required result', inputSchema: empty,
    }, async (_args, ctx) => {
      const view = inputResponse(ctx.mcpReq.inputResponses, 'name');
      if (view.kind === 'missing') {
        return inputRequired({ inputRequests: { name: inputRequired.elicit({ message: 'Modern name?', requestedSchema: nameSchema }) } });
      }
      answers.push(view);
      return { content: [{ type: 'text', text: JSON.stringify(view) }] };
    });
    return server;
  };
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const legacy = track(await listen(async request => {
    const existing = sessions.get(request.headers.get('mcp-session-id') ?? '');
    if (existing) return existing.handleRequest(request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, onsessioninitialized: id => { sessions.set(id, transport); },
    });
    await legacyServer().connect(transport);
    return transport.handleRequest(request);
  }));
  const modernHandler = createMcpHandler(modernServer);
  const modern = track(await listen(request => modernHandler.fetch(request)));
  return { answers, legacyUrl: `${legacy.url}/mcp`, modernUrl: `${modern.url}/mcp` };
}

async function setup() {
  const gateway = await startGateway();
  const fixture = await upstreams();
  await addSource(gateway, { id: 'legacy', name: 'legacy', kind: 'mcp_http', config: { kind: 'mcp_http', url: fixture.legacyUrl, timeoutMs: 1000 } });
  await addSource(gateway, { id: 'modern', name: 'modern', kind: 'mcp_http', config: { kind: 'mcp_http', url: fixture.modernUrl, timeoutMs: 1000 } });
  return { gateway, ...fixture, token: await clientToken(gateway) };
}

const both = 'application/json, text/event-stream';

function downstream(gateway: RunningNodeServer, token: string) {
  let sequence = 0;
  let sessionId: string | undefined;
  const post = (body: unknown, options: { accept?: string; session?: string | null; signal?: AbortSignal } = {}) => {
    const session = options.session === undefined ? sessionId : options.session;
    return fetch(gateway.mcpUrl, {
      method: 'POST', signal: options.signal ?? AbortSignal.timeout(8000), body: JSON.stringify(body),
      headers: {
        accept: options.accept ?? both, 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
    });
  };
  return {
    get sessionId() { return sessionId; },
    post,
    async initialize(capabilities: Record<string, unknown>) {
      const response = await post({ jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'elicitation-test', version: '1.0.0' },
      } });
      expect(response.status).toBe(200);
      sessionId = response.headers.get('mcp-session-id') ?? undefined;
      expect(sessionId).toBeTruthy();
      await response.body?.cancel();
    },
    call(name: string, args: Record<string, unknown> = {}, options: Parameters<typeof post>[1] = {}) {
      const id = ++sequence;
      return { id, response: post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, options) };
    },
    answer(id: unknown, reply: Record<string, unknown>, session?: string | null) {
      return post({ jsonrpc: '2.0', id, ...reply }, { session });
    },
  };
}

async function stream(response: Promise<Response>) {
  const sse = await openSse(await response);
  return { next: async () => (await sse.next()).message as Rpc, close: sse.close };
}

async function jsonResult(response: Promise<Response>) {
  const reply = await response;
  expect(reply.headers.get('content-type')).toContain('application/json');
  const body = await reply.json() as Rpc;
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result.content[0].text) as unknown;
}

test.each([
  ['accept', { action: 'accept', content: { name: 'Ada' } }],
  ['decline', { action: 'decline' }],
  ['cancel', { action: 'cancel' }],
])('form elicitation %s flows from the upstream to the caller and back over SSE', async (_label, answer) => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const call = client.call('ask', { mode: 'form', message: 'Name?' });
  const sse = await stream(call.response);
  const request = await sse.next();
  expect(request).toMatchObject({ method: 'elicitation/create', params: { message: 'Name?', requestedSchema: nameSchema } });
  expect(request.params).not.toHaveProperty('_meta');
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect((await client.answer(request.id, { result: answer })).status).toBe(202);
  const final = await sse.next();
  expect(final.id).toBe(call.id);
  expect(JSON.parse(final.result.content[0].text)).toEqual(answer);
  expect(answers).toEqual([answer]);
});

test('2026-era input_required upstreams elicit through the same downstream SSE stream', async () => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: { form: {} } });
  const call = client.call('ask_modern');
  const sse = await stream(call.response);
  const request = await sse.next();
  expect(request).toMatchObject({ method: 'elicitation/create', params: { message: 'Modern name?' } });
  expect((await client.answer(request.id, { result: { action: 'accept', content: { name: 'Grace' } } })).status).toBe(202);
  expect(JSON.parse((await sse.next()).result.content[0].text)).toEqual({ kind: 'elicit', action: 'accept', content: { name: 'Grace' } });
  expect(answers).toHaveLength(1);
});

test('url elicitation and its completion notification pass through to the caller', async () => {
  const { gateway, token } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: { form: {}, url: {} } });
  const call = client.call('ask', { mode: 'url', message: 'Verify', url: 'https://auth.example.com/verify?step=1' });
  const sse = await stream(call.response);
  const request = await sse.next();
  expect(request).toMatchObject({ method: 'elicitation/create', params: {
    mode: 'url', elicitationId: 'upstream-1', url: 'https://auth.example.com/verify?step=1', message: 'Verify',
  } });
  expect((await client.answer(request.id, { result: { action: 'accept' } })).status).toBe(202);
  expect(await sse.next()).toEqual({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'upstream-1' } });
  const final = await sse.next();
  expect(final.id).toBe(call.id);
  expect(JSON.parse(final.result.content[0].text)).toEqual({ action: 'accept' });
});

test('callers that cannot answer elicitations get a decline and plain JSON replies', async () => {
  const { gateway, token, answers } = await setup();
  const form = { mode: 'form', message: 'Name?' };
  const anonymous = downstream(gateway, token);
  expect(await jsonResult(anonymous.call('ask', form).response)).toEqual({ action: 'decline' });
  const incapable = downstream(gateway, token);
  await incapable.initialize({});
  expect(await jsonResult(incapable.call('ask', form).response)).toEqual({ action: 'decline' });
  const formOnly = downstream(gateway, token);
  await formOnly.initialize({ elicitation: { form: {} } });
  expect(await jsonResult(formOnly.call('ask', { mode: 'url', message: 'Go', url: 'https://example.com' }).response))
    .toEqual({ action: 'decline' });
  const capable = downstream(gateway, token);
  await capable.initialize({ elicitation: { form: {}, url: {} } });
  expect(await jsonResult(capable.call('ask', form, { accept: 'application/json' }).response)).toEqual({ action: 'decline' });
  const plain = await capable.call('plain').response;
  expect(plain.headers.get('content-type')).toContain('application/json');
  expect(await plain.json()).toMatchObject({ result: { content: [{ type: 'text', text: '"plain"' }] } });
  expect(answers).toEqual(Array(4).fill({ action: 'decline' }));
});

test('only the owning session can answer an elicitation', async () => {
  const { gateway, token, answers } = await setup();
  const owner = downstream(gateway, token);
  await owner.initialize({ elicitation: {} });
  const sibling = downstream(gateway, token);
  await sibling.initialize({ elicitation: {} });
  const foreign = downstream(gateway, await clientToken(gateway));
  await foreign.initialize({ elicitation: {} });
  const call = owner.call('ask', { mode: 'form', message: 'Name?' });
  const sse = await stream(call.response);
  const { id } = await sse.next();
  const forged = { result: { action: 'accept', content: { name: 'Mallory' } } };
  expect((await sibling.answer(id, forged)).status).toBe(404);
  expect((await foreign.answer(id, forged)).status).toBe(404);
  expect((await foreign.answer(id, forged, owner.sessionId)).status).toBe(404);
  expect((await owner.answer(id, forged, null)).status).toBe(404);
  expect((await owner.answer(id, { result: { action: 'accept', content: { name: { nested: true } } } })).status).toBe(400);
  expect((await owner.answer('elicitation-unknown', forged)).status).toBe(404);
  expect(answers).toEqual([]);
  expect((await owner.answer(id, { result: { action: 'accept', content: { name: 'Ada' } } })).status).toBe(202);
  expect(JSON.parse((await sse.next()).result.content[0].text)).toEqual({ action: 'accept', content: { name: 'Ada' } });
  expect((await owner.answer(id, forged)).status).toBe(404);
  expect(answers).toEqual([{ action: 'accept', content: { name: 'Ada' } }]);
});

test('accepted form content must match the requested schema and a mismatch keeps the elicitation open', async () => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const call = client.call('ask', { mode: 'form', message: 'Name?' });
  const sse = await stream(call.response);
  const { id } = await sse.next();
  for (const content of [{}, { name: 42 }, { name: 'Ada', role: 'admin' }]) {
    const rejected = await client.answer(id, { result: { action: 'accept', content } });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: -32602 } });
  }
  expect((await client.answer(id, { result: { action: 'accept' } })).status).toBe(400);
  expect(answers).toEqual([]);
  expect((await client.answer(id, { result: { action: 'accept', content: { name: 'Ada' } } })).status).toBe(202);
  expect(JSON.parse((await sse.next()).result.content[0].text)).toEqual({ action: 'accept', content: { name: 'Ada' } });
  expect(answers).toEqual([{ action: 'accept', content: { name: 'Ada' } }]);
});

test('an error response from the caller cancels the elicitation', async () => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const sse = await stream(client.call('ask', { mode: 'form', message: 'Name?' }).response);
  const { id } = await sse.next();
  expect((await client.answer(id, { error: { code: -32603, message: 'UI crashed' } })).status).toBe(202);
  expect(JSON.parse((await sse.next()).result.content[0].text)).toEqual({ action: 'cancel' });
  expect(answers).toEqual([{ action: 'cancel' }]);
});

test.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@evil.example', 'data:text/html,hi'])(
  'unsafe url elicitation %s is declined before reaching the caller', async url => {
    const { gateway, token, answers } = await setup();
    const client = downstream(gateway, token);
    await client.initialize({ elicitation: { url: {} } });
    expect(await jsonResult(client.call('ask', { mode: 'url', message: 'Open', url }).response)).toEqual({ action: 'decline' });
    expect(answers).toEqual([{ action: 'decline' }]);
  });

test('vault secret values in upstream elicitations are redacted before reaching the caller', async () => {
  const { gateway, token } = await setup();
  const secret = `sk_${randomBytes(24).toString('hex')}`;
  await api(gateway, '/secrets/upstream-key', 'PUT', { value: secret });
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const sse = await stream(client.call('ask', { mode: 'form', message: `Confirm key ${secret}` }).response);
  const request = await sse.next();
  expect(JSON.stringify(request)).not.toContain(secret);
  expect(request.params?.message).toBe('Confirm key [REDACTED]');
  await client.answer(request.id, { result: { action: 'decline' } });
  expect(JSON.stringify(await sse.next())).not.toContain(secret);
});

test('notifications/cancelled cancels the pending elicitation and leaves nothing to answer', async () => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const call = client.call('ask', { mode: 'form', message: 'Name?' });
  const sse = await stream(call.response);
  const { id } = await sse.next();
  const cancelled = await client.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: call.id } });
  expect(cancelled.status).toBe(202);
  await vi.waitFor(() => expect(answers).toEqual([{ action: 'cancel' }]));
  expect((await client.answer(id, { result: { action: 'accept', content: { name: 'late' } } })).status).toBe(404);
  await sse.close();
});

test('a caller disconnect cancels the pending elicitation and leaves nothing to answer', async () => {
  const { gateway, token, answers } = await setup();
  const client = downstream(gateway, token);
  await client.initialize({ elicitation: {} });
  const abort = new AbortController();
  const sse = await stream(client.call('ask', { mode: 'form', message: 'Name?' }, { signal: abort.signal }).response);
  const { id } = await sse.next();
  abort.abort();
  await vi.waitFor(() => expect(answers).toEqual([{ action: 'cancel' }]));
  expect((await client.answer(id, { result: { action: 'accept', content: { name: 'late' } } })).status).toBe(404);
  expect(await jsonResult(client.call('plain').response)).toBe('plain');
});
