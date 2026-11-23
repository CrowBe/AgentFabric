import type { GatewayRuntime, RuntimeOptions } from '../types/index.js';

export async function createGatewayRuntime(
  _options: RuntimeOptions,
): Promise<GatewayRuntime> {
  throw new Error('Not implemented');
}
