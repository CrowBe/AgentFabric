import { describe, expect, it } from 'vitest';
import { createIngressApp, defaultIngressLimits } from '../../src/server/ingress.js';

const id = 'sub_' + 'a'.repeat(32);
function harness(limits = {}) {
  const calls: string[] = [];
  let release: () => void = () => {};
  let hold = false;
  const app = createIngressApp({
    async handleEventIngress(_request, subscription) {
      calls.push(subscription);
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ ok: true }, { headers: { 'x-leak': 'internal' } });
    },
  }, { ...defaultIngressLimits, ...limits });
  const post = (path = `/events/ingress/${id}`, init: RequestInit = {}) => app.request(path, {
    method: 'POST', body: '{}', ...init, headers: { 'content-type': 'application/json', ...init.headers },
  });
  return { app, calls, post, holdNext: () => { hold = true; }, release: () => release() };
}

describe('event ingress listener', () => {
  it('forwards only well-formed subscription ids and strips upstream response headers', async () => {
    const { calls, post } = harness();
    const ok = await post();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-leak')).toBeNull();
    expect(ok.headers.get('cache-control')).toBe('no-store');
    for (const bad of ['sub_short', 'sub_' + 'A'.repeat(32), '..%2Fapi', 'sub_' + 'a'.repeat(33)]) {
      expect((await post(`/events/ingress/${bad}`)).status).toBe(404);
    }
    expect(calls).toEqual([id]);
  });

  it('rejects non-JSON and oversized bodies before the runtime sees them', async () => {
    const { calls, post } = harness({ maxBodyBytes: 64 });
    expect((await post(undefined, { headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await post(undefined, { body: JSON.stringify({ pad: 'x'.repeat(200) }) })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('rate limits per subscription and globally', async () => {
    const perSubscription = harness({ subscriptionBurst: 2, subscriptionPerMinute: 1 });
    expect((await perSubscription.post()).status).toBe(200);
    expect((await perSubscription.post()).status).toBe(200);
    expect((await perSubscription.post()).status).toBe(429);
    const globalLimit = harness({ globalBurst: 1, globalPerMinute: 1 });
    expect((await globalLimit.post()).status).toBe(200);
    expect((await globalLimit.post(`/events/ingress/sub_${'b'.repeat(32)}`)).status).toBe(429);
  });

  it('sheds load beyond the concurrency cap', async () => {
    const { post, holdNext, release } = harness({ maxConcurrent: 1 });
    holdNext();
    const first = post();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await post(`/events/ingress/sub_${'c'.repeat(32)}`)).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });

  it('answers every other route and method with an empty 404', async () => {
    const { app } = harness();
    for (const [method, path] of [['GET', '/'], ['GET', `/events/ingress/${id}`], ['POST', '/mcp'], ['GET', '/api/sources']]) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
  });
});
