import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { EncryptedSecretStore } from '../../src/storage/secrets.js';
import type { ApprovalRequestRecord, CapabilityProposalRecord } from '../../src/types/index.js';
import { addSource, api, cliSource, clientToken, composite, httpMcp, httpSource, json, mcpClient,
  startGateway, stdioSource, tempDir } from './harness.js';

it('rejects unexpected direct and fabric_call arguments before policy approval or an upstream call', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  await addSource(gateway, httpSource(upstream.mcpUrl));
  await api(gateway, '/policies', 'POST', { name: 'Approve HTTP echoes', capabilityPattern: 'http_echo', action: 'require_approval' }, 201);
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const args = { value: 'valid', unexpected: true };
  for (const [name, arguments_] of [
    ['http_echo', args], ['fabric_call', { capability: 'http_echo', arguments: args }],
  ] as const) {
    expect(await mcp.error('tools/call', { name, arguments: arguments_ }, 'INVALID_INPUT')).toMatchObject({ code: -32602 });
  }
  expect(await api(gateway, '/approvals')).toEqual({ approvals: [] });
  expect(upstream.calls()).toEqual([]);
});

it('hands credentials to the operator, stores them encrypted, and redacts secret-bearing upstream errors', async () => {
  const gateway = await startGateway();
  const secret = randomBytes(24).toString('hex');
  const localLogin = 'fixture-cli login';
  const stdio = stdioSource(await tempDir(), { auth: {
    kind: 'env_secrets', envMap: { FIXTURE_SECRET: 'stdio-key' }, cliLoginCommand: localLogin,
  } });
  expect((await addSource(gateway, stdio.input)).health).toBe('auth_required');
  await api(gateway, '/secrets/stdio-key', 'PUT', { value: secret });
  expect(await api(gateway, '/sources/stdio/refresh', 'POST')).toMatchObject({ source: { health: 'healthy' } });
  await api(gateway, '/secrets/stdio-key', 'DELETE');

  const mcp = mcpClient(gateway, await clientToken(gateway));
  const failure = await mcp.error('tools/call', { name: 'stdio_failure' }, 'AUTH_REQUIRED');
  expect(await stdio.calls()).toEqual([]);
  const handoff = failure.data.authHandoff as { authUrl: string };
  expect(handoff).toMatchObject({ sourceId: 'stdio', authUrl: expect.stringContaining(`${gateway.url}/auth/connect/stdio?ticket=`) });
  expect(failure.message).toContain(handoff.authUrl);
  expect(handoff).not.toHaveProperty('cliCommand');
  const authUrl = new URL(handoff.authUrl);
  const connect = await fetch(authUrl);
  expect(connect.status).toBe(200);
  const form = await connect.text();
  expect(form).toContain('stdio-key');
  expect(form).not.toContain(localLogin);
  const submit = () => fetch(`${authUrl.origin}${authUrl.pathname}`, {
    method: 'POST', body: new URLSearchParams({ ticket: authUrl.searchParams.get('ticket')!, secret_0: secret }),
  });
  const connected = await submit();
  expect(connected.status).toBe(200);
  const connectedPage = await connected.text();
  expect(connectedPage).toContain('<h1>Connected</h1>');
  expect(connectedPage).not.toContain(secret);
  const reused = await submit();
  expect(reused.status).toBe(403);
  await reused.text();
  expect(await api(gateway, '/sources/stdio')).toMatchObject({ source: { health: 'healthy' } });
  const error = await mcp.tool('stdio_failure');
  expect(error).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Credential rejected: [REDACTED]' }] });
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(await stdio.calls()).toEqual(['stdio_failure']);
  const secrets = await api(gateway, '/secrets');
  expect(secrets).toMatchObject({ secrets: [{ name: 'stdio-key' }] });
  expect(JSON.stringify(secrets)).not.toContain(secret);
  const vault = join(gateway.homeDir, 'secrets.enc');
  expect((await stat(vault)).mode & 0o777).toBe(0o600);
  expect((await readFile(vault)).includes(Buffer.from(secret))).toBe(false);
  expect(await (await EncryptedSecretStore.open(gateway.homeDir)).get('stdio-key')).toBe(secret);

  const cli = cliSource(await tempDir());
  await addSource(gateway, { ...cli.input, authConfig: {
    kind: 'env_secrets', envMap: { FIXTURE_SECRET: 'cli-key' }, cliLoginCommand: localLogin,
  } });
  const local = await api<{ authHandoff: { authUrl: string } }>(gateway, '/sources/cli/test', 'POST');
  expect(local).toMatchObject({ health: 'auth_required', authHandoff: { cliCommand: localLogin } });
  expect(await (await fetch(local.authHandoff.authUrl)).text()).toContain(localLogin);
  expect(await cli.calls()).toEqual([]);
});

