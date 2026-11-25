import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { UpstreamOAuthManager } from '../auth/upstream-oauth.js';
import { GatewayError, type McpHttpSourceConfig, type SecretStore, type SourceRecord } from '../types/index.js';

export async function httpTransport(source: SourceRecord & { config: McpHttpSourceConfig }, secrets: SecretStore,
  upstreamOAuth?: UpstreamOAuthManager) {
  const headers = new Headers(source.config.headers);
  const auth = source.authConfig;
  if (auth.kind === 'oauth2' && auth.oauth) {
    if (!upstreamOAuth) throw new GatewayError('INTERNAL_ERROR', 'Upstream OAuth manager unavailable');
    await upstreamOAuth.getAccessToken(source);
    const rejected = () => new GatewayError('AUTH_REQUIRED', 'Upstream rejected the configured OAuth credentials');
    async function cancel(response: Response) {
      const challenge = response.headers.get('www-authenticate');
      if (response.status === 401 && challenge) upstreamOAuth!.recordWwwAuthenticate(source.id, challenge);
      await response.body?.cancel().catch(() => {});
    }
    return new StreamableHTTPClientTransport(new URL(source.config.url), {
      requestInit: { headers, redirect: 'error' },
      fetch: async (input, init) => {
        const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
        headers.forEach((value, name) => requestHeaders.set(name, value));
        new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
        const send = (token: string) => {
          requestHeaders.set('Authorization', `Bearer ${token}`);
          return fetch(input, { ...init, headers: requestHeaders, redirect: 'error' });
        };
        const token = await upstreamOAuth.getAccessToken(source);
        const response = await send(token);
        if (response.status === 403) {
          await cancel(response);
          throw rejected();
        }
        if (response.status !== 401) return response;
        await cancel(response);
        const refreshed = await upstreamOAuth.getAccessToken(source, { forceRefresh: true, rejectedToken: token });
        if (init?.body instanceof ReadableStream || (input instanceof Request && input.body)) throw rejected();
        const retry = await send(refreshed);
        if (retry.status === 401 || retry.status === 403) {
          await cancel(retry);
          throw rejected();
        }
        return retry;
      },
    });
  }
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
