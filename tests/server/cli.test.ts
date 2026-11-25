import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli/index.js';
import { OPERATOR_TOKEN, makeHarness, skillSource } from './helpers.js';

function bench(overrides: Partial<CliIo> = {}) {
  const h = makeHarness();
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const calls: Array<{ url: string; auth: string | null }> = [];
  const io: Partial<CliIo> = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { AGENTFABRIC_OPERATOR_TOKEN: OPERATOR_TOKEN },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return h.runtime && (await h.call(new URL(url).pathname + new URL(url).search, { ...init, auth: false }));
    }) as typeof fetch,
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    readStoredToken: async () => undefined,
    ...overrides,
  };
  return { h, io, out: () => out.join(''), err: () => err.join(''), files, calls };
}

describe('agentfabric CLI', () => {
  it('prints help and rejects unknown commands/options', async () => {
    const b = bench();
    expect(await runCli([], b.io)).toBe(0);
    expect(b.out()).toContain('agentfabric <command>');
    const unknown = bench();
    expect(await runCli(['frobnicate'], unknown.io)).toBe(1);
    expect(unknown.err()).toContain("Unknown command 'frobnicate'");
    const badFlag = bench();
    expect(await runCli(['status', '--nope'], badFlag.io)).toBe(2);
  });

  it('lists starter recipes without a gateway or token', async () => {
    const b = bench({ env: {}, fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch });
    expect(await runCli(['recipes', 'list'], b.io)).toBe(0);
    for (const id of ['mcp-stdio-generic', 'mcp-http-remote', 'mcp-http-oauth', 'openconnector-http', 'cli-wrapper-readonly', 'shared-workspace-folder', 'agent-skill', 'github-skill-repo']) {
      expect(b.out()).toContain(id);
    }
    const json = bench({ env: {} });
    await runCli(['recipes', 'list', '--json'], json.io);
    expect(JSON.parse(json.out()).recipes).toHaveLength(8);
  });

  it('imports and lists GitHub skills and manages capability proposals', async () => {
    const b = bench();
    expect(
      await runCli(
        ['skills', 'add', 'https://github.com/kunchenguid/vision', '--name', 'vision', '--tag', 'strategy'],
        b.io,
      ),
    ).toBe(0);
    expect(b.out()).toContain('Imported 1 skill(s) from vision');

    const listed = bench({ fetch: b.io.fetch });
    expect(await runCli(['skills', 'list'], listed.io)).toBe(0);
    expect(listed.out()).toContain('skill://vision');

    const prop = await b.h.runtime.exportConfig();
    expect(prop.sources[0]?.kind).toBe('skill_repo');

    const proposal = await b.h.json('/api/proposals');
    expect(proposal.status).toBe(200);
    expect(await runCli(['proposals', 'list'], bench({ fetch: b.io.fetch }).io)).toBe(0);
    const badActivate = bench({ fetch: b.io.fetch });
    expect(await runCli(['proposals', 'activate', 'missing'], badActivate.io)).toBe(1);
    expect(badActivate.err()).toContain('404');
  });

  it('shows status using the operator token', async () => {
    const b = bench();
    expect(await runCli(['status'], b.io)).toBe(0);
    expect(b.out()).toContain('Gateway healthy');
    expect(b.out()).toContain('sources');
    expect(b.calls.every((c) => c.url.startsWith('http://127.0.0.1:7432'))).toBe(true);
    expect(b.calls.some((c) => c.auth === `Bearer ${OPERATOR_TOKEN}`)).toBe(true);
  });

  it('fails clearly without a token, with a wrong token, and when the gateway is down', async () => {
    const none = bench({ env: {} });
    expect(await runCli(['status'], none.io)).toBe(1);
    expect(none.err()).toContain('No operator token');

    const wrong = bench({ env: { AGENTFABRIC_OPERATOR_TOKEN: 'bad' } });
    expect(await runCli(['approvals', 'list'], wrong.io)).toBe(1);
    expect(wrong.err()).toContain('Operator authentication failed');
    expect(wrong.err()).not.toContain('bad\n');

    const down = bench({ fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch });
    expect(await runCli(['status'], down.io)).toBe(1);
    expect(down.err()).toContain('Cannot reach the gateway');
  });

  it('falls back to the stored token and honours --url/--token', async () => {
    const stored = bench({ env: {}, readStoredToken: async () => OPERATOR_TOKEN });
    expect(await runCli(['status'], stored.io)).toBe(0);
    const flags = bench({ env: {} });
    expect(await runCli(['status', '--url', 'http://gw.local:9/', '--token', OPERATOR_TOKEN], flags.io)).toBe(0);
    expect(flags.calls[0]?.url).toBe('http://gw.local:9/healthz');
  });

  it('mints a token for a profile and reminds that it is shown once', async () => {
    const b = bench();
    expect(await runCli(['token', 'create', '--profile', 'default', '--label', 'laptop'], b.io)).toBe(0);
    expect(b.out()).toMatch(/af_tok_/);
    expect(b.out()).toContain('shown only once');
    const missing = bench();
    expect(await runCli(['token', 'create'], missing.io)).toBe(1);
    const ghost = bench();
    expect(await runCli(['token', 'create', '--profile', 'ghost'], ghost.io)).toBe(1);
    expect(ghost.err()).toContain('404');
  });

  it('exports to a file and imports it back, merging by default', async () => {
    const source = bench();
    await source.h.json('/api/sources', { method: 'POST', json: skillSource() });
    expect(await runCli(['export', '--out', 'bundle.json'], source.io)).toBe(0);
    const bundle = source.files.get('bundle.json') as string;
    expect(JSON.parse(bundle).sources).toHaveLength(1);

    const target = bench();
    target.files.set('in.json', bundle);
    expect(await runCli(['import', 'in.json'], target.io)).toBe(0);
    expect(target.out()).toContain('Imported 1 sources');
    expect((await target.h.json('/api/sources')).body.sources).toHaveLength(1);

    const bad = bench();
    bad.files.set('bad.json', '{"schemaVersion": 9}');
    expect(await runCli(['import', 'bad.json'], bad.io)).toBe(1);
    expect(bad.err()).toContain('400');
    const notJson = bench();
    notJson.files.set('x.json', 'nope');
    expect(await runCli(['import', 'x.json'], notJson.io)).toBe(1);
    expect(await runCli(['import', 'missing.json'], bench().io)).toBe(1);
  });

  it('prints export to stdout when --out is omitted', async () => {
    const b = bench();
    await runCli(['export'], b.io);
    expect(JSON.parse(b.out()).schemaVersion).toBe(1);
  });

  it('lists approvals and reports decisions on unknown ones', async () => {
    const b = bench();
    expect(await runCli(['approvals', 'list'], b.io)).toBe(0);
    expect(b.out()).toContain('No approvals.');
    const decide = bench();
    expect(await runCli(['approvals', 'approve', 'nope'], decide.io)).toBe(1);
    expect(decide.err()).toContain('404');
    expect(await runCli(['approvals', 'deny'], bench().io)).toBe(1);
    expect(await runCli(['approvals', 'list', '--status', 'bogus'], bench().io)).toBe(1);
  });

  it('emits and lists events', async () => {
    const b = bench();
    expect(await runCli(['events', 'emit', 'demo.event', '--data', '{"a":1}', '--source', 'src1'], b.io)).toBe(0);
    expect(b.out()).toContain('Emitted demo.event');
    const list = bench();
    list.h.runtime.emitEvent({ name: 'x', data: {} });
    expect(await runCli(['events', 'list'], list.io)).toBe(0);
    const badData = bench();
    expect(await runCli(['events', 'emit', 'x', '--data', '{nope'], badData.io)).toBe(1);
    expect(badData.err()).toContain('--data must be valid JSON');
  });

  it('delegates start to the server launcher and validates its options', async () => {
    const seen: unknown[] = [];
    const b = bench({ startServer: async (o) => void seen.push(o) });
    expect(await runCli(['start', '--port', '9001', '--host', '0.0.0.0', '--mode', 'remote', '--public-url', 'https://gw.example.com'], b.io)).toBe(0);
    expect(seen[0]).toEqual({ port: 9001, host: '0.0.0.0', mode: 'remote', publicUrl: 'https://gw.example.com' });
    expect(await runCli(['start', '--port', 'abc'], bench().io)).toBe(1);
    expect(await runCli(['start', '--mode', 'cloud'], bench().io)).toBe(1);
  });
});