it('holds an HTTP tool call for an approval, denies without calling upstream, and executes once when approved', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  await addSource(gateway, httpSource(upstream.mcpUrl));
  await api(gateway, '/policies', 'POST', { name: 'Gate HTTP echo', capabilityPattern: 'http_echo', action: 'require_approval' }, 201);
  const mcp = mcpClient(gateway, await clientToken(gateway));
  for (const decision of ['denied', 'approved'] as const) {
    let completed = false;
    const pending = mcp.reply<{ content: unknown[] }>('tools/call', { name: 'http_echo', arguments: { value: decision } })
      .finally(() => { completed = true; });
    void pending.catch(() => {});
    const approval = await vi.waitFor(async () => {
      const { approvals } = await api<{ approvals: ApprovalRequestRecord[] }>(gateway, '/approvals?status=pending');
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ toolName: 'http_echo', redactedArguments: { value: decision } });
      return approvals[0];
    }, { timeout: 3000 });
    expect(completed).toBe(false);
    expect(upstream.calls()).toEqual([]);
    expect(await api(gateway, `/approvals/${approval.id}/decide`, 'POST', { decision }))
      .toMatchObject({ approval: { id: approval.id, status: decision } });
    const reply = await pending;
    if (decision === 'denied') {
      expect(reply).toMatchObject({ error: { data: { code: 'APPROVAL_DENIED' } } });
      expect(upstream.calls()).toEqual([]);
    } else {
      expect(reply.result?.content).toEqual([{ type: 'text', text: 'http:approved' }]);
      expect(upstream.calls().map(call => call.params?.arguments)).toEqual([{ value: 'approved' }]);
    }
  }
});

