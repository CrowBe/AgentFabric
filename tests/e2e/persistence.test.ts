import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { DuckDbTraceStore } from '../../src/storage/trace-db.js';
import type { EffectiveCapability, NormalizationOverlay, PortableConfigBundle, ProfileRecord, SafetyPolicyRule } from '../../src/types/index.js';
import { listen } from './fixtures/http.js';
import { addSource, api, clientToken, httpMcp, httpSource, mcpClient, startGateway, track } from './harness.js';

async function echoCapability(gateway: Awaited<ReturnType<typeof startGateway>>) {
  const { capabilities } = await api<{ capabilities: EffectiveCapability[] }>(gateway, '/capabilities?sourceId=http&kind=tool');
  expect(capabilities).toEqual([expect.objectContaining({ originalName: 'http_echo' })]);
  return capabilities[0];
}

it('returns the actual tool output if a DuckDB trace append fails', async () => {
  const upstream = await httpMcp();
  const append = vi.fn(async () => { throw new Error('Fixture trace write failure'); });
  const gateway = await startGateway({
    createRuntime: async options => {
      const traceStore = await DuckDbTraceStore.open(options.homeDir);
      vi.spyOn(traceStore, 'append').mockImplementation(append);
      return createGatewayRuntime({ ...options, traceStore });
    },
  });
  await addSource(gateway, httpSource(upstream.mcpUrl));
  const mcp = mcpClient(gateway, await clientToken(gateway));
  expect((await mcp.tool('http_echo', { value: 'completed result' })).content)
    .toEqual([{ type: 'text', text: 'http:completed result' }]);
  expect(upstream.calls()).toHaveLength(1);
  expect(append).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ toolName: 'http_echo', status: 'ok' }));
  expect(await api(gateway, '/telemetry/summary')).toMatchObject({ totalCalls: 0 });
});

it('drafts an overlay without changing exposed tools and applies only the operator-reviewed descriptions', async () => {
  const proposed = { description: 'Return the supplied HTTP value.', semanticGroup: 'Utilities',
    parameterDescriptions: { value: 'The exact value to echo.' } };
  const modelRequests: unknown[] = [];
  const model = track(await listen(async request => {
    modelRequests.push(await request.json());
    return Response.json({ choices: [{ message: { content: JSON.stringify(proposed) } }] });
  }));
  const upstream = await httpMcp();
  const gateway = await startGateway({ llm: { provider: 'openai', model: 'fixture-draft', apiUrl: `${model.url}/draft` } });
  await addSource(gateway, httpSource(upstream.mcpUrl));
  const { id } = await echoCapability(gateway);
  const mcp = mcpClient(gateway, await clientToken(gateway));
  const original = await mcp.result('tools/list');
  const path = `/capabilities/${id}/overlay`;
  const { overlay: draft } = await api<{ overlay: NormalizationOverlay }>(gateway, `${path}/draft`, 'POST', {
    guidance: 'Keep the upstream operation and its required argument.',
  });
  expect(modelRequests).toHaveLength(1);
  expect(draft).toMatchObject({ ...proposed, displayName: 'http_echo', appliedByOperator: false, draftedBy: 'llm' });
  expect(await mcp.result('tools/list')).toEqual(original);
  expect(await echoCapability(gateway)).toMatchObject({ hasOverlay: false });

  const operatorDescription = 'Echo a value through the HTTP fixture.';
  const { displayName, semanticGroup, parameterDescriptions } = draft;
  expect(await api(gateway, path, 'PUT', { displayName, semanticGroup, parameterDescriptions, description: operatorDescription }))
    .toMatchObject({ overlay: { appliedByOperator: true, description: operatorDescription } });
  expect(await mcp.result('tools/list')).toMatchObject({ tools: expect.arrayContaining([{
    name: 'http_echo', description: operatorDescription, inputSchema: { type: 'object', required: ['value'],
      additionalProperties: false, properties: { value: { type: 'string', description: proposed.parameterDescriptions.value } } },
  }]) });
  expect((await mcp.tool('http_echo', { value: 'unchanged input' })).content)
    .toEqual([{ type: 'text', text: 'http:unchanged input' }]);
  expect(upstream.calls().map(call => call.params?.arguments)).toEqual([{ value: 'unchanged input' }]);
});

