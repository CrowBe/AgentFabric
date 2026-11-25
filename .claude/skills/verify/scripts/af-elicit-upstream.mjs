#!/usr/bin/env node
// Loopback MCP server that elicits, for the elicitation pass-through journey. It stands in for an external
// remote MCP server only (the one boundary the gateway already isolates) and is built on the same
// @modelcontextprotocol/server SDK the repository depends on, so the gateway's real MCP client, SSE upgrade,
// session binding, schema validation, and URL safety checks run against it.
// Usage: af-elicit-upstream.mjs <proof-dir> [--ttl SECONDS]
//   Starts detached on 127.0.0.1:<free port>, writes <proof>/elicit-upstream.env
//   (ELICIT_UPSTREAM_URL, ELICIT_UPSTREAM_PID) and prints the MCP URL (<base>/mcp). af-cleanup.sh stops it;
//   it also exits by itself after --ttl seconds (default 900).
// Tools: ask {mode: "form"|"url", message, url?} sends elicitation/create (form: requestedSchema
//   {name: string, required}; url: elicitationId "verify-url-1") and returns the caller's answer as JSON text.
//   After an accepted url elicitation it sends notifications/elicitation/complete. plain returns "plain".
// Control (loopback only): GET <base>/control/answers lists every answer the upstream received, in order.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => { console.error(`verify: ${message}`); process.exit(1); };
const args = process.argv.slice(2);
const proof = (args[0] ?? '').replace(/\/+$/, '');
if (!proof || !existsSync(path.join(proof, 'session.env'))) fail('usage: af-elicit-upstream.mjs <proof-dir> [--ttl SECONDS]');
const ttlAt = args.indexOf('--ttl');
const ttl = ttlAt < 0 ? 900 : Number(args[ttlAt + 1]);
if (!Number.isInteger(ttl) || ttl < 1) fail('--ttl expects a positive integer');
const envFile = path.join(proof, 'elicit-upstream.env');
const logFile = path.join(proof, 'elicit-upstream.log');

if (!args.includes('--serve')) {
  if (existsSync(envFile)) fail(`${envFile} exists; one elicitation upstream per proof dir`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, '--serve'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 80 && !existsSync(envFile); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(envFile)) fail(`elicitation upstream did not start; see ${logFile}`);
  console.log(`${/ELICIT_UPSTREAM_URL=(\S+)/.exec(readFileSync(envFile, 'utf8'))[1]}/mcp`);
  process.exit(0);
}

const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
let sdk;
let node;
try {
  sdk = await import('@modelcontextprotocol/server');
  node = await import('@hono/node-server');
} catch (error) {
  log(`cannot load @modelcontextprotocol/server or @hono/node-server (run npm ci): ${error.message}`);
  process.exit(1);
}
const { fromJsonSchema, McpServer, WebStandardStreamableHTTPServerTransport } = sdk;
const nameSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
const answers = [];

function buildServer() {
  const server = new McpServer({ name: 'verify-elicit-upstream', version: '1.0.0' });
  server.registerTool('ask', {
    description: 'Ask the caller a question through MCP elicitation',
    inputSchema: fromJsonSchema({ type: 'object', properties: {
      mode: { type: 'string', enum: ['form', 'url'] }, message: { type: 'string' }, url: { type: 'string' },
    }, required: ['mode', 'message'] }),
  }, async ({ mode, message, url }, ctx) => {
    log(`ask mode=${mode}`);
    const answer = mode === 'url'
      ? await ctx.mcpReq.elicitInput({ mode: 'url', elicitationId: 'verify-url-1', url: url ?? '', message })
      : await ctx.mcpReq.elicitInput({ mode: 'form', message, requestedSchema: nameSchema });
    answers.push(answer);
    log(`answer action=${answer.action}`);
    if (mode === 'url' && answer.action === 'accept') {
      await ctx.mcpReq.notify({ method: 'notifications/elicitation/complete', params: { elicitationId: 'verify-url-1' } });
    }
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  });
  server.registerTool('plain', { description: 'Answer without elicitation', inputSchema: fromJsonSchema({ type: 'object' }) },
    async () => ({ content: [{ type: 'text', text: 'plain' }] }));
  return server;
}

const sessions = new Map();
async function handle(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/control/answers') return Response.json({ answers });
  if (pathname !== '/mcp') return new Response(null, { status: 404 });
  const existing = sessions.get(request.headers.get('mcp-session-id') ?? '');
  if (existing) return existing.handleRequest(request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID, onsessioninitialized: (id) => { sessions.set(id, transport); },
  });
  await buildServer().connect(transport);
  return transport.handleRequest(request);
}

const server = node.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
server.once('listening', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  log(`listening ${origin} ttl=${ttl}s pid=${process.pid}`);
  writeFileSync(envFile, `ELICIT_UPSTREAM_URL=${origin}\nELICIT_UPSTREAM_PID=${process.pid}\n`);
});
const stop = (why) => {
  log(`stopping (${why})`);
  if ('closeAllConnections' in server) server.closeAllConnections();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
setTimeout(() => stop('ttl elapsed'), ttl * 1000).unref();
