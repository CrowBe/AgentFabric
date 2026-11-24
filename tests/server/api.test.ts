import { describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, makeHarness, skillSource } from './helpers.js';

describe('operator API authentication (fail closed)', () => {
  it('rejects requests without credentials', async () => {
    const h = makeHarness();
    const { status, body, res } = await h.json('/api/status', { auth: false });
    expect(status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects wrong tokens, including on mutating routes', async () => {
    const h = makeHarness();
    for (const [method, path] of [
      ['GET', '/api/status'],
      ['POST', '/api/sources'],
      ['DELETE', '/api/sources/x'],
      ['PUT', '/api/secrets/token'],
      ['GET', '/api/config/export'],
    ] as const) {
      const res = await h.call(path, {
        method,
        auth: false,
        headers: { authorization: 'Bearer nope' },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('accepts the operator token via Authorization and x-operator-token', async () => {
    const h = makeHarness();
    expect((await h.call('/api/status')).status).toBe(200);
    const alt = await h.call('/api/status', {
      auth: false,
      headers: { 'x-operator-token': OPERATOR_TOKEN },
    });
    expect(alt.status).toBe(200);
  });

  it('does not accept ?token= on API routes including the approvals stream', async () => {
    const h = makeHarness();
    const res = await h.call(`/api/status?token=${OPERATOR_TOKEN}`, { auth: false });
    expect(res.status).toBe(401);
    expect((await h.call(`/api/approvals/stream?token=${OPERATOR_TOKEN}`, { auth: false })).status).toBe(401);
  });

  it('treats a throwing authenticator as unauthenticated', async () => {
    const h = makeHarness({
      wrap: (r) => ({
        ...r,
        authenticateOperator: () => {
          throw new Error('boom');
        },
      }),
    });
    expect((await h.call('/api/status')).status).toBe(401);
  });

  it('returns 401 before 404 for unknown API routes and JSON 404 when authenticated', async () => {
    const h = makeHarness();
    expect((await h.call('/api/nope', { auth: false })).status).toBe(401);
    const { status, body } = await h.json('/api/nope');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('marks API responses as uncacheable', async () => {
    const h = makeHarness();
    const res = await h.call('/api/status');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('sources', () => {
  it('creates, reads, patches, refreshes, tests and deletes a source', async () => {
    const h = makeHarness();
    const created = await h.json('/api/sources', { method: 'POST', json: skillSource() });
    expect(created.status).toBe(201);
    const id = created.body.source.id as string;

    expect((await h.json('/api/sources')).body.sources).toHaveLength(1);
    expect((await h.json(`/api/sources/${id}`)).body.source.name).toBe('review-skill');

    const patched = await h.json(`/api/sources/${id}`, {
      method: 'PATCH',
      json: { enabled: false },
    });
    expect(patched.body.source.health).toBe('disabled');

    const refreshed = await h.json(`/api/sources/${id}/refresh`, { method: 'POST' });
    expect(refreshed.body.capabilities.length).toBeGreaterThan(0);

    const tested = await h.json(`/api/sources/${id}/test`, { method: 'POST' });
    expect(tested.status).toBe(200);
    expect(tested.body).toHaveProperty('latencyMs');

    expect((await h.json(`/api/sources/${id}`, { method: 'DELETE' })).body).toEqual({ ok: true });
    expect((await h.json(`/api/sources/${id}`)).status).toBe(404);
  });

  it('rejects unexpected fields, kind mismatches, bad URLs and empty patches', async () => {
    const h = makeHarness();
    const unexpected = await h.json('/api/sources', {
      method: 'POST',
      json: { ...skillSource(), surprise: true },
    });
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.error.code).toBe('INVALID_INPUT');
    expect(unexpected.body.error.details.issues.length).toBeGreaterThan(0);

    const mismatch = await h.json('/api/sources', {
      method: 'POST',
      json: { ...skillSource(), kind: 'mcp_http' },
    });
    expect(mismatch.status).toBe(400);

    const badUrl = await h.json('/api/sources', {
      method: 'POST',
      json: {
        name: 'x',
        kind: 'mcp_http',
        config: { kind: 'mcp_http', url: 'file:///etc/passwd' },
      },
    });
    expect(badUrl.status).toBe(400);

    const created = await h.json('/api/sources', { method: 'POST', json: skillSource() });
    const empty = await h.json(`/api/sources/${created.body.source.id}`, {
      method: 'PATCH',
      json: {},
    });
    expect(empty.status).toBe(400);
  });

  it('rejects malformed JSON and missing bodies without echoing input', async () => {
    const h = makeHarness();
    const bad = await h.call('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": "secret-ish"',
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('secret-ish');
    expect((await h.call('/api/sources', { method: 'POST' })).status).toBe(400);
  });

  it('surfaces conflicts and not-found from the runtime with proper statuses', async () => {
    const h = makeHarness();
    await h.json('/api/sources', { method: 'POST', json: { ...skillSource(), id: 'dup' } });
    const dup = await h.json('/api/sources', {
      method: 'POST',
      json: { ...skillSource('other'), id: 'dup' },
    });
    expect(dup.status).toBe(409);
    expect((await h.json('/api/sources/missing/refresh', { method: 'POST' })).status).toBe(404);
    expect((await h.json('/api/sources/missing', { method: 'PATCH', json: { name: 'x' } })).status).toBe(404);
  });

  it('returns an auth handoff URL for sources missing credentials', async () => {
    const h = makeHarness();
    const created = await h.json('/api/sources', {
      method: 'POST',
      json: {
        name: 'needs-auth',
        kind: 'mcp_http',
        config: { kind: 'mcp_http', url: 'https://example.com/mcp' },
        authConfig: { kind: 'bearer_secret', secretName: 'needs_auth_token' },
      },
    });
    const tested = await h.json(`/api/sources/${created.body.source.id}/test`, { method: 'POST' });
    expect(tested.body.ok).toBe(false);
    expect(tested.body.health).toBe('auth_required');
    expect(tested.body.authHandoff.authUrl).toContain('/auth/connect/');
  });
});

describe('recipes', () => {
  it('lists the six generic starter recipes without build functions', async () => {
    const h = makeHarness();
    const { body } = await h.json('/api/recipes');
    expect(body.recipes.map((r: { id: string }) => r.id).sort()).toEqual(
      [
        'agent-skill',
        'cli-wrapper-readonly',
        'mcp-http-remote',
        'mcp-stdio-generic',
        'openconnector-http',
        'shared-workspace-folder',
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('build');
  });

  it('instantiates a recipe into a source', async () => {
    const h = makeHarness();
    const res = await h.json('/api/recipes/mcp-http-remote/instantiate', {
      method: 'POST',
      json: {
        values: { name: 'remote', url: 'https://example.com/mcp', secretName: 'remote_token' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.source.kind).toBe('mcp_http');
    expect(res.body.source.authConfig).toMatchObject({ kind: 'bearer_secret', secretName: 'remote_token' });
  });

  it('validates recipe input and unknown recipes', async () => {
    const h = makeHarness();
    const missing = await h.json('/api/recipes/mcp-http-remote/instantiate', {
      method: 'POST',
      json: { values: { name: 'x' } },
    });
    expect(missing.status).toBe(400);
    const extra = await h.json('/api/recipes/agent-skill/instantiate', {
      method: 'POST',
      json: { values: { name: 'x', slug: 's', title: 't', description: 'd', content: 'c', rm: '-rf' } },
    });
    expect(extra.status).toBe(400);
    const badJson = await h.json('/api/recipes/cli-wrapper-readonly/instantiate', {
      method: 'POST',
      json: {
        values: { name: 'x', toolName: 't', description: 'd', command: 'echo', inputSchema: '{nope' },
      },
    });
    expect(badJson.status).toBe(400);
    const unknown = await h.json('/api/recipes/nope/instantiate', { method: 'POST', json: { values: {} } });
    expect(unknown.status).toBe(404);
  });

  it('refuses local-only recipes in remote mode', async () => {
    const h = makeHarness({ mode: 'remote' });
    const res = await h.json('/api/recipes/cli-wrapper-readonly/instantiate', {
      method: 'POST',
      json: { values: { name: 'x', toolName: 't', description: 'd', command: 'echo' } },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REMOTE_CLI_FORBIDDEN');
    const ok = await h.json('/api/recipes/agent-skill/instantiate', {
      method: 'POST',
      json: { values: { name: 's', slug: 's', title: 't', description: 'd', content: 'c' } },
    });
    expect(ok.status).toBe(201);
  });
});

describe('capabilities and overlays', () => {
  it('lists, drafts, applies and clears overlays, including awkward ids', async () => {
    const h = makeHarness();
    const created = await h.json('/api/sources', { method: 'POST', json: { ...skillSource(), id: 'sk' } });
    expect(created.status).toBe(201);
    const list = await h.json('/api/capabilities?kind=skill');
    expect(list.body.capabilities).toHaveLength(1);
    const capId = list.body.capabilities[0].id as string;
    expect(capId).toContain(':');
    const enc = encodeURIComponent(capId);

    const draft = await h.json(`/api/capabilities/${enc}/overlay/draft`, {
      method: 'POST',
      json: { guidance: 'be terse' },
    });
    expect(draft.status).toBe(200);
    expect(draft.body.overlay.appliedByOperator).toBe(false);

    const applied = await h.json(`/api/capabilities/${enc}/overlay`, {
      method: 'PUT',
      json: { displayName: 'review', tags: ['qa'] },
    });
    expect(applied.body.overlay).toMatchObject({ displayName: 'review', appliedByOperator: true });

    const rejected = await h.json(`/api/capabilities/${enc}/overlay`, {
      method: 'PUT',
      json: { displayName: 'x', appliedByOperator: true },
    });
    expect(rejected.status).toBe(400);

    expect((await h.json(`/api/capabilities/${enc}/overlay`, { method: 'DELETE' })).body).toEqual({ ok: true });
    expect((await h.json('/api/capabilities/missing/overlay/draft', { method: 'POST' })).status).toBe(404);
  });

  it('rejects unknown query fields and bad kinds', async () => {
    const h = makeHarness();
    expect((await h.json('/api/capabilities?kind=banana')).status).toBe(400);
    expect((await h.json('/api/capabilities?evil=1')).status).toBe(400);
  });
});

describe('profiles and connect snippets', () => {
  it('runs profile CRUD', async () => {
    const h = makeHarness();
    const created = await h.json('/api/profiles', {
      method: 'POST',
      json: { name: 'work', defaultExposure: 'searchable', directToolBudget: 8 },
    });
    expect(created.status).toBe(201);
    const id = created.body.profile.id as string;
    const patched = await h.json(`/api/profiles/${id}`, { method: 'PATCH', json: { directToolBudget: 12 } });
    expect(patched.body.profile.directToolBudget).toBe(12);
    expect((await h.json('/api/profiles')).body.profiles.length).toBeGreaterThanOrEqual(2);
    expect((await h.json(`/api/profiles/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await h.json(`/api/profiles/${id}`)).status).toBe(404);
    expect((await h.json('/api/profiles/default', { method: 'DELETE' })).status).toBe(409);
  });

  it('rejects invalid profiles', async () => {
    const h = makeHarness();
    for (const json of [
      { name: 'bad name!' },
      { name: 'ok', directToolBudget: -1 },
      { name: 'ok', defaultExposure: 'hidden' },
      { name: 'ok', rules: [{ id: 'r', permission: 'maybe' }] },
    ]) {
      expect((await h.json('/api/profiles', { method: 'POST', json })).status).toBe(400);
    }
  });

  it('generates connect snippets for every harness without writing locally', async () => {
    const h = makeHarness({ publicUrl: 'https://gw.example.com/' });
    const { status, body } = await h.json('/api/profiles/default/connect-snippets');
    expect(status).toBe(200);
    expect(body.mcpUrl).toBe('https://gw.example.com/mcp/default');
    expect(body.localWrites).toBe('none');
    expect(body.snippets.map((s: { id: string }) => s.id)).toEqual([
      'claude-web',
      'claude-code',
      'codex',
      'cursor',
      'generic-mcp',
    ]);
    const all = JSON.stringify(body);
    expect(all).toContain('io.modelcontextprotocol/skills');
    expect(all).toContain('io.modelcontextprotocol/events');
    expect(all).toContain('2026-07-28');
    expect(all).not.toContain(OPERATOR_TOKEN);
    const claudeCode = body.snippets.find((s: { id: string }) => s.id === 'claude-code');
    expect(claudeCode.content).toContain('claude mcp add --transport http');
    expect(body.warnings).toEqual([]);
  });

  it('warns for loopback and plain-http public URLs, and 404s unknown profiles', async () => {
    const h = makeHarness({ publicUrl: 'http://127.0.0.1:7432' });
    const { body } = await h.json('/api/profiles/default/connect-snippets');
    expect(body.warnings.join(' ')).toContain('Claude on the web');
    const plain = makeHarness({ publicUrl: 'http://gw.example.com' });
    const warn = await plain.json('/api/profiles/default/connect-snippets');
    expect(warn.body.warnings.join(' ')).toContain('not HTTPS');
    expect((await h.json('/api/profiles/ghost/connect-snippets')).status).toBe(404);
  });
});

describe('tokens, OAuth clients and secrets', () => {
  it('mints a token once, lists without the raw value, and revokes it', async () => {
    const h = makeHarness();
    const minted = await h.json('/api/tokens', {
      method: 'POST',
      json: { label: 'cursor', profileId: 'default' },
    });
    expect(minted.status).toBe(201);
    const raw = minted.body.token as string;
    expect(raw).toMatch(/^af_tok_/);

    const listText = await (await h.call('/api/tokens')).text();
    expect(listText).not.toContain(raw);

    const mcp = await h.call('/mcp/default', {
      method: 'POST',
      auth: false,
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(mcp.status).toBe(200);

    expect((await h.json(`/api/tokens/${minted.body.record.id}`, { method: 'DELETE' })).status).toBe(200);
    const after = await h.call('/mcp/default', {
      method: 'POST',
      auth: false,
      headers: { authorization: `Bearer ${raw}` },
      body: '{}',
    });
    expect(after.status).toBe(401);
    expect((await h.json('/api/tokens/ghost', { method: 'DELETE' })).status).toBe(404);
    expect((await h.json('/api/tokens', { method: 'POST', json: { label: '', profileId: 'default' } })).status).toBe(400);
    expect((await h.json('/api/tokens', { method: 'POST', json: { label: 'x', profileId: 'ghost' } })).status).toBe(404);
  });

  it('lists OAuth clients registered over DCR', async () => {
    const h = makeHarness();
    const reg = await h.call('/oauth/register', {
      method: 'POST',
      auth: false,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }),
    });
    expect(reg.status).toBe(201);
    const { body } = await h.json('/api/oauth-clients');
    expect(body.clients[0].clientName).toBe('Claude');
  });

  it('keeps secrets write-only', async () => {
    const h = makeHarness();
    const value = 'sk-super-secret-value-123';
    const put = await h.call('/api/secrets/github_token', {
      method: 'PUT',
      json: { value, description: 'GitHub PAT' },
    });
    expect(put.status).toBe(200);
    expect(await put.clone().text()).not.toContain(value);
    const list = await h.call('/api/secrets');
    const text = await list.text();
    expect(text).not.toContain(value);
    expect(JSON.parse(text).secrets[0]).toMatchObject({ name: 'github_token', description: 'GitHub PAT' });
    expect((await h.json('/api/secrets/github_token', { method: 'DELETE' })).status).toBe(200);
    expect((await h.json('/api/secrets')).body.secrets).toEqual([]);
  });

  it('validates secret names and values without echoing them', async () => {
    const h = makeHarness();
    const badName = await h.call('/api/secrets/' + encodeURIComponent('../etc'), {
      method: 'PUT',
      json: { value: 'v' },
    });
    expect(badName.status).toBe(400);
    const empty = await h.call('/api/secrets/ok', { method: 'PUT', json: { value: '' } });
    expect(empty.status).toBe(400);
    const extra = await h.call('/api/secrets/ok', {
      method: 'PUT',
      json: { value: 'topsecret-xyz', reveal: true },
    });
    expect(extra.status).toBe(400);
    expect(await extra.text()).not.toContain('topsecret-xyz');
  });
});

describe('policies, approvals and proposals', () => {
  it('drafts, creates and deletes safety policies', async () => {
    const h = makeHarness();
    const draft = await h.json('/api/policies/draft', {
      method: 'POST',
      json: { description: 'Ask before deleting anything' },
    });
    expect(draft.body.policy.action).toBe('require_approval');
    const created = await h.json('/api/policies', {
      method: 'POST',
      json: { name: 'no deletes', capabilityPattern: '*delete*', action: 'deny' },
    });
    expect(created.status).toBe(201);
    expect((await h.json('/api/policies')).body.policies).toHaveLength(1);
    expect((await h.json(`/api/policies/${created.body.policy.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await h.json('/api/policies/ghost', { method: 'DELETE' })).status).toBe(404);
    expect((await h.json('/api/policies', { method: 'POST', json: { name: 'x', capabilityPattern: '*', action: 'nuke' } })).status).toBe(400);
    expect((await h.json('/api/policies/draft', { method: 'POST', json: { description: '' } })).status).toBe(400);
  });

  it('validates approval decisions and reports unknown approvals', async () => {
    const h = makeHarness();
    expect((await h.json('/api/approvals')).body.approvals).toEqual([]);
    expect((await h.json('/api/approvals?status=pending')).status).toBe(200);
    expect((await h.json('/api/approvals?status=bogus')).status).toBe(400);
    expect((await h.json('/api/approvals/a1/decide', { method: 'POST', json: { decision: 'maybe' } })).status).toBe(400);
    expect((await h.json('/api/approvals/a1/decide', { method: 'POST', json: { decision: 'approved' } })).status).toBe(404);
  });

  it('handles proposals: list, 404 on activate/reject of unknown ids', async () => {
    const h = makeHarness();
    expect((await h.json('/api/proposals')).body.proposals).toEqual([]);
    expect((await h.json('/api/proposals?status=pending_review')).status).toBe(200);
    expect((await h.json('/api/proposals/p1/activate', { method: 'POST' })).status).toBe(404);
    expect((await h.json('/api/proposals/p1/reject', { method: 'POST', json: { note: 'no' } })).status).toBe(404);
  });

  it('activates and rejects proposals through the runtime only after explicit calls', async () => {
    const proposal = {
      id: 'p1',
      kind: 'cli_wrapper' as const,
      name: 'drafted',
      description: 'd',
      definition: {
        kind: 'cli_wrapper' as const,
        toolName: 'echo_it',
        description: 'd',
        command: 'echo',
        argsTemplate: ['hi'],
        inputSchema: { type: 'object' },
      },
      status: 'pending_review' as const,
      createdAt: new Date().toISOString(),
    };
    const calls: string[] = [];
    const h = makeHarness({
      wrap: (r) => ({
        ...r,
        listProposals: async () => [proposal],
        activateProposal: async (id, note) => {
          calls.push(`activate:${id}:${note}`);
          const source = await r.createSource({ name: 'drafted', kind: 'cli_wrapper', config: proposal.definition });
          return { proposal: { ...proposal, status: 'activated' as const }, source };
        },
        rejectProposal: async (id, note) => {
          calls.push(`reject:${id}:${note}`);
          return { ...proposal, status: 'rejected' as const };
        },
      }),
    });
    expect((await h.json('/api/proposals')).body.proposals[0].id).toBe('p1');
    expect(calls).toEqual([]);
    const activated = await h.json('/api/proposals/p1/activate', { method: 'POST', json: { note: 'ok' } });
    expect(activated.body.proposal.status).toBe('activated');
    const rejected = await h.json('/api/proposals/p1/reject', { method: 'POST', json: {} });
    expect(rejected.body.proposal.status).toBe('rejected');
    expect(calls).toEqual(['activate:p1:ok', 'reject:p1:undefined']);
  });
});

describe('events', () => {
  it('lists types, emits events and pages occurrences by cursor', async () => {
    const h = makeHarness();
    expect((await h.json('/api/events/types')).body.eventTypes.length).toBeGreaterThan(0);
    const first = await h.json('/api/events/emit', {
      method: 'POST',
      json: { name: 'fabric.source.health_changed', data: { sourceId: 's', health: 'degraded' } },
    });
    expect(first.status).toBe(201);
    await h.json('/api/events/emit', { method: 'POST', json: { name: 'other.event', data: {} } });
    const all = await h.json('/api/events/occurrences');
    expect(all.body.occurrences).toHaveLength(2);
    const after = await h.json(`/api/events/occurrences?afterCursor=${first.body.occurrence.cursor}&limit=5`);
    expect(after.body.occurrences).toHaveLength(1);
    const named = await h.json('/api/events/occurrences?name=other.event');
    expect(named.body.occurrences).toHaveLength(1);
    expect((await h.json('/api/events/occurrences?limit=0')).status).toBe(400);
    expect((await h.json('/api/events/occurrences?limit=abc')).status).toBe(400);
    expect((await h.json('/api/events/emit', { method: 'POST', json: { name: 'x', data: 'str' } })).status).toBe(400);
    expect((await h.json('/api/events/emit', { method: 'POST', json: { data: {} } })).status).toBe(400);
  });

  it('lists and deletes subscriptions', async () => {
    const h = makeHarness();
    expect((await h.json('/api/events/subscriptions')).body.subscriptions).toEqual([]);
    expect((await h.json('/api/events/subscriptions/ghost', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('telemetry and config portability', () => {
  it('serves telemetry summary, events and hints', async () => {
    const h = makeHarness();
    const summary = await h.json('/api/telemetry/summary');
    expect(summary.body).toMatchObject({ totalCalls: 0, errorRate: 0 });
    expect((await h.json('/api/telemetry/events?limit=10')).body.events).toEqual([]);
    expect((await h.json('/api/telemetry/hints')).body.hints).toEqual([]);
    expect((await h.json('/api/telemetry/summary?since=yesterday')).status).toBe(400);
    expect((await h.json('/api/telemetry/events?limit=100000')).status).toBe(400);
  });

  it('round-trips a secret-free export/import', async () => {
    const h = makeHarness();
    await h.json('/api/sources', { method: 'POST', json: skillSource() });
    await h.call('/api/secrets/vault_item', { method: 'PUT', json: { value: 'never-exported-zzz' } });
    const exported = await h.call('/api/config/export');
    const text = await exported.text();
    expect(text).not.toContain('never-exported-zzz');
    const bundle = JSON.parse(text);
    expect(bundle.schemaVersion).toBe(1);

    const fresh = makeHarness();
    const imported = await fresh.json('/api/config/import', { method: 'POST', json: { bundle } });
    expect(imported.body.importedSources).toBe(1);
    expect((await fresh.json('/api/sources')).body.sources).toHaveLength(1);
  });

  it('rejects malformed bundles', async () => {
    const h = makeHarness();
    for (const json of [
      {},
      { bundle: { schemaVersion: 2, exportedAt: 'x', sources: [], overlays: [], profiles: [], policies: [] } },
      { bundle: { schemaVersion: 1, exportedAt: 'x', sources: [{ id: 1 }], overlays: [], profiles: [], policies: [] } },
      { bundle: { schemaVersion: 1, exportedAt: 'x', sources: [], overlays: [], profiles: [], policies: [], secrets: {} } },
    ]) {
      expect((await h.json('/api/config/import', { method: 'POST', json })).status).toBe(400);
    }
  });
});

describe('error handling', () => {
  it('maps GatewayError to its HTTP status and body', async () => {
    const { GatewayError } = await import('../../src/types/index.js');
    const h = makeHarness({
      wrap: (r) => ({
        ...r,
        getStatus: async () => {
          throw new GatewayError('UPSTREAM_ERROR', 'upstream broke', { details: { sourceId: 's' } });
        },
      }),
    });
    const { status, body } = await h.json('/api/status');
    expect(status).toBe(502);
    expect(body.error).toMatchObject({ code: 'UPSTREAM_ERROR', details: { sourceId: 's' } });
  });

  it('never leaks internal errors, stacks or secrets', async () => {
    const h = makeHarness({
      wrap: (r) => ({
        ...r,
        getStatus: async () => {
          throw new Error('connect ECONNREFUSED with password=hunter2');
        },
      }),
    });
    const res = await h.call('/api/status');
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('at ');
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
  });

  it('rejects oversized bodies', async () => {
    const h = makeHarness();
    const res = await h.call('/api/secrets/big', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(5 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
