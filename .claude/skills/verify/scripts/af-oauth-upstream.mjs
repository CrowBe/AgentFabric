#!/usr/bin/env node
// Loopback OAuth 2.1 + MCP boundary server for the upstream-OAuth journey. It stands in for the
// external provider only (the one boundary the gateway already isolates): protected-resource and
// authorization-server metadata, Dynamic Client Registration, an auto-consenting /authorize, a PKCE
// (S256) /token endpoint with refresh-token rotation, and a bearer-protected MCP endpoint at /mcp.
// Usage: af-oauth-upstream.mjs <proof-dir> [--expires-in SECONDS] [--ttl SECONDS]
//   Starts detached on 127.0.0.1:<free port>, writes <proof>/oauth-upstream.env
//   (OAUTH_UPSTREAM_URL, OAUTH_UPSTREAM_PID) and prints the base URL. af-cleanup.sh stops it;
//   it also exits by itself after --ttl seconds (default 900).
// Control (loopback only): GET /control/stats (grant and request counters), POST /control/revoke
// (invalidate issued access tokens so the next MCP call gets 401 and the gateway must refresh).
// Token values never reach the log: <proof>/oauth-upstream.log records events and counters only.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => { console.error(`verify: ${message}`); process.exit(1); };
const args = process.argv.slice(2);
const proof = (args[0] ?? '').replace(/\/+$/, '');
if (!proof || !existsSync(path.join(proof, 'session.env'))) {
  fail('usage: af-oauth-upstream.mjs <proof-dir> [--expires-in SECONDS] [--ttl SECONDS]');
}
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) fail(`${name} expects a positive integer`);
  return value;
};
const expiresIn = option('--expires-in', 3600);
const ttl = option('--ttl', 900);
const envFile = path.join(proof, 'oauth-upstream.env');
const logFile = path.join(proof, 'oauth-upstream.log');

if (!args.includes('--serve')) {
  if (existsSync(envFile)) fail(`${envFile} exists; one boundary server per proof dir`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, '--serve'], {
    detached: true, stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 50 && !existsSync(envFile); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(envFile)) fail(`boundary server did not start; see ${logFile}`);
  console.log(/OAUTH_UPSTREAM_URL=(\S+)/.exec(readFileSync(envFile, 'utf8'))[1]);
  process.exit(0);
}

const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
const token = (kind) => `bnd_${kind}_${randomBytes(24).toString('base64url')}`;
const sha256 = (value) => createHash('sha256').update(value).digest('base64url');
const stats = {
  discovery: 0, registrations: 0, authorizations: 0, codeExchanges: 0, pkceFailures: 0, refreshes: 0,
  refreshFailures: 0, mcpAuthorized: 0, mcpRejected: 0, revocations: 0,
};
const clients = new Map(); // client_id -> redirect_uris
const codes = new Map(); // code -> { clientId, redirectUri, challenge, scope }
const access = new Map(); // access token -> { expiresAt, generation }
const refresh = new Set();
let generation = 0;
let origin = '';

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => { size += chunk.length; if (size > 65536) req.destroy(); else chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function issue(res, scope) {
  generation += 1;
  const accessToken = token('access');
  const refreshToken = token('refresh');
  access.set(accessToken, { expiresAt: Date.now() + expiresIn * 1000, generation });
  refresh.add(refreshToken);
  json(res, { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refreshToken, scope });
}

function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(data));
}

const tool = {
  name: 'oauth_boundary_echo',
  description: 'Echo a value through the OAuth-protected loopback boundary',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result: { ...result, ttlMs: 0, cacheScope: 'private', resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'verify-oauth-boundary', version: '1.0.0' } } } };
}

