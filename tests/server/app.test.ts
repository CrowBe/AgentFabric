import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalEvent, ApprovalRequestRecord } from '../../src/types/index.js';
import { OPERATOR_TOKEN, makeHarness } from './helpers.js';

const approval = (id: string): ApprovalRequestRecord => ({
  id,
  profileId: 'default',
  sourceId: 's',
  capabilityId: 's:tool:rm',
  toolName: 'rm',
  redactedArguments: { path: '[redacted]' },
  reason: 'destructive',
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe('gateway endpoints', () => {
  it('serves /healthz without authentication', async () => {
    const h = makeHarness({ mode: 'remote' });
    const { status, body } = await h.json('/healthz', { auth: false });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, mode: 'remote', version: '0.1.0' });
  });

  it('delegates OAuth discovery, registration and token endpoints to the runtime', async () => {
    const h = makeHarness({ publicUrl: 'https://gw.example.com' });
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp/default',
      '/.well-known/oauth-authorization-server',
    ]) {
      const res = await h.call(path, { auth: false });
      expect(res.status, path).toBe(200);
    }
    const meta = await (await h.call('/.well-known/oauth-authorization-server', { auth: false })).json();
    expect(meta.authorization_endpoint).toBe('https://gw.example.com/oauth/authorize');

    const bad = await h.call('/oauth/register', {
      method: 'POST',
      auth: false,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
    const token = await h.call('/oauth/token', { method: 'POST', auth: false, body: 'grant_type=x' });
    expect(token.status).toBe(200);
  });

  it('passes MCP requests (with and without a profile) to the runtime untouched', async () => {
    const h = makeHarness();
    const anon = await h.call('/mcp', { method: 'POST', auth: false, body: '{}' });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toContain('resource_metadata');

    const minted = await h.json('/api/tokens', { method: 'POST', json: { label: 't', profileId: 'default' } });
    const authz = { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' };
    const init = await h.call('/mcp', {
      method: 'POST',
      auth: false,
      headers: authz,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(init.status).toBe(200);
    const mismatch = await h.call('/mcp/someone-else', { method: 'POST', auth: false, headers: authz, body: '{}' });
    expect(mismatch.status).toBe(403);
    const sse = await h.call('/mcp/default', { auth: false, headers: authz });
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    await sse.body?.cancel();
    expect((await h.call('/mcp', { method: 'DELETE', auth: false, headers: authz })).status).toBe(204);
  });

  it('adds CORS for MCP/OAuth endpoints only, never for the operator API', async () => {
    const h = makeHarness();
    const preflight = await h.call('/mcp', {
      method: 'OPTIONS',
      auth: false,
      headers: {
        origin: 'https://inspector.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-session-id',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('mcp-session-id');
    const api = await h.call('/api/status', { headers: { origin: 'https://evil.example' } });
    expect(api.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sets nosniff on responses', async () => {
    const h = makeHarness();
    expect((await h.call('/healthz')).headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('approvals SSE stream', () => {
  const streamHarness = () => {
    const listeners = new Set<(e: ApprovalEvent) => void>();
    const pending = [approval('a1')];
    const h = makeHarness({
      wrap: (r) => ({
        ...r,
        listApprovals: async (status) => (status === 'pending' ? pending : []),
        subscribeApprovals: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      }),
    });
    return { h, listeners };
  };

  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  it('requires operator authentication', async () => {
    const { h } = streamHarness();
    expect((await h.call('/api/approvals/stream', { auth: false })).status).toBe(401);
    expect((await h.call('/api/approvals/stream?token=wrong', { auth: false })).status).toBe(401);
  });

  it('streams a pending snapshot then live approval events, and cleans up on disconnect', async () => {
    const { h, listeners } = streamHarness();
    const res = await h.call('/api/approvals/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = await readUntil(reader, 'a1');
    expect(first).toContain('event: snapshot');
    expect(listeners.size).toBe(1);

    const next = readUntil(reader, 'a2');
    for (const l of listeners) l({ type: 'created', approval: approval('a2') });
    const live = await next;
    expect(live).toContain('event: approval');
    expect(live).toContain('"id":"a2"');

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(listeners.size).toBe(0);
  });

  it('never accepts ?token= on the approvals stream (fail closed)', async () => {
    const { h } = streamHarness();
    const res = await h.call(`/api/approvals/stream?token=${OPERATOR_TOKEN}`, { auth: false });
    expect(res.status).toBe(401);
  });
});

describe('static web UI', () => {
  let parent: string;
  let dir: string;
  beforeAll(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'af-static-'));
    dir = path.join(parent, 'ui');
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>UI</title>');
    await writeFile(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
    await writeFile(path.join(parent, 'af-secret.txt'), 'top secret');
  });
  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('serves the SPA shell with a CSP for / and client routes', async () => {
    const h = makeHarness({ staticDir: dir });
    for (const route of ['/', '/sources', '/deep/link']) {
      const res = await h.call(route, { auth: false });
      expect(res.status, route).toBe(200);
      expect(await res.text()).toContain('<title>UI</title>');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves hashed assets as immutable and 404s missing assets', async () => {
    const h = makeHarness({ staticDir: dir });
    const asset = await h.call('/assets/app-abc.js', { auth: false });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await h.call('/assets/missing.js', { auth: false })).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    const h = makeHarness({ staticDir: dir });
    for (const attempt of ['/..%2faf-secret.txt', '/%2e%2e/af-secret.txt', '/assets/..%2f..%2faf-secret.txt', '/%00.js']) {
      const res = await h.call(attempt, { auth: false });
      const text = await res.text();
      expect(text, attempt).not.toContain('top secret');
    }
  });

  it('keeps API and gateway paths as JSON 404s instead of the SPA shell', async () => {
    const h = makeHarness({ staticDir: dir });
    for (const route of ['/oauth/nowhere', '/mcp/a/b/c', '/.well-known/nothing']) {
      const res = await h.call(route, { auth: false });
      expect(res.status, route).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  it('reports an unbuilt UI plainly and can disable UI serving', async () => {
    const missing = makeHarness({ staticDir: path.join(dir, 'does-not-exist') });
    const res = await missing.call('/', { auth: false });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('build:web');
    const off = makeHarness({ staticDir: false });
    expect((await off.call('/', { auth: false })).status).toBe(404);
  });

  it('does not serve non-GET requests to the UI', async () => {
    const h = makeHarness({ staticDir: dir });
    expect((await h.call('/', { method: 'POST', auth: false })).status).toBe(404);
  });
});