it('exports no credentials and restores sources, overlays, profiles, and safety policies into fresh stores', async () => {
  const upstream = await httpMcp();
  const gateway = await startGateway();
  const credential = randomBytes(24).toString('hex');
  const protectedUpstream = await httpMcp({ bearer: credential });
  await api(gateway, '/secrets/service-key', 'PUT', { value: credential });
  await addSource(gateway, { ...httpSource(upstream.mcpUrl), refreshPolicy: { mode: 'on_connect' } });
  expect((await addSource(gateway, { ...httpSource(protectedUpstream.mcpUrl, 'protected'), authConfig: {
    kind: 'bearer_secret', secretName: 'service-key',
  } })).health).toBe('healthy');
  const cap = await echoCapability(gateway);
  await api(gateway, `/capabilities/${cap.id}/overlay`, 'PUT', { description: 'Portable HTTP echo', semanticGroup: 'Utilities' });
  const { profile } = await api<{ profile: ProfileRecord }>(gateway, '/profiles', 'POST', { id: 'portable', name: 'Portable',
    rules: [{ id: 'keep-searchable', sourceId: 'http', exposure: 'searchable' }],
  }, 201);
  const { policy } = await api<{ policy: SafetyPolicyRule }>(gateway, '/policies', 'POST', {
    name: 'Gate portable HTTP', profileId: profile.id, capabilityPattern: 'http_echo', action: 'require_approval',
  }, 201);
  const oldToken = await clientToken(gateway, profile.id);
  const bundle = await api<PortableConfigBundle>(gateway, '/config/export');
  expect(JSON.stringify(bundle)).not.toContain(credential);
  expect(JSON.stringify(bundle)).not.toContain(oldToken);
  expect(bundle).toMatchObject({ schemaVersion: 1, sources: expect.arrayContaining([
    expect.objectContaining({ id: 'protected', authConfig: { kind: 'bearer_secret', secretName: 'service-key' } }),
  ]), profiles: expect.arrayContaining([profile]), policies: [policy], overlays: [{ capabilityId: cap.id, appliedByOperator: true }] });

  const imported = await startGateway();
  expect(imported.homeDir).not.toBe(gateway.homeDir);
  expect(await api(imported, '/sources')).toEqual({ sources: [] });
  await api(imported, '/config/import', 'POST', { bundle, merge: false });
  expect(await api(imported, '/secrets')).toEqual({ secrets: [] });
  expect(await api(imported, '/profiles/portable')).toEqual({ profile });
  expect(await api(imported, '/policies')).toEqual({ policies: [policy] });
  expect(await api(imported, '/sources')).toMatchObject({ sources: [
    { id: 'http' }, { id: 'protected', authConfig: { secretName: 'service-key' } },
  ] });
  expect(await api(imported, '/config/export')).toMatchObject({ sources: bundle.sources, overlays: bundle.overlays,
    profiles: bundle.profiles, policies: bundle.policies });
  await mcpClient(imported, oldToken, profile.id).error('ping', {}, 'UNAUTHORIZED', 401);
  const mcp = mcpClient(imported, await clientToken(imported, profile.id), profile.id);
  await mcp.result('server/discover');
  expect(await mcp.toolNames()).not.toContain('http_echo');
  expect((await mcp.tool('fabric_inspect', { capability: 'http_echo' })).structuredContent).toMatchObject({
    id: cap.id, description: 'Portable HTTP echo', semanticGroup: 'Utilities', hasOverlay: true,
    exposure: 'searchable', permission: 'require_approval', available: true,
  });
  expect(await api(imported, '/telemetry/summary')).toMatchObject({ totalCalls: 1, errorCount: 0 });
  for (const filename of ['state.db', 'traces.duckdb', 'master.key']) {
    expect((await stat(join(imported.homeDir, filename))).isFile()).toBe(true);
  }
});

it('imports local cli_wrapper and mcp_stdio sources disabled by default without executing commands', async () => {
  const { cliSource, tempDir } = await import('./harness.js');
  const workspace = await tempDir();
  const cli = cliSource(workspace);
  const source = { ...cli.input, id: 'cli-bundle', enabled: true };
  const target = await startGateway();
  const baseBundle = await api<PortableConfigBundle>(target, '/config/export');
  const importedBundle: PortableConfigBundle = {
    ...baseBundle,
    sources: [{
      id: source.id,
      name: source.name,
      kind: 'cli_wrapper',
      enabled: true,
      config: source.config,
      authConfig: { kind: 'none' },
      refreshPolicy: { mode: 'manual' },
    }],
  };
  await api(target, '/config/import', 'POST', { bundle: importedBundle, merge: true });
  expect(await api(target, `/sources/${source.id}`)).toMatchObject({
    source: { id: source.id, enabled: false, health: 'disabled' },
  });
  expect(await cli.calls()).toEqual([]);
});
