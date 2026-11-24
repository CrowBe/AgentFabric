import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GetSkillResultSchema, ListSkillsResultSchema, ReadResourceDirectoryResultSchema } from '@modelcontextprotocol/core/ext/skills';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { MemoryStorageAdapter, MemoryTraceStore } from '../../src/storage/memory.js';
import { InMemorySecretStore } from '../../src/storage/secrets.js';
import type { CliWrapperSourceConfig, GatewayRuntime, RuntimeOptions } from '../../src/types/index.js';

const publicUrl = 'https://fabric.example';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function tmp() {
  const folder = await mkdtemp(join(tmpdir(), 'agentfabric-runtime-'));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function start(options: Partial<RuntimeOptions> = {}) {
  const runtime = await createGatewayRuntime({
    mode: 'local', homeDir: '/unused', publicUrl, operatorToken: 'local-operator',
    storage: new MemoryStorageAdapter(), traceStore: new MemoryTraceStore(), secrets: new InMemorySecretStore(), ...options,
  });
  cleanup.push(() => runtime.close());
  const { token, record } = await runtime.createToken({ profileId: 'default', label: 'test' });
  return { runtime, token, record };
}

function request(runtime: GatewayRuntime, token: string | undefined, method: string, params: unknown = {},
  options: { profile?: string; headers?: Record<string, string>; id?: string | number } = {}) {
  const headers = { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers };
  return runtime.handleMcpRequest(new Request(publicUrl + '/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params }),
  }), options.profile ?? null);
}

async function rpc(runtime: GatewayRuntime, token: string, method: string, params: unknown = {}, options?: Parameters<typeof request>[4]) {
  return (await request(runtime, token, method, params, options)).json();
}

function tool(name: string, path?: string): CliWrapperSourceConfig {
  return {
    kind: 'cli_wrapper', toolName: name, description: `Echo with ${name}`, command: process.execPath,
    argsTemplate: ['-e', path
      ? 'require("node:fs").appendFileSync(process.argv[1], "ran\\n"); process.stdout.write(process.argv[2])'
      : 'process.stdout.write(process.argv[1])', '--', ...(path ? [path] : []), '{{value}}'],
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  };
}

async function createTool(runtime: GatewayRuntime, id: string, config: CliWrapperSourceConfig) {
  return runtime.createSource({ id, name: id, kind: 'cli_wrapper', config });
}