it('keeps a proposed capability pending until an operator activates it over HTTP', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  await addSource(gateway, httpSource(upstream.mcpUrl));
  const token = await clientToken(gateway);
  const mcp = mcpClient(gateway, token);
  const definition = composite('pending_echo', 'http_echo');
  const { structuredContent: proposal } = await mcp.tool<CapabilityProposalRecord>('fabric_propose_capability', {
    name: 'Proposed echo', description: 'A reviewed composite', definition,
  });
  expect(proposal).toMatchObject({ id: expect.any(String), status: 'pending_review' });
  expect(await api(gateway, '/proposals?status=pending_review')).toMatchObject({ proposals: [{ id: proposal!.id }] });
  expect(await mcp.toolNames()).not.toContain(definition.toolName);
  const args = { name: definition.toolName, arguments: { value: 'reviewed' } };
  await mcp.error('tools/call', args, 'CAPABILITY_NOT_FOUND');
  const path = `/proposals/${proposal!.id}/activate`;
  const unauthorized = await fetch(`${gateway.url}/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  expect(await json(unauthorized, 401)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  expect(upstream.calls()).toEqual([]);
  expect(await api(gateway, path, 'POST', { note: 'Reviewed by operator' }))
    .toMatchObject({ proposal: { id: proposal!.id, status: 'activated' }, source: { health: 'healthy' } });
  expect(await mcp.toolNames()).toContain(definition.toolName);
  expect((await mcp.tool(args.name, args.arguments)).structuredContent).toEqual({ value: 'http:reviewed' });
  expect(upstream.calls()).toHaveLength(1);
});

it('blocks remote CLI registration and persisted CLI execution while serving bounded shared folders', async () => {
  const root = await tempDir();
  const share = join(root, 'share');
  await mkdir(share);
  await writeFile(join(root, 'private.txt'), 'private fixture');
  await writeFile(join(share, 'public.txt'), 'public fixture');
  await writeFile(join(share, 'too-large.txt'), 'x'.repeat(32));
  await writeFile(join(share, 'private.env'), 'excluded extension');
  await symlink(join(root, 'private.txt'), join(share, 'escape.txt'));

  const local = await startGateway();
  const cli = cliSource(root);
  await api(local, '/secrets/cli-key', 'PUT', { value: 'fixture-cli-credential' });
  const input = { ...cli.input, authConfig: {
    kind: 'env_secrets' as const, envMap: { FIXTURE_SECRET: 'cli-key' }, cliLoginCommand: 'fixture-cli login',
  } };
  expect((await addSource(local, input)).health).toBe('healthy');
  await api(local, '/secrets/cli-key', 'DELETE');
  await local.close();
  const gateway = await startGateway({ mode: 'remote', homeDir: local.homeDir });
  const rejected = await api(gateway, '/sources', 'POST', { ...input, id: 'remote-cli' }, 403);
  expect(rejected).toMatchObject({ error: { code: 'REMOTE_CLI_FORBIDDEN' } });
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const error = await mcp.error('tools/call', { name: 'cli_echo', arguments: { value: 'must not run' } }, 'REMOTE_CLI_FORBIDDEN');
  const checked = await api(gateway, '/sources/cli/test', 'POST');
  expect(checked).toMatchObject({ ok: false });
  expect(JSON.stringify([rejected, error, checked])).not.toMatch(/cliCommand|fixture-cli login/);
  expect(await cli.calls()).toEqual([]);

  await addSource(gateway, { id: 'share', name: 'Share', kind: 'shared_folder', config: {
    kind: 'shared_folder', shareName: 'repo', rootPath: share, readOnly: true, allowedExtensions: ['.txt'], maxFileBytes: 20,
  } });
  const read = (uri: string) => mcp.result<{ contents: { uri: string; text: string }[] }>('resources/read', { uri });
  const listing = await read('workspace://repo/');
  expect(JSON.parse(listing.contents[0].text)).toEqual([
    { name: 'public.txt', path: 'public.txt', uri: 'workspace://repo/public.txt', kind: 'file' },
    { name: 'too-large.txt', path: 'too-large.txt', uri: 'workspace://repo/too-large.txt', kind: 'file' },
  ]);
  expect(await read('workspace://repo/public.txt')).toMatchObject({ contents: [{ text: 'public fixture' }] });
  for (const uri of ['workspace://repo/../private.txt', 'workspace://repo/%2E%2E/private.txt', 'workspace://repo/escape.txt']) {
    await mcp.error('resources/read', { uri }, 'PATH_OUTSIDE_SHARE');
  }
  await mcp.error('resources/read', { uri: 'workspace://repo/too-large.txt' }, 'INVALID_INPUT');
  await mcp.error('resources/read', { uri: 'workspace://repo/private.env' }, 'FORBIDDEN');
  await expect(api(gateway, '/sources', 'POST', {
    id: 'remote-stdio', name: 'Remote stdio', kind: 'mcp_stdio', config: { kind: 'mcp_stdio', command: 'node', args: ['-v'] },
  }, 403)).resolves.toMatchObject({ error: { code: 'REMOTE_CLI_FORBIDDEN' } });
});

it('expires pending approvals and aborts upstream execution if caller cancels', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  await addSource(gateway, httpSource(upstream.mcpUrl));
  await api(gateway, '/policies', 'POST', { name: 'Gate HTTP echo', capabilityPattern: 'http_echo', action: 'require_approval' }, 201);
  const token = await clientToken(gateway);
  const mcp = mcpClient(gateway, token);
  const { id, response } = mcp.request('tools/call', { name: 'http_echo', arguments: { value: 'cancelled' } });
  const approval = await vi.waitFor(async () => {
    const { approvals } = await api<{ approvals: ApprovalRequestRecord[] }>(gateway, '/approvals?status=pending');
    expect(approvals).toHaveLength(1);
    return approvals[0];
  }, { timeout: 3000 });
  await fetch(gateway.mcpUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }),
  });
  const reply = await json<{ error?: { data?: { code?: string } } }>(await response);
  expect(reply.error?.data?.code).toBe('APPROVAL_TIMEOUT');
  expect((await api<{ approval: ApprovalRequestRecord }>(gateway, `/approvals/${approval.id}/decide`, 'POST', { decision: 'approved' }, 409)))
    .toMatchObject({ error: { code: 'CONFLICT' } });
  expect(upstream.calls()).toEqual([]);
});
