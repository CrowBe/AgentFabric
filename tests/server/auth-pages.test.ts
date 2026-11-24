import { describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, makeHarness, type Harness } from './helpers.js';

async function sourceNeedingAuth(h: Harness, name = 'upstream') {
  const created = await h.json('/api/sources', {
    method: 'POST',
    json: {
      name,
      kind: 'mcp_http',
      config: { kind: 'mcp_http', url: 'https://example.com/mcp' },
      authConfig: {
        kind: 'bearer_secret',
        secretName: 'upstream_token',
        requiredSecrets: ['upstream_token', 'upstream_extra'],
        instructions: 'Create a token at <https://example.com/tokens>',
      },
    },
  });
  const id = created.body.source.id as string;
  const tested = await h.json(`/api/sources/${id}/test`, { method: 'POST' });
  const url = new URL(tested.body.authHandoff.authUrl as string);
  return { id, ticket: url.searchParams.get('ticket') as string, path: url.pathname };
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  auth: false,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

describe('upstream auth handoff page', () => {
  it('renders a locked-down form for a valid ticket', async () => {
    const h = makeHarness();
    const { path, ticket } = await sourceNeedingAuth(h);
    const res = await h.call(`${path}?ticket=${ticket}`, { auth: false });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('upstream_token');
    expect(html).toContain('upstream_extra');
    expect(html).toMatch(/type="password"/);
    expect(html).toContain(`value="${ticket}"`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).not.toContain('<https://example.com/tokens>');
    expect(html).toContain('&lt;https://example.com/tokens&gt;');
  });

  it('escapes hostile source names', async () => {
    const h = makeHarness();
    const { path, ticket } = await sourceNeedingAuth(h, '<img src=x onerror=alert(1)>"\'');
    const html = await (await h.call(`${path}?ticket=${ticket}`, { auth: false })).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('rejects missing, wrong and cross-source tickets with the same generic page', async () => {
    const h = makeHarness();
    const a = await sourceNeedingAuth(h, 'a');
    const b = await sourceNeedingAuth(h, 'b');
    for (const url of [
      a.path,
      `${a.path}?ticket=wrong`,
      `${a.path}?ticket=${b.ticket}`,
      '/auth/connect/ghost?ticket=x',
    ]) {
      const res = await h.call(url, { auth: false });
      expect(res.status, url).toBe(403);
      const html = await res.text();
      expect(html).toContain('Link expired');
      expect(html).not.toContain('upstream_token');
    }
  });

  it('stores submitted secrets without echoing them and burns the ticket', async () => {
    const h = makeHarness();
    const { id, ticket, path } = await sourceNeedingAuth(h);
    const res = await h.call(path, form({ ticket, secret_0: 'tok-AAA-111', secret_1: 'ext-BBB-222' }));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Connected');
    expect(html).not.toContain('tok-AAA-111');
    expect(html).not.toContain('ext-BBB-222');

    const secrets = await (await h.call('/api/secrets')).text();
    expect(secrets).toContain('upstream_token');
    expect(secrets).not.toContain('tok-AAA-111');
    expect((await h.json(`/api/sources/${id}`)).body.source.health).toBe('healthy');

    const replay = await h.call(path, form({ ticket, secret_0: 'x', secret_1: 'y' }));
    expect(replay.status).toBe(403);
  });

  it('rejects incomplete submissions without echoing values and keeps the ticket usable', async () => {
    const h = makeHarness();
    const { ticket, path } = await sourceNeedingAuth(h);
    const res = await h.call(path, form({ ticket, secret_0: 'only-the-first-value', secret_1: '   ' }));
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).toContain('A value for upstream_extra is required.');
    expect(html).not.toContain('only-the-first-value');
    expect((await h.json('/api/secrets')).body.secrets).toEqual([]);
    const ok = await h.call(path, form({ ticket, secret_0: 'a', secret_1: 'b' }));
    expect(ok.status).toBe(200);
  });

  it('cannot be used to write arbitrary secret names', async () => {
    const h = makeHarness();
    const { ticket, path } = await sourceNeedingAuth(h);
    const res = await h.call(path, form({ ticket, secret_0: 'a', secret_1: 'b', secret_9: 'evil', operator_token: 'x', 'secret_name': 'admin' }));
    expect(res.status).toBe(200);
    const names = (await h.json('/api/secrets')).body.secrets.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['upstream_extra', 'upstream_token']);
  });

  it('refuses oversized submissions', async () => {
    const h = makeHarness();
    const { ticket, path } = await sourceNeedingAuth(h);
    const res = await h.call(path, form({ ticket, secret_0: 'x'.repeat(200_000), secret_1: 'y' }));
    expect(res.status).toBe(413);
  });

  it('does not need operator credentials, since the ticket is the capability', async () => {
    const h = makeHarness();
    const { path, ticket } = await sourceNeedingAuth(h);
    expect((await h.call(`${path}?ticket=${ticket}`, { auth: false })).status).toBe(200);
  });
});

async function registerClient(h: Harness, name = 'Claude', redirect = 'https://claude.ai/api/mcp/auth_callback') {
  const res = await h.call('/oauth/register', {
    method: 'POST',
    auth: false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
  });
  return (await res.json()).client_id as string;
}

const authorizeQuery = (clientId: string, extra: Record<string, string> = {}) =>
  '/oauth/authorize?' +
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'abc123',
    code_challenge_method: 'S256',
    state: 'st-1',
    ...extra,
  }).toString();