describe('MCP authorization and approval', () => {
  it('challenges missing and revoked bearers and rejects foreign profiles before refreshing upstreams', async () => {
    const { runtime, token, record } = await start();
    const denied = await request(runtime, undefined, 'tools/list');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toBe('Bearer resource_metadata="https://fabric.example/.well-known/oauth-protected-resource"');
    expect(runtime.authenticateOperator(new Request(publicUrl, { headers: { 'X-Operator-Token': 'local-operator' } }))).toBe(true);
    expect(runtime.authenticateOperator(new Request(publicUrl, { headers: { Authorization: 'Bearer local-operator' } }))).toBe(true);
    expect(runtime.authenticateOperator(new Request(publicUrl, { headers: { Authorization: 'Bearer local-operatoq' } }))).toBe(false);
    await runtime.createProfile({ id: 'other', name: 'Other' });
    const foreign = await request(runtime, token, 'server/discover', {}, { profile: 'other' });
    expect(foreign.status).toBe(403);
    await runtime.revokeToken(record.id);
    expect((await request(runtime, token, 'tools/list')).status).toBe(401);
  });

  it('validates first, records redacted approval arguments, then executes only after approval', async () => {
    const { runtime, token } = await start();
    const runPath = join(await tmp(), 'runs');
    await createTool(runtime, 'source', tool('echo', runPath));
    await runtime.setSecret('known', 'sensitive-output');
    await runtime.createPolicy({ name: 'gate', capabilityPattern: 'echo', action: 'require_approval' });
    const invalid = await rpc(runtime, token, 'tools/call', { name: 'echo', arguments: { value: 'okay', unexpected: true } });
    expect(invalid.error).toMatchObject({ code: -32602, data: { code: 'INVALID_INPUT' } });
    expect(await runtime.listApprovals()).toEqual([]);
    const pending = rpc(runtime, token, 'tools/call', { name: 'echo', arguments: { value: 'sensitive-output' } });
    await vi.waitFor(async () => expect(await runtime.listApprovals('pending')).toHaveLength(1));
    const [approval] = await runtime.listApprovals('pending');
    expect(approval.redactedArguments).toEqual({ value: '[REDACTED]' });
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(runPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await runtime.decideApproval(approval.id, 'approved');
    expect((await pending).result.content).toEqual([{ type: 'text', text: '[REDACTED]' }]);
    expect(await readFile(runPath, 'utf8')).toBe('ran\n');
    const events = await runtime.listEventOccurrences();
    expect(events.map(event => event.name)).toEqual(expect.arrayContaining(['fabric.approval.requested', 'fabric.approval.decided']));
  });

  it('denies, expires, and rechecks token revocation while waiting', async () => {
    const { runtime, token, record } = await start({ approvalTimeoutMs: 450 });
    const runPath = join(await tmp(), 'runs');
    await createTool(runtime, 'source', tool('echo', runPath));
    await runtime.createPolicy({ name: 'gate', capabilityPattern: 'echo', action: 'require_approval' });
    const args = { name: 'echo', arguments: { value: 'one' } };
    const denied = rpc(runtime, token, 'tools/call', args);
    await vi.waitFor(async () => expect(await runtime.listApprovals('pending')).toHaveLength(1));
    const [approval] = await runtime.listApprovals('pending');
    await runtime.decideApproval(approval.id, 'denied');
    expect((await denied).error.data.code).toBe('APPROVAL_DENIED');
    const expired = await rpc(runtime, token, 'tools/call', args);
    expect(expired.error.data).toMatchObject({ code: 'APPROVAL_TIMEOUT', approval: { status: 'expired', approvalUrl: expect.stringContaining('/#/safety?approval=') } });
    const revoked = rpc(runtime, token, 'tools/call', args);
    await vi.waitFor(async () => expect(await runtime.listApprovals('pending')).toHaveLength(1));
    const [last] = await runtime.listApprovals('pending');
    await runtime.revokeToken(record.id);
    await runtime.decideApproval(last.id, 'approved');
    expect((await revoked).error.data.code).toBe('FORBIDDEN');
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(runPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates telemetry failures from completed calls', async () => {
    class BrokenTrace extends MemoryTraceStore { override async append() { throw new Error('offline'); } }
    const { runtime, token } = await start({ traceStore: new BrokenTrace() });
    await createTool(runtime, 'source', tool('echo'));
    const value = 'a;b $(echo wrong)';
    expect((await rpc(runtime, token, 'tools/call', { name: 'echo', arguments: { value } })).result.content[0].text).toBe(value);
  });
});

describe('upstreams and curation', () => {
  it('fails closed for remote CLI, null arguments, cli timeouts and output limits', async () => {
    const remote = await start({ mode: 'remote' });
    await expect(createTool(remote.runtime, 'source', tool('echo'))).rejects.toMatchObject({ code: 'REMOTE_CLI_FORBIDDEN' });
    const { runtime, token } = await start();
    await createTool(runtime, 'null', tool('echo'));
    await createTool(runtime, 'timeout', { ...tool('slow'), argsTemplate: ['-e', 'setInterval(()=>{}, 1000)'], timeoutMs: 50 });
    await createTool(runtime, 'max', { ...tool('large'), argsTemplate: ['-e', 'process.stdout.write("a".repeat(10000))'], maxOutputBytes: 128 });
    expect((await rpc(runtime, token, 'tools/call', { name: 'echo', arguments: { value: 'a\0b' } })).error.data.code).toBe('INVALID_INPUT');
    expect((await rpc(runtime, token, 'tools/call', { name: 'slow', arguments: { value: 'a' } })).error.data.code).toBe('UPSTREAM_TIMEOUT');
    expect((await rpc(runtime, token, 'tools/call', { name: 'large', arguments: { value: 'a' } })).error.data.code).toBe('UPSTREAM_ERROR');
  });

  it('uses finalised overlays, preserves natural names and applies a stable direct budget', async () => {
    const { runtime, token } = await start();
    await createTool(runtime, 'a', tool('echo'));
    await createTool(runtime, 'b', tool('echo'));
    await createTool(runtime, 'c', tool('b.echo'));
    await runtime.updateProfile('default', { directToolBudget: 1 });
    let caps = await runtime.listCapabilities();
    expect(caps.map(cap => [cap.exposedName, cap.exposure])).toEqual([
      ['b.echo', 'direct'], ['echo', 'searchable'], ['b.echo.2', 'searchable'],
    ]);
    const draft = await runtime.draftOverlay(caps[1].id);
    expect(draft.appliedByOperator).toBe(false);
    expect((await runtime.draftPolicy({ description: 'gate delete' }))).toMatchObject({ action: 'require_approval', enabled: false });
    await runtime.applyOverlay(caps[1].id, { displayName: 'lookup', parameterDescriptions: { value: 'Echo argument' } });
    caps = await runtime.listCapabilities();
    expect(caps.find(cap => cap.exposedName === 'lookup')).toMatchObject({ hasOverlay: true, inputSchema: { properties: { value: { description: 'Echo argument' } } } });
    const listed = await rpc(runtime, token, 'tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'fabric_search', 'fabric_inspect', 'fabric_call', 'fabric_propose_capability', 'b.echo',
    ]);
  });

  it('persists proposals without activation and sends composite steps through gateway validation and policy', async () => {
    const { runtime, token } = await start();
    await createTool(runtime, 'source', tool('echo'));
    const proposal = await rpc(runtime, token, 'tools/call', { name: 'fabric_propose_capability', arguments: {
      name: 'Pending pipeline', description: '', definition: { kind: 'composite', toolName: 'pipeline', description: '',
        inputSchema: tool('echo').inputSchema, steps: [{ id: 'first', capability: 'echo', argumentsTemplate: { value: '{{input.value}}' } }],
        outputTemplate: { value: '{{steps.first}}' } },
    } });
    const { id } = proposal.result.structuredContent;
    expect((await runtime.listProposals('pending_review')).map(item => item.id)).toEqual([id]);
    expect((await rpc(runtime, token, 'tools/call', { name: 'pipeline', arguments: { value: 'x' } })).error.data.code).toBe('CAPABILITY_NOT_FOUND');
    await runtime.activateProposal(id);
    const result = await rpc(runtime, token, 'tools/call', { name: 'pipeline', arguments: { value: 'x' } });
    expect(result.result.structuredContent).toEqual({ value: 'x' });
    await runtime.createPolicy({ name: 'block echo', capabilityPattern: 'echo', action: 'deny' });
    expect((await rpc(runtime, token, 'tools/call', { name: 'pipeline', arguments: { value: 'x' } })).error.data.code).toBe('CAPABILITY_NOT_FOUND');
    const config = { kind: 'composite' as const, toolName: 'cycle', description: '', inputSchema: tool('echo').inputSchema,
      steps: [{ id: 'self', capability: 'cycle', argumentsTemplate: { value: '{{value}}' } }] };
    await runtime.createSource({ name: 'cycle', kind: 'composite', config });
    expect((await rpc(runtime, token, 'tools/call', { name: 'cycle', arguments: { value: 'x' } })).error.data.code).toBe('INVALID_INPUT');
    await expect(runtime.createSource({ name: 'too much', kind: 'composite', config: {
      ...config, steps: [...config.steps, { ...config.steps[0], id: 'two' }], maxSteps: 1,
    } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('confines shared resources through realpath and limits file extensions and size', async () => {
    const { runtime, token } = await start();
    const root = await tmp();
    const outside = join(await tmp(), 'private.txt');
    await writeFile(outside, 'private');
    await writeFile(join(root, 'okay.txt'), 'okay');
    await writeFile(join(root, 'secret.env'), 'secret');
    await writeFile(join(root, 'big.txt'), 'a'.repeat(20));
    await symlink(outside, join(root, 'link.txt'));
    await runtime.createSource({ name: 'share', kind: 'shared_folder', config: {
      kind: 'shared_folder', shareName: 'repo', rootPath: root, readOnly: true, allowedExtensions: ['.txt'], maxFileBytes: 10,
    } });
    for (const path of ['../private.txt', 'link.txt']) {
      const result = await rpc(runtime, token, 'tools/call', { name: 'repo_read', arguments: { path } });
      expect(result.error.data.code).toBe('PATH_OUTSIDE_SHARE');
    }
    expect((await rpc(runtime, token, 'resources/read', { uri: 'workspace://repo/%2e%2e/private.txt' })).error.data.code).toBe('PATH_OUTSIDE_SHARE');
    expect((await rpc(runtime, token, 'tools/call', { name: 'repo_read', arguments: { path: 'secret.env' } })).error.data.code).toBe('FORBIDDEN');
    expect((await rpc(runtime, token, 'tools/call', { name: 'repo_read', arguments: { path: 'big.txt' } })).error.data.code).toBe('INVALID_INPUT');
    expect((await rpc(runtime, token, 'resources/read', { uri: 'workspace://repo/okay.txt' })).result.contents[0].text).toBe('okay');
    expect((await rpc(runtime, token, 'resources/templates/list')).result.resourceTemplates[0].uriTemplate).toBe('workspace://repo/{+path}');
  });
});

describe('protocol and OAuth', () => {
  it('negotiates modern and legacy versions, rejecting unknown versions and closing legacy sessions', async () => {
    const { runtime, token } = await start();
    const modern = await rpc(runtime, token, 'server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    expect(modern.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {
      events: { deliveryModes: ['poll', 'push', 'webhook'] }, extensions: { 'io.modelcontextprotocol/events': { listChanged: true } },
    } });
    const wrong = await request(runtime, token, 'ping', {}, { headers: { 'MCP-Protocol-Version': '2000-01-01' } });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatchObject({ code: -32022, message: 'UnsupportedProtocolVersionError',
      data: { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'], requested: '2000-01-01' } });
    for (const version of ['2025-11-25', '2025-03-26']) {
      const init = await request(runtime, token, 'initialize', { protocolVersion: version, clientInfo: { name: 'legacy' } });
      expect((await init.json()).result.protocolVersion).toBe(version);
      const sessionId = init.headers.get('Mcp-Session-Id')!;
      const headers = { Authorization: 'Bearer ' + token, 'Mcp-Session-Id': sessionId };
      const notifications = await runtime.handleMcpRequest(new Request(publicUrl + '/mcp', {
        method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }), null);
      expect(notifications.status).toBe(202);
      const stream = await runtime.handleMcpRequest(new Request(publicUrl + '/mcp', { headers }), null);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const close = await runtime.handleMcpRequest(new Request(publicUrl + '/mcp', { method: 'DELETE', headers }), null);
      expect(close.status).toBe(204);
      expect(await stream.text()).toBe('');
      expect((await request(runtime, token, 'ping', {}, { headers })).status).toBe(404);
    }
  });

  it('works with the installed modern SDK and serves official skills payloads', async () => {
    const { runtime, token } = await start();
    const content = '# Planning\nUse the project templates.';
    await runtime.createSource({ name: 'Planning', kind: 'skill', config: {
      kind: 'skill', slug: 'planning', title: 'Planning', description: 'Plan work', content,
    } });
    const sdk = new Client({ name: 'sdk-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(publicUrl + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
      fetch: (url, init) => runtime.handleMcpRequest(new Request(url, init), null),
    });
    try {
      await sdk.connect(transport);
      expect(await sdk.listTools()).toMatchObject({ tools: expect.arrayContaining([expect.objectContaining({ name: 'fabric_search' })]) });
      expect(await sdk.getPrompt({ name: 'skill:planning' })).toMatchObject({ messages: [{ content: { text: content } }] });
      expect(await sdk.readResource({ uri: 'skill://planning' })).toMatchObject({ contents: [{ text: content }] });
      const expected = { uri: 'skill://planning', digest: 'sha256:' + createHash('sha256').update(content).digest('hex') };
      expect(await sdk.request({ method: 'skills/list' }, ListSkillsResultSchema)).toMatchObject({ skills: [{ resources: [expected] }] });
      expect(await sdk.request({ method: 'skills/get', params: { uri: expected.uri } }, GetSkillResultSchema)).toMatchObject({ skill: { resources: [expected] } });
      expect(await sdk.request({ method: 'resources/directory/read', params: { uri: expected.uri } }, ReadResourceDirectoryResultSchema))
        .toMatchObject({ resources: [{ name: 'SKILL.md', uri: expected.uri }] });
    } finally { await sdk.close(); }
  });

  it('registers public clients, validates PKCE and consumes codes and rotated refresh tokens once', async () => {
    const { runtime } = await start();
    const registration = await runtime.handleOAuthRegister(new Request(publicUrl + '/oauth/register', {
      method: 'POST', body: JSON.stringify({ client_name: 'client', redirect_uris: ['https://client.example/cb'] }),
    }));
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json();
    const redirect = 'https://client.example/cb';
    const verifier = 'a'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge });
    expect(await runtime.validateOAuthAuthorize(auth)).toMatchObject({ ok: true, profileId: 'default' });
    const bad = new URLSearchParams(auth);
    bad.set('redirect_uri', 'https://other.example');
    expect(await runtime.validateOAuthAuthorize(bad)).toMatchObject({ ok: false });
    const { redirectUrl } = await runtime.approveOAuthAuthorize({ clientId: client_id, redirectUri: redirect, codeChallenge: challenge,
      profileId: 'default', scope: 'mcp', state: 'expected-state' });
    const params = new URL(redirectUrl).searchParams;
    expect(params.get('state')).toBe('expected-state');
    const code = params.get('code')!;
    const exchange = (values: Record<string, string>) => runtime.handleOAuthToken(new Request(publicUrl + '/oauth/token', {
      method: 'POST', body: new URLSearchParams({ client_id, ...values }),
    }));
    const codeParams = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect };
    const response = await exchange(codeParams);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect((await request(runtime, tokens.access_token, 'tools/list')).status).toBe(200);
    expect((await exchange(codeParams)).status).toBe(400);
    const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
    const rotations = await Promise.all([exchange(refresh), exchange(refresh)]);
    expect(rotations.map(response => response.status).sort()).toEqual([200, 400]);
    const protectedResource = await runtime.handleOAuthProtectedResourceMetadata(new Request(publicUrl));
    expect(await protectedResource.json()).toMatchObject({ resource: publicUrl + '/mcp', authorization_servers: [publicUrl] });
    const server = await runtime.handleOAuthAuthorizationServerMetadata(new Request(publicUrl));
    expect(await server.json()).toMatchObject({ issuer: publicUrl, code_challenge_methods_supported: ['S256'] });
  });
});

describe('MCP upstream adapters', () => {
  it('keeps healthy stdio capabilities available beside broken and unauthorized sources', async () => {
    const { runtime, token } = await start();
    const script = `
      const lines = require('node:readline').createInterface({ input: process.stdin });
      lines.on('line', line => {
        const { id, method, params } = JSON.parse(line);
        if (id === undefined) return;
        let result;
        let error;
        if (method === 'initialize') result = { protocolVersion: '2025-11-25',
          serverInfo: { name: 'fixture', version: '1.0.0' }, capabilities: { tools: {}, prompts: {}, resources: {} } };
        else if (method === 'tools/list') result = { tools: [{ name: 'env', inputSchema: { type: 'object', properties: {} } }] };
        else if (method === 'prompts/list') result = { prompts: [{ name: 'greet', arguments: [{ name: 'name', required: true }] }] };
        else if (method === 'resources/list') result = { resources: [{ name: 'readme', uri: 'fixture://readme' }] };
        else if (method === 'resources/templates/list') result = { resourceTemplates: [] };
        else if (method === 'tools/call') result = { content: [{ type: 'text',
          text: JSON.stringify({ inherited: process.env.HOME ?? null, allowed: process.env.AF_PUBLIC ?? null, secret: process.env.AF_VAULT ?? null }) }] };
        else if (method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: params.arguments.name } }] };
        else if (method === 'resources/read') result = { contents: [{ uri: params.uri, text: 'readme' }] };
        else error = { code: -32601, message: 'unknown' };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\\n');
      });
    `;
    vi.stubEnv('AF_PUBLIC', 'allowed');
    vi.stubEnv('HOME', 'should-not-inherit');
    await runtime.setSecret('stdio-vault', 'stdio-secret');
    const [healthy, broken, unauthorized] = await Promise.all([
      runtime.createSource({ id: 'stdio', name: 'stdio', kind: 'mcp_stdio', config: {
        kind: 'mcp_stdio', command: process.execPath, args: ['-e', script], envAllowlist: ['AF_PUBLIC'], timeoutMs: 1000,
      }, authConfig: { kind: 'env_secrets', envMap: { AF_VAULT: 'stdio-vault' } } }),
      runtime.createSource({ name: 'broken', kind: 'mcp_stdio', config: { kind: 'mcp_stdio', command: '/missing/program', args: [], timeoutMs: 100 } }),
      runtime.createSource({ name: 'unauthorized', kind: 'mcp_http',
        config: { kind: 'mcp_http', url: 'https://fixture.invalid/mcp' },
        authConfig: { kind: 'bearer_secret', secretName: 'unset' } }),
    ]);
    expect([healthy.health, broken.health, unauthorized.health]).toEqual(['healthy', 'degraded', 'auth_required']);
    const result = await rpc(runtime, token, 'tools/call', { name: 'env' });
    expect(JSON.parse(result.result.content[0].text)).toEqual({ inherited: null, allowed: 'allowed', secret: '[REDACTED]' });
    expect((await rpc(runtime, token, 'prompts/get', { name: 'greet', arguments: { name: 'hello' } })).result.messages[0].content.text).toBe('hello');
    expect((await rpc(runtime, token, 'resources/read', { uri: 'fixture://readme' })).result.contents[0].text).toBe('readme');
    const check = await runtime.testSource(unauthorized.id);
    const ticket = new URL(check.authHandoff!.authUrl).searchParams.get('ticket')!;
    expect(await runtime.validateAuthTicket(healthy.id, ticket)).toMatchObject({ valid: false });
    expect(await runtime.validateAuthTicket(unauthorized.id, ticket)).toMatchObject({ valid: true });
  });

  it('injects HTTP bearer secrets, pools upstream events, and marks HTTP 403 as auth required', async () => {
    const { runtime, token } = await start();
    let accepted = false;
    const seenAuth: (string | null)[] = [];
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      if (new URL(request.url).hostname !== 'upstream.example') return originalFetch(url, init);
      seenAuth.push(request.headers.get('authorization'));
      if (!accepted) return new Response(null, { status: 403 });
      const { id, method, params } = await request.json();
      if (method === 'events/stream') {
        const messages = [
          { method: 'notifications/events/active', params: { cursor: 'before', heartbeatMs: 2000 } },
          { method: 'notifications/events/event', params: { name: 'fixture.happened', eventId: 'push', cursor: 'after',
            timestamp: new Date().toISOString(), data: { message: 'http-secret' } } },
          { id, result: { resultType: 'complete' } },
        ];
        return new Response(messages.map(message => `data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`).join(''),
          { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const results: Record<string, unknown> = {
        'server/discover': { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/events': {} } },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0.0' } } },
        'tools/list': { ttlMs: 0, cacheScope: 'private', tools: [{ name: 'http_tool', inputSchema: { type: 'object', properties: {} } }] },
        'tools/call': { content: [{ type: 'text', text: 'http-secret' }] },
        'events/list': { events: [{ name: 'fixture.happened', delivery: ['poll', 'push'], inputSchema: { type: 'object', properties: {} },
          payloadSchema: { type: 'object' } }] },
        'events/poll': { cursor: 'next', events: params.cursor === 'old' ? [{ eventId: 'fixture', name: 'fixture.happened', cursor: 'next',
          timestamp: new Date().toISOString(), data: { message: 'http-secret' } }] : [] },
      };
      return Response.json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...results[method] as object } });
    });
    await runtime.setSecret('http', 'http-secret');
    const source = await runtime.createSource({ name: 'HTTP', kind: 'mcp_http', config: { kind: 'mcp_http', url: 'https://upstream.example/mcp', timeoutMs: 500 },
      authConfig: { kind: 'bearer_secret', secretName: 'http' } });
    expect(source.health).toBe('auth_required');
    const { authHandoff } = await runtime.testSource(source.id);
    const ticket = new URL(authHandoff!.authUrl).searchParams.get('ticket')!;
    expect(authHandoff!.cliCommand).toBeUndefined();
    await expect(runtime.completeAuthHandoff(source.id, ticket, { unrelated: 'guess' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    accepted = true;
    await runtime.completeAuthHandoff(source.id, ticket, { http: 'http-secret' });
    await expect(runtime.completeAuthHandoff(source.id, ticket, { http: 'http-secret' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await rpc(runtime, token, 'tools/call', { name: 'http_tool' })).result.content[0].text).toBe('[REDACTED]');
    expect((await rpc(runtime, token, 'events/list')).result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'fixture.happened', delivery: ['poll', 'push'] }),
    ]));
    const polled = await rpc(runtime, token, 'events/poll', { name: 'fixture.happened', cursor: 'old' });
    expect(polled.result).toMatchObject({ events: [{ data: { message: '[REDACTED]' } }], cursor: 'next' });
    const stream = await request(runtime, token, 'events/stream', { name: 'fixture.happened' });
    const pushed = await stream.text();
    expect(pushed).toContain('notifications/events/active');
    expect(pushed).toContain('notifications/events/event');
    expect(pushed).toContain('[REDACTED]');
    expect(pushed).not.toContain('http-secret');
    expect(seenAuth.every(header => header === 'Bearer http-secret')).toBe(true);
  });

  it('returns a local CLI login command only for a local wrapper handoff', async () => {
    const { runtime } = await start();
    const source = await runtime.createSource({ name: 'CLI', kind: 'cli_wrapper', config: tool('echo'),
      authConfig: { kind: 'env_secrets', envMap: { CLI_KEY: 'cli-key' }, cliLoginCommand: 'cli login' } });
    const check = await runtime.testSource(source.id);
    expect(check.authHandoff).toMatchObject({ cliCommand: 'cli login', authUrl: expect.stringContaining('/auth/connect/') });
  });
});

