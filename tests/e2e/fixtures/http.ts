import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { fixtureEvent, mcpResponse } from './mcp-responses.mjs';

export async function listen(fetch: (request: Request) => Response | Promise<Response>) {
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

interface FixtureRequest {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export async function startHttpMcp(options: { bearer?: string } = {}) {
  const requests: FixtureRequest[] = [];
  const credentials: (string | null)[] = [];
  const server = await listen(async request => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (path !== '/mcp' && path !== '/malformed') return new Response(null, { status: 404 });
    credentials.push(request.headers.get('authorization'));
    if (options.bearer && credentials.at(-1) !== `Bearer ${options.bearer}`) {
      return new Response(null, { status: 401 });
    }
    const rpc = await request.json() as FixtureRequest;
    requests.push(rpc);
    if (path === '/malformed') {
      return new Response('{ this is not JSON', { headers: { 'content-type': 'application/json' } });
    }
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === 'events/stream') {
      const cursor = 'fixture-push-next';
      const frames = [
        { method: 'notifications/events/active', params: { cursor: 'fixture-push-start', heartbeatMs: 1000 } },
        { method: 'notifications/events/event', params: fixtureEvent(cursor) },
        { method: 'notifications/events/heartbeat', params: { cursor } },
        { id: rpc.id, result: { resultType: 'complete' } },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json(mcpResponse(rpc, 'http'));
  });
  return {
    ...server, mcpUrl: `${server.url}/mcp`, requests, credentials,
    calls: () => requests.filter(request => request.method === 'tools/call'),
  };
}
