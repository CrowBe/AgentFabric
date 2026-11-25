import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GetSkillResultSchema, ListSkillsResultSchema } from '@modelcontextprotocol/core/ext/skills';
import { expect, it, vi } from 'vitest';
import { addSource, api, cliSource, clientToken, composite, httpMcp, httpSource, json, mcpClient,
  startGateway, stdioSource, tempDir, track } from './harness.js';

it('challenges unauthenticated MCP and completes OAuth consent and S256 PKCE over HTTP', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  await addSource(gateway, { ...httpSource(upstream.mcpUrl), refreshPolicy: { mode: 'on_connect' } });
  await api(gateway, '/profiles', 'POST', { id: 'other', name: 'Other-harness' }, 201);
  const before = upstream.requests.length;
  const denied = await mcpClient(gateway).request('server/discover').response;
  expect(denied.status).toBe(401);
  const metadataUrl = `${gateway.url}/.well-known/oauth-protected-resource`;
  expect(denied.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${metadataUrl}"`);
  expect(await denied.json()).toMatchObject({ error: { data: { code: 'UNAUTHORIZED' } } });
  expect(upstream.requests).toHaveLength(before);

  const resource = await json<{ authorization_servers: string[] }>(await fetch(metadataUrl));
  expect(resource).toMatchObject({ resource: gateway.mcpUrl, authorization_servers: [gateway.url] });
  const issuer = resource.authorization_servers[0];
  const metadata = await json<{ registration_endpoint: string; authorization_endpoint: string; token_endpoint: string }>(
    await fetch(`${issuer}/.well-known/oauth-authorization-server`));
  expect(metadata).toMatchObject({ issuer, code_challenge_methods_supported: ['S256'],
    registration_endpoint: `${issuer}/oauth/register`, authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token` });
  const redirect = 'https://client.example/callback';
  const client = await json<{ client_id: string }>(await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E OAuth client', redirect_uris: [redirect] }),
  }), 201);
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    scope: 'mcp', resource: gateway.mcpUrl, state: 'client-state' }).toString();
  const consent = await fetch(authorize);
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain('E2E OAuth client');
  const approve = (operator_token: string) => fetch(authorize, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ decision: 'approve', operator_token }),
  });
  const unapproved = await approve('invalid-operator');
  expect(unapproved.status).toBe(401);
  expect(unapproved.headers.has('location')).toBe(false);
  await unapproved.text();
  const grant = async () => {
    const approved = await approve(gateway.operatorToken);
    expect(approved.status).toBe(303);
    const callback = new URL(approved.headers.get('location')!);
    await approved.text();
    expect(callback.origin + callback.pathname).toBe(redirect);
    expect(callback.searchParams.get('state')).toBe('client-state');
    expect(callback.searchParams.get('iss')).toBe(issuer);
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  };
  const exchange = (code: string, code_verifier: string) => fetch(metadata.token_endpoint, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier,
      client_id: client.client_id, redirect_uri: redirect, resource: gateway.mcpUrl }),
  });
  const wrong = await exchange(await grant(), randomBytes(32).toString('base64url'));
  expect(await json(wrong, 400)).toMatchObject({ error: 'invalid_grant' });
  const code = await grant();
  const token = await json<{ access_token: string; refresh_token: string }>(await exchange(code, verifier));
  expect(token).toMatchObject({ token_type: 'Bearer', scope: 'mcp', refresh_token: expect.any(String) });
  expect(await json(await exchange(code, verifier), 400)).toMatchObject({ error: 'invalid_grant' });

  const profileDenied = await mcpClient(gateway, undefined, 'other').request('server/discover').response;
  expect(profileDenied.status).toBe(401);
  expect(profileDenied.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${gateway.url}/.well-known/oauth-protected-resource/mcp/other"`,
  );

  await mcpClient(gateway, token.access_token, 'other').error('server/discover', {}, 'FORBIDDEN', 403);
  expect(upstream.requests).toHaveLength(before);
  const mcp = mcpClient(gateway, token.access_token);
  expect(await mcp.result('server/discover')).toMatchObject({ supportedVersions: ['2026-07-28'] });
  expect(upstream.requests.length).toBeGreaterThan(before);
  expect((await mcp.tool('http_echo', { value: 'authorized' })).content).toEqual([{ type: 'text', text: 'http:authorized' }]);

  await api(gateway, `/oauth-clients/${client.client_id}`, 'DELETE');
  await mcp.error('ping', {}, 'UNAUTHORIZED', 401);
  const refreshed = await fetch(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    }),
  });
  expect(refreshed.status).toBe(400);
});