describe('OAuth consent page', () => {
  it('shows the consent form for a valid request and escapes client names', async () => {
    const h = makeHarness();
    const id = await registerClient(h, '<script>alert(1)</script>');
    const res = await h.call(authorizeQuery(id), { auth: false });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('name="operator_token"');
    expect(html).toMatch(/<style nonce="[^"]+"/);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('fails closed on bad parameters without redirecting', async () => {
    const h = makeHarness();
    const id = await registerClient(h);
    const cases = [
      '/oauth/authorize',
      authorizeQuery('ghost'),
      authorizeQuery(id, { redirect_uri: 'https://evil.example/cb' }),
      authorizeQuery(id, { code_challenge: '' }),
    ];
    for (const url of cases) {
      const res = await h.call(url, { auth: false });
      expect(res.status, url).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    }
    const post = await h.call(authorizeQuery('ghost'), form({ decision: 'approve', operator_token: OPERATOR_TOKEN }));
    expect(post.status).toBe(400);
    expect(post.headers.get('location')).toBeNull();
  });

  it('refuses approval without a valid operator token', async () => {
    const h = makeHarness();
    const id = await registerClient(h);
    for (const token of ['', 'wrong']) {
      const res = await h.call(authorizeQuery(id), form({ decision: 'approve', operator_token: token }));
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('not accepted');
    }
  });

  it('redirects with a code and state after operator approval', async () => {
    const h = makeHarness();
    const id = await registerClient(h);
    const res = await h.call(authorizeQuery(id), form({ decision: 'approve', operator_token: OPERATOR_TOKEN }));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(location.searchParams.get('code')).toMatch(/^code_/);
    expect(location.searchParams.get('state')).toBe('st-1');
  });

  it('redirects denial back with access_denied and requires a decision', async () => {
    const h = makeHarness();
    const id = await registerClient(h);
    const deny = await h.call(authorizeQuery(id), form({ decision: 'deny' }));
    expect(deny.status).toBe(303);
    const location = new URL(deny.headers.get('location') as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('st-1');
    expect(location.searchParams.get('code')).toBeNull();
    const none = await h.call(authorizeQuery(id), form({ operator_token: OPERATOR_TOKEN }));
    expect(none.status).toBe(400);
  });

  it('refuses to redirect to script-like URLs even when registered', async () => {
    const h = makeHarness();
    const evil = 'javascript:alert(document.cookie)//';
    const id = await registerClient(h, 'Evil', evil);
    const url =
      '/oauth/authorize?' +
      new URLSearchParams({
        client_id: id,
        redirect_uri: evil,
        code_challenge: 'abc',
        response_type: 'code',
      });
    const res = await h.call(url, form({ decision: 'approve', operator_token: OPERATOR_TOKEN }));
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
