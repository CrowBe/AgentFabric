import { createApp } from '../../src/server/app.js';
import { createMockRuntime, type MockRuntimeOptions } from '../../src/testing/mock-runtime.js';
import type { GatewayRuntime } from '../../src/types/index.js';

export const OPERATOR_TOKEN = 'test-operator-token';

export interface Harness {
  runtime: GatewayRuntime;
  call(path: string, init?: RequestInit & { json?: unknown; auth?: boolean }): Promise<Response>;
  json<T = Record<string, any>>(
    path: string,
    init?: RequestInit & { json?: unknown; auth?: boolean },
  ): Promise<{ status: number; body: T; res: Response }>;
}

export function makeHarness(
  options: MockRuntimeOptions & { staticDir?: string | false; wrap?: (r: GatewayRuntime) => GatewayRuntime } = {},
): Harness {
  const { staticDir, wrap, ...runtimeOptions } = options;
  const base = createMockRuntime({ operatorToken: OPERATOR_TOKEN, ...runtimeOptions });
  const runtime = wrap ? wrap(base) : base;
  const app = createApp(runtime, { staticDir: staticDir ?? false });

  const call: Harness['call'] = (path, init = {}) => {
    const { json, auth = true, headers, ...rest } = init;
    const merged = new Headers(headers);
    if (auth && !merged.has('authorization')) {
      merged.set('authorization', `Bearer ${OPERATOR_TOKEN}`);
    }
    if (json !== undefined) merged.set('content-type', 'application/json');
    return Promise.resolve(
      app.request(path, {
        ...rest,
        headers: merged,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      }),
    );
  };
  const jsonCall: Harness['json'] = async (path, init) => {
    const res = await call(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, res };
  };
  return { runtime, call, json: jsonCall };
}

export const skillSource = (name = 'review-skill') => ({
  name,
  kind: 'skill' as const,
  config: {
    kind: 'skill' as const,
    slug: name,
    title: 'Review skill',
    description: 'How to review code',
    content: '# Review\nBe kind.',
  },
});