it('serves tools, prompts, resources, and skills from one endpoint to the installed MCP SDK', async () => {
  const workspace = await tempDir();
  const originalCwd = process.cwd();
  process.chdir(workspace);
  track({ async close() { process.chdir(originalCwd); } });
  vi.stubEnv('HOME', workspace);
  vi.stubEnv('USERPROFILE', workspace);
  vi.stubEnv('XDG_CONFIG_HOME', join(workspace, '.config'));
  const upstream = await httpMcp();
  const gateway = await startGateway();
  const stdio = stdioSource(workspace);
  const cli = cliSource(workspace);
  const skill = '# Review\nCheck the project guide.';
  for (const input of [stdio.input, httpSource(upstream.mcpUrl), cli.input,
    { id: 'pipeline', name: 'Pipeline', kind: 'composite', config: composite('pooled_echo', 'http_echo') },
    { id: 'review', name: 'Review', kind: 'skill', config: {
      kind: 'skill', slug: 'review', title: 'Review', description: 'Review a project', content: skill,
    } },
  ] as const) expect((await addSource(gateway, input)).health).toBe('healthy');
  const client = new Client({ name: 'E2E SDK client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(gateway.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${await clientToken(gateway)}` }, signal: AbortSignal.timeout(8000) },
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'stdio_echo', 'http_echo', 'cli_echo', 'pooled_echo',
    ]));
    for (const prefix of ['stdio', 'http', 'cli']) {
      expect(await client.callTool({ name: `${prefix}_echo`, arguments: { value: 'one endpoint' } }))
        .toMatchObject({ content: [{ type: 'text', text: `${prefix}:one endpoint` }] });
    }
    expect(await client.callTool({ name: 'pooled_echo', arguments: { value: 'composite' } }))
      .toMatchObject({ structuredContent: { value: 'http:composite' } });
    expect(await stdio.calls()).toEqual(['stdio_echo']);
    expect(await cli.calls()).toEqual(['cli_echo']);
    expect(upstream.calls().map(call => call.params?.arguments)).toEqual([{ value: 'one endpoint' }, { value: 'composite' }]);
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['http_greet', 'skill:review', 'stdio_greet']);
    expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual(['http://guide', 'skill://review', 'stdio://guide']);
    for (const prefix of ['stdio', 'http']) {
      expect(await client.getPrompt({ name: `${prefix}_greet`, arguments: { name: 'operator' } }))
        .toMatchObject({ messages: [{ content: { text: `${prefix} says hello to operator` } }] });
      expect(await client.readResource({ uri: `${prefix}://guide` }))
        .toMatchObject({ contents: [{ uri: `${prefix}://guide`, text: `${prefix} fixture guide` }] });
    }
    const uri = 'skill://review';
    expect(await client.getPrompt({ name: 'skill:review' })).toMatchObject({ messages: [{ content: { text: skill } }] });
    expect(await client.readResource({ uri })).toMatchObject({ contents: [{ uri, text: skill }] });
    const entry = { uri, resources: [{ uri, digest: `sha256:${createHash('sha256').update(skill).digest('hex')}` }] };
    expect(await client.request({ method: 'skills/list' }, ListSkillsResultSchema)).toMatchObject({ skills: [entry] });
    expect(await client.request({ method: 'skills/get', params: { uri } }, GetSkillResultSchema)).toMatchObject({ skill: entry });
  } finally {
    await client.close();
  }
  for (const location of ['.claude', '.cursor', '.codex', '.agents', '.config']) {
    await expect(lstat(join(workspace, location))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('uses profile exposure to balance direct tools, searchable tools, and hidden capabilities', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  const stdio = stdioSource(await tempDir());
  await addSource(gateway, stdio.input);
  await addSource(gateway, httpSource(upstream.mcpUrl));
  await api(gateway, '/profiles', 'POST', { id: 'focused', name: 'Focused', rules: [
    { id: 'search-http', capabilityPattern: 'http_echo', exposure: 'searchable' },
    { id: 'hide-stdio-error', capabilityPattern: 'stdio_failure', exposure: 'hidden' },
  ] }, 201);
  const mcp = mcpClient(gateway, await clientToken(gateway, 'focused'), 'focused');
  const builtins = ['fabric_search', 'fabric_inspect', 'fabric_call', 'fabric_propose_capability'];
  expect(await mcp.toolNames()).toEqual([...builtins, 'stdio_echo']);
  const search = await mcp.tool('fabric_search', { kind: 'tool' });
  expect(search.structuredContent).toMatchObject({ capabilities: [
    { exposedName: 'http_echo', exposure: 'searchable', available: true },
    { exposedName: 'stdio_echo', exposure: 'direct', available: true },
  ] });
  expect(JSON.stringify(search)).not.toContain('stdio_failure');
  expect((await mcp.tool('fabric_inspect', { capability: 'http_echo' })).structuredContent).toMatchObject({
    exposedName: 'http_echo', inputSchema: { required: ['value'], additionalProperties: false }, available: true,
  });
  await mcp.error('tools/call', { name: 'http_echo', arguments: { value: 'direct' } }, 'CAPABILITY_NOT_FOUND');
  expect(upstream.calls()).toEqual([]);
  expect((await mcp.tool('fabric_call', { capability: 'http_echo', arguments: { value: 'discovered' } })).content)
    .toEqual([{ type: 'text', text: 'http:discovered' }]);
  expect((await mcp.error('tools/call', { name: 'stdio_failure' }, 'CAPABILITY_DENIED')).data)
    .toEqual({ code: 'CAPABILITY_DENIED' });
  for (const name of ['fabric_inspect', 'fabric_call']) {
    expect((await mcp.error('tools/call', { name, arguments: { capability: 'stdio_failure' } }, 'CAPABILITY_DENIED')).data)
      .toEqual({ code: 'CAPABILITY_DENIED' });
  }
  expect(await stdio.calls()).toEqual([]);
  const defaultProfile = mcpClient(gateway, await clientToken(gateway));
  expect(await defaultProfile.toolNames()).toEqual([...builtins, 'http_echo', 'stdio_echo', 'stdio_failure']);
});

it('isolates a crashing process, a disconnected listener, and malformed upstream HTTP', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  const unreachable = await httpMcp();
  await unreachable.close();
  const crash = stdioSource(await tempDir(), { id: 'crash', crash: true });
  expect((await addSource(gateway, httpSource(upstream.mcpUrl))).health).toBe('healthy');
  expect((await addSource(gateway, crash.input)).health).toBe('healthy');
  const mcp = mcpClient(gateway, await clientToken(gateway));
  expect((await mcp.tool('http_echo', { value: 'before failures' })).content)
    .toEqual([{ type: 'text', text: 'http:before failures' }]);
  expect((await addSource(gateway, httpSource(unreachable.mcpUrl, 'unreachable'))).health).toBe('degraded');
  expect((await addSource(gateway, httpSource(`${upstream.url}/malformed`, 'malformed'))).health).toBe('degraded');
  await mcp.error('tools/call', { name: 'stdio_echo', arguments: { value: 'crash' } }, 'UPSTREAM_ERROR');
  expect(await crash.calls()).toEqual(['stdio_echo']);
  expect((await mcp.tool('fabric_inspect', { capability: 'stdio_echo' })).structuredContent)
    .toMatchObject({ available: false, sourceHealth: 'degraded' });
  expect((await mcp.tool('fabric_search', { sourceId: 'malformed' })).structuredContent).toEqual({ capabilities: [] });
  expect((await mcp.tool('fabric_search', { sourceId: 'unreachable' })).structuredContent).toEqual({ capabilities: [] });
  expect((await mcp.tool('http_echo', { value: 'after failures' })).content)
    .toEqual([{ type: 'text', text: 'http:after failures' }]);
  expect((await mcp.tool('fabric_inspect', { capability: 'http_echo' })).structuredContent)
    .toMatchObject({ available: true, sourceHealth: 'healthy' });
});