it('uses the configured LLM API only for redacted drafts', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(new Headers(init?.headers).get('x-api-key')).toBe('model-credential');
    expect(String(init?.body)).not.toContain('known-private-marker');
    return Response.json({ content: [{ text: JSON.stringify({ name: 'Draft scope', capabilityPattern: '*', action: 'deny',
      description: 'Normalized description', semanticGroup: 'Utility', appliedByOperator: true, enabled: true }) }] });
  });
  const { runtime } = await start({ llm: { provider: 'anthropic', model: 'draft-model', apiUrl: 'https://llm.example/messages', apiKeySecretName: 'model' } });
  await runtime.setSecret('model', 'model-credential');
  await runtime.setSecret('marker', 'known-private-marker');
  await createTool(runtime, 'source', tool('echo'));
  const [cap] = await runtime.listCapabilities();
  expect(await runtime.draftOverlay(cap.id, 'Omit known-private-marker')).toMatchObject({
    description: 'Normalized description', semanticGroup: 'Utility', appliedByOperator: false,
  });
  expect(await runtime.draftPolicy({ description: 'Gate known-private-marker' })).toMatchObject({ action: 'deny', enabled: false });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await runtime.listCapabilities())[0]).toMatchObject({ hasOverlay: false, description: 'Echo with echo' });
  expect(await runtime.listPolicies()).toEqual([]);
});

