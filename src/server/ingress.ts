import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { GatewayRuntime } from '../types/index.js';

export interface IngressLimits {
  maxBodyBytes: number;
  maxConcurrent: number;
  globalBurst: number;
  globalPerMinute: number;
  subscriptionBurst: number;
  subscriptionPerMinute: number;
}

export const defaultIngressLimits: IngressLimits = {
  maxBodyBytes: 256 * 1024, maxConcurrent: 8, globalBurst: 60, globalPerMinute: 120, subscriptionBurst: 12, subscriptionPerMinute: 30,
};

const subscriptionPattern = /^sub_[0-9a-f]{32}$/;
const maxTrackedSubscriptions = 1024;

class TokenBucket {
  private tokens: number;
  private updated = Date.now();
  constructor(private readonly burst: number, private readonly perMinute: number) { this.tokens = burst; }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (now - this.updated) * this.perMinute / 60_000);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function empty(status: number) {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export function createIngressApp(runtime: Pick<GatewayRuntime, 'handleEventIngress'>, limits: IngressLimits = defaultIngressLimits) {
  const app = new Hono();
  const global = new TokenBucket(limits.globalBurst, limits.globalPerMinute);
  const perSubscription = new Map<string, TokenBucket>();
  let inFlight = 0;
  const bucket = (id: string) => {
    let found = perSubscription.get(id);
    if (!found) {
      if (perSubscription.size >= maxTrackedSubscriptions) perSubscription.delete(perSubscription.keys().next().value!);
      found = new TokenBucket(limits.subscriptionBurst, limits.subscriptionPerMinute);
      perSubscription.set(id, found);
    }
    return found;
  };
  app.post('/events/ingress/:subscription',
    async (c, next) => {
      const id = c.req.param('subscription');
      if (!subscriptionPattern.test(id)) return empty(404);
      if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return empty(415);
      if (!global.take() || !bucket(id).take()) return empty(429);
      if (inFlight >= limits.maxConcurrent) return empty(503);
      inFlight++;
      try { await next(); } finally { inFlight--; }
    },
    bodyLimit({ maxSize: limits.maxBodyBytes, onError: () => empty(413) }),
    async c => {
      const response = await runtime.handleEventIngress(c.req.raw, c.req.param('subscription'));
      const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      const type = response.headers.get('content-type');
      if (type) headers.set('content-type', type);
      return new Response(response.body, { status: response.status, headers });
    });
  app.notFound(() => empty(404));
  app.onError(() => empty(500));
  return app;
}