function mcp(rpc, grant) {
  const { id, method, params = {} } = rpc;
  switch (method) {
    case 'server/discover': return rpcResult(id, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
    case 'initialize': return rpcResult(id, { protocolVersion: params.protocolVersion ?? '2026-07-28',
      capabilities: { tools: {} }, serverInfo: { name: 'verify-oauth-boundary', version: '1.0.0' } });
    case 'tools/list': return rpcResult(id, { tools: [tool] });
    case 'tools/call':
      if (params.name !== tool.name) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
      return rpcResult(id, { content: [{ type: 'text', text: `boundary:${params.arguments?.value} (token generation ${grant.generation})` }] });
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, origin);
    const issuer = `${origin}/issuer`;
    if (pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource') {
      stats.discovery += 1;
      return json(res, { resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: ['mcp'] });
    }
    if (pathname === '/.well-known/oauth-authorization-server/issuer') {
      stats.discovery += 1;
      return json(res, { issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'] });
    }
    if (pathname === '/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const clientId = `bnd-client-${randomBytes(6).toString('hex')}`;
      clients.set(clientId, body.redirect_uris ?? []);
      stats.registrations += 1;
      log(`register client=${clientId} redirect_uris=${JSON.stringify(body.redirect_uris)}`);
      return json(res, { client_id: clientId, token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris }, 201);
    }
    if (pathname === '/authorize') {
      const p = searchParams;
      const clientId = p.get('client_id');
      const redirectUri = p.get('redirect_uri');
      if (p.get('response_type') !== 'code' || !clients.get(clientId)?.includes(redirectUri)
        || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !p.get('state')) {
        log('authorize rejected (bad client, redirect_uri, or PKCE parameters)');
        return json(res, { error: 'invalid_request' }, 400);
      }
      // Auto-consent stands in for the human clicking "Allow" at the provider.
      const code = token('code');
      codes.set(code, { clientId, redirectUri, challenge: p.get('code_challenge'), scope: p.get('scope') ?? '' });
      stats.authorizations += 1;
      log(`authorize ok client=${clientId} scope=${p.get('scope')} resource=${p.get('resource')}`);
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', p.get('state'));
      target.searchParams.set('iss', issuer);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }).end();
      return;
    }
    if (pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      if (p.get('grant_type') === 'authorization_code') {
        const record = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        if (!record || record.clientId !== p.get('client_id') || record.redirectUri !== p.get('redirect_uri')) {
          log('token authorization_code rejected (unknown code, client, or redirect_uri)');
          return json(res, { error: 'invalid_grant' }, 400);
        }
        if (sha256(p.get('code_verifier') ?? '') !== record.challenge) {
          stats.pkceFailures += 1;
          log('token authorization_code rejected (PKCE verifier mismatch)');
          return json(res, { error: 'invalid_grant' }, 400);
        }
        stats.codeExchanges += 1;
        log(`token authorization_code ok (PKCE S256 verified) generation=${generation + 1}`);
        return issue(res, record.scope);
      }
      if (p.get('grant_type') === 'refresh_token') {
        const presented = p.get('refresh_token');
        if (!refresh.has(presented)) {
          stats.refreshFailures += 1;
          log('token refresh_token rejected');
          return json(res, { error: 'invalid_grant' }, 400);
        }
        refresh.delete(presented); // rotate
        stats.refreshes += 1;
        log(`token refresh_token ok (rotated) generation=${generation + 1}`);
        return issue(res, 'mcp');
      }
      return json(res, { error: 'unsupported_grant_type' }, 400);
    }
    if (pathname === '/mcp') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const grant = bearer && access.get(bearer);
      if (!grant || grant.expiresAt <= Date.now()) {
        stats.mcpRejected += 1;
        log(`mcp ${req.method} rejected 401 (${bearer ? 'unknown or expired token' : 'no bearer'})`);
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const rpc = JSON.parse(await readBody(req));
      stats.mcpAuthorized += 1;
      if (rpc.id === undefined) { res.writeHead(202).end(); return; }
      log(`mcp ${rpc.method} ok generation=${grant.generation}`);
      return json(res, mcp(rpc, grant));
    }
    if (pathname === '/control/stats') return json(res, { ...stats, generation, expiresIn });
    if (pathname === '/control/revoke' && req.method === 'POST') {
      access.clear();
      stats.revocations += 1;
      log('control revoke: all access tokens invalidated');
      return json(res, { revoked: true });
    }
    res.writeHead(404).end();
  } catch (error) {
    log(`error ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(0, '127.0.0.1', () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  log(`listening ${origin} expires_in=${expiresIn}s ttl=${ttl}s pid=${process.pid}`);
  writeFileSync(envFile, `OAUTH_UPSTREAM_URL=${origin}\nOAUTH_UPSTREAM_PID=${process.pid}\n`);
});
const stop = (why) => { log(`stopping (${why})`); server.close(); process.exit(0); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
setTimeout(() => stop('ttl elapsed'), ttl * 1000).unref();