it('reports all deterministic curation hint categories without changing exposure', async () => {
  const trace = new MemoryTraceStore();
  const { runtime } = await start({ traceStore: trace });
  for (const name of ['a_direct', 'b_searched', 'c_slow']) await createTool(runtime, name, tool(name));
  await runtime.updateProfile('default', { rules: [{ id: 'searchable', sourceId: 'b_searched', exposure: 'searchable' }] });
  const before = await runtime.listCapabilities();
  for (let index = 0; index < 3; index++) {
    for (const [cap, toolName, latencyMs, status] of [
      [before[1], 'fabric_search', 0, 'ok'],
      [before[2], 'c_slow', 1500, 'upstream_error'],
    ] as const) await trace.append({
      id: toolName + index, profileId: 'default', sourceId: cap.sourceId, capabilityId: cap.id, toolName,
      timestamp: new Date().toISOString(), latencyMs, status, inputBytes: 0, outputBytes: 0,
    });
  }
  expect((await runtime.getCurationHints()).map(hint => hint.type)).toEqual([
    'unused_direct', 'frequently_searched', 'high_error_rate', 'slow_capability',
  ]);
  expect(await runtime.listCapabilities()).toEqual(before);
});

it('opens the default persistence stack and retains catalog, credentials and traces after restart', async () => {
  const homeDir = await tmp();
  vi.stubEnv('AGENTFABRIC_MASTER_KEY', undefined);
  const options = { mode: 'local' as const, homeDir, publicUrl };
  const first = await createGatewayRuntime(options);
  try {
    const { token } = await first.createToken({ label: 'test', profileId: 'default' });
    await first.setSecret('test', 'persisted-secret');
    await createTool(first, 'echo', tool('echo'));
    expect((await rpc(first, token, 'tools/call', { name: 'echo', arguments: { value: 'persisted-secret' } })).result.content[0].text).toBe('[REDACTED]');
  } finally { await first.close(); }
  const second = await createGatewayRuntime(options);
  try {
    expect(await second.listSecrets()).toEqual([expect.objectContaining({ name: 'test' })]);
    expect(await second.listCapabilities()).toEqual([expect.objectContaining({ exposedName: 'echo', available: true })]);
    expect(await second.getTelemetrySummary()).toMatchObject({ totalCalls: 1, errorCount: 0 });
  } finally { await second.close(); }
});

