import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GatewayError, type McpHttpSourceConfig, type SecretStore, type SourceRecord } from '../types/index.js';

export async function httpTransport(source: SourceRecord & { config: McpHttpSourceConfig }, secrets: SecretStore) {
  const headers = new Headers(source.config.headers);
  const auth = source.authConfig;
  if (['bearer_secret', 'header_secret', 'oauth2'].includes(auth.kind)) {
    const value = auth.secretName && await secrets.get(auth.secretName);
    if (!value) throw new GatewayError('AUTH_REQUIRED', 'Required upstream credentials are missing');
    if (auth.kind === 'header_secret') headers.set(auth.headerName!, value);
    else headers.set('Authorization', `Bearer ${value}`);
  }
  return new StreamableHTTPClientTransport(new URL(source.config.url), {
    requestInit: { headers, redirect: 'error' },
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, redirect: 'error' });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new GatewayError('AUTH_REQUIRED', 'Upstream rejected the configured credentials');
      }
      return response;
    },
  });
}