it('rejects shells as CLI wrapper executables, including a resolved alias', async () => {
  const { runtime, token } = await start();
  const path = join(await tmp(), 'alias');
  await symlink('/bin/sh', path);
  for (const [id, command] of [['literal', '/bin/sh'], ['alias', path]]) {
    const source = await createTool(runtime, id, { ...tool(id), command, argsTemplate: ['-c', '{{value}}'] });
    expect(source).toMatchObject({ health: 'error', lastError: 'CLI wrappers must name the target executable directly' });
    expect((await rpc(runtime, token, 'tools/call', { name: id, arguments: { value: 'exit 0' } })).error.data.code).toBe('CAPABILITY_NOT_FOUND');
  }
});

it('excludes native gateway state from shared folders', async () => {
  const homeDir = await tmp();
  const { runtime, token } = await start({ homeDir });
  await writeFile(join(homeDir, 'master.key'), 'sealed');
  await writeFile(join(homeDir, 'operator-token'), 'afop_secret');
  await writeFile(join(homeDir, 'public.txt'), 'shareable');
  await symlink(join(homeDir, 'master.key'), join(homeDir, 'alias.txt'));
  await runtime.createSource({ name: 'share', kind: 'shared_folder', config: {
    kind: 'shared_folder', shareName: 'state', rootPath: homeDir, readOnly: true,
  } });
  const listing = (await rpc(runtime, token, 'resources/read', { uri: 'workspace://state/' })).result.contents[0].text;
  expect(listing).not.toContain('master.key');
  expect(listing).not.toContain('operator-token');
  expect((await rpc(runtime, token, 'resources/read', { uri: 'workspace://state/alias.txt' })).error.data.code).toBe('FORBIDDEN');
  expect((await rpc(runtime, token, 'resources/read', { uri: 'workspace://state/operator-token' })).error.data.code).toBe('FORBIDDEN');
});

it('honors manual, on-connect, and interval refresh policies independently', async () => {
  const { runtime, token } = await start();
  const discovers = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const inbound = new Request(url, init);
    const path = new URL(inbound.url).pathname.slice(1);
    const { id, method } = await inbound.json();
    if (method === 'server/discover') discovers.set(path, (discovers.get(path) ?? 0) + 1);
    return Response.json({ jsonrpc: '2.0', id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'],
      capabilities: {}, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0.0' } } } });
  });
  for (const mode of ['manual', 'on_connect', 'interval'] as const) {
    await runtime.createSource({ id: mode, name: mode, kind: 'mcp_http', config: {
      kind: 'mcp_http', url: 'https://upstream.example/' + mode,
    }, refreshPolicy: { mode, intervalSeconds: 0.05 } });
  }
  await rpc(runtime, token, 'server/discover');
  await vi.waitFor(() => expect(discovers.get('interval')).toBeGreaterThan(1));
  expect(discovers.get('on_connect')).toBe(2);
  expect(discovers.get('manual')).toBe(1);
  await runtime.refreshSource('manual');
  expect(discovers.get('manual')).toBe(2);
});
