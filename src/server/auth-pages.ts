import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_SECRET_LENGTH } from '../auth/handoff.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  GatewayError,
  type GatewayRuntime,
  type OAuthAuthorizeValidationSuccess,
  type SourceRecord,
} from '../types/index.js';

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_CSS = `
:root { color-scheme: light dark;
  --bg: light-dark(#f6f7f9, #101216); --fg: light-dark(#14181f, #eef0f4);
  --card: light-dark(#ffffff, #181b21); --muted: light-dark(#4a5260, #aab1be);
  --line: light-dark(#c4cad4, #3a404b); --accent: light-dark(#1b4fd8, #8fb0ff);
  --accent-fg: light-dark(#ffffff, #0b1020); --danger: light-dark(#b3261e, #ff8a80); }
* { box-sizing: border-box; }
body { margin: 0; min-block-size: 100dvh; display: grid; place-items: center; padding: 1rem;
  background: var(--bg); color: var(--fg); font: 1rem/1.5 system-ui, sans-serif; }
main { inline-size: min(34rem, 100%); background: var(--card); border: 1px solid var(--line);
  border-radius: .75rem; padding: 1.5rem; }
h1 { font-size: 1.35rem; margin: 0 0 .75rem; }
p, dl { margin: 0 0 1rem; } dt { color: var(--muted); font-size: .85rem; } dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
label { display: block; font-weight: 600; margin-block-end: .25rem; overflow-wrap: anywhere; }
.field { margin-block-end: 1rem; } .hint { color: var(--muted); font-size: .85rem; }
input { font: inherit; inline-size: 100%; min-block-size: 2.75rem; padding: .5rem .75rem;
  border: 1px solid var(--line); border-radius: .5rem; background: var(--bg); color: var(--fg); }
input:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: .75rem; flex-wrap: wrap; }
button { font: inherit; min-block-size: 2.75rem; padding: .5rem 1.25rem; border-radius: .5rem;
  border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.error { color: var(--danger); border: 1px solid var(--danger); border-radius: .5rem; padding: .5rem .75rem; margin-block-end: 1rem; }
code { font-family: ui-monospace, monospace; background: var(--bg); padding: .1rem .35rem; border-radius: .25rem; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); padding: .75rem; border-radius: .5rem; }
`;

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function htmlPage(
  c: Context,
  options: {
    title: string;
    body: string;
    status?: ContentfulStatusCode;
    formAction?: 'self' | 'any';
  },
): Response {
  const styleNonce = nonce();
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${styleNonce}'`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    ...(options.formAction === 'any' ? [] : ["form-action 'self'"]),
  ].join('; ');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} · AgentFabric</title>
<style nonce="${styleNonce}">${PAGE_CSS}</style>
</head>
<body><main>${options.body}</main></body>
</html>`;
  return c.html(html, options.status ?? 200, {
    'content-security-policy': csp,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function messagePage(
  c: Context,
  title: string,
  message: string,
  status: ContentfulStatusCode,
): Response {
  return htmlPage(c, {
    title,
    status,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  });
}

function safeRedirect(target: string): string {
  const url = new URL(target);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
    throw new GatewayError('INTERNAL_ERROR', 'Refusing unsafe redirect target');
  }
  return url.toString();
}

function operatorTokenValid(
  runtime: GatewayRuntime,
  requestUrl: string,
  token: string,
): boolean {
  if (!token) return false;
  try {
    return runtime.authenticateOperator(
      new Request(requestUrl, { headers: { authorization: `Bearer ${token}` } }),
    );
  } catch {
    return false;
  }
}

function consentBody(
  validation: OAuthAuthorizeValidationSuccess,
  action: string,
  error?: string,
): string {
  const redirect = new URL(validation.redirectUri);
  return `<h1>Authorize connection</h1>
<p><strong>${escapeHtml(validation.client.clientName)}</strong> wants to connect to your AgentFabric gateway.</p>
<dl>
<dt>Redirects back to</dt><dd><code>${escapeHtml(redirect.origin === 'null' ? redirect.protocol : redirect.origin)}${escapeHtml(redirect.pathname)}</code></dd>
<dt>Profile</dt><dd>${escapeHtml(validation.profileId)}</dd>
<dt>Scope</dt><dd>${escapeHtml(validation.scope)}</dd>
</dl>
<form method="post" action="${escapeHtml(action)}">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<div class="field">
<label for="operator_token">Operator token</label>
<input id="operator_token" name="operator_token" type="password" required autofocus autocomplete="current-password" aria-describedby="token-hint">
<span id="token-hint" class="hint">Only the gateway operator can approve a connection.</span>
</div>
<div class="row">
<button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>`;
}

function secretFieldNames(source: SourceRecord): string[] {
  const names = new Set<string>();
  for (const name of source.authConfig.requiredSecrets ?? []) names.add(name);
  if (source.authConfig.secretName) names.add(source.authConfig.secretName);
  for (const name of Object.values(source.authConfig.envMap ?? {})) names.add(name);
  return [...names];
}

function connectBody(
  runtime: GatewayRuntime,
  source: SourceRecord,
  ticket: string,
  fields: string[],
  error?: string,
): string {
  const { instructions, cliLoginCommand } = source.authConfig;
  return `<h1>Connect ${escapeHtml(source.name)}</h1>
<p>Enter the credentials this source needs. They are stored in the gateway vault and are never shown to agents or echoed back here.</p>
${instructions ? `<pre>${escapeHtml(instructions)}</pre>` : ''}
${runtime.mode === 'local' && source.kind === 'cli_wrapper' && cliLoginCommand ? `<p class="hint">Prefer the terminal? Run <code>${escapeHtml(cliLoginCommand)}</code></p>` : ''}
<form method="post" action="/auth/connect/${encodeURIComponent(source.id)}" autocomplete="off">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
${fields
  .map(
    (name, index) => `<div class="field">
<label for="secret_${index}">${escapeHtml(name)}</label>
<input id="secret_${index}" name="secret_${index}" type="password" required autocomplete="new-password" spellcheck="false" autocapitalize="none">
</div>`,
  )
  .join('\n')}
<button class="primary" type="submit">Save credentials</button>
</form>`;
}

function oauthConnectPage(c: Context, runtime: GatewayRuntime, source: SourceRecord, ticket: string, error?: string) {
  const oauth = source.authConfig.oauth!;
  const url = source.config.kind === 'mcp_http' ? source.config.url : '';
  return htmlPage(c, {
    title: `Connect ${source.name}`,
    status: error ? 400 : 200,
    formAction: 'any',
    body: `<h1>Connect ${escapeHtml(source.name)}</h1>
<dl>
<dt>MCP endpoint</dt><dd><code>${escapeHtml(url)}</code></dd>
${oauth.scopes?.length ? `<dt>OAuth scopes</dt><dd>${escapeHtml(oauth.scopes.join(' '))}</dd>` : ''}
<dt>Redirect URI</dt><dd><code>${escapeHtml(runtime.publicUrl + '/auth/oauth/callback')}</code></dd>
</dl>
<form method="post" action="/auth/connect/${encodeURIComponent(source.id)}" autocomplete="off">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
${oauth.clientSecretName ? `<div class="field">
<label for="client_secret">OAuth client secret</label>
<input id="client_secret" name="client_secret" type="password" autocomplete="new-password" aria-describedby="client-secret-hint">
<span id="client-secret-hint" class="hint">Leave empty if already saved in vault</span>
</div>` : ''}
<button class="primary" type="submit">Continue to OAuth sign-in</button>
</form>`,
  });
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function failurePage(c: Context, error: unknown): Response {
  if (error instanceof GatewayError) {
    return messagePage(c, 'Request failed', error.message, error.httpStatus as ContentfulStatusCode);
  }
  return messagePage(c, 'Request failed', 'The gateway could not complete this request.', 500);
}

export function mountAuthPages(app: Hono, runtime: GatewayRuntime): void {
  const small = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => messagePage(c, 'Request too large', 'The submitted form is too large.', 413),
  });

  app.get('/oauth/authorize', async (c) => {
    try {
      const params = new URL(c.req.url).searchParams;
      const validation = await runtime.validateOAuthAuthorize(params);
      if (!validation.ok) {
        return messagePage(
          c,
          'Cannot authorize',
          `${validation.error}: ${validation.description}`,
          400,
        );
      }
      const action = `/oauth/authorize${new URL(c.req.url).search}`;
      return htmlPage(c, {
        title: 'Authorize connection',
        body: consentBody(validation, action),
        formAction: 'any',
      });
    } catch (error) {
      return failurePage(c, error);
    }
  });

  app.post('/oauth/authorize', small, async (c) => {
    try {
      const url = new URL(c.req.url);
      const validation = await runtime.validateOAuthAuthorize(url.searchParams);
      if (!validation.ok) {
        return messagePage(
          c,
          'Cannot authorize',
          `${validation.error}: ${validation.description}`,
          400,
        );
      }
      const form = await c.req.parseBody();
      const decision = asText(form.decision);

      if (decision === 'deny') {
        const target = new URL(validation.redirectUri);
        target.searchParams.set('error', 'access_denied');
        if (validation.state) target.searchParams.set('state', validation.state);
        return c.redirect(safeRedirect(target.toString()), 303);
      }
      if (decision !== 'approve') {
        return messagePage(c, 'Cannot authorize', 'Choose Approve or Deny.', 400);
      }
      if (!operatorTokenValid(runtime, c.req.url, asText(form.operator_token))) {
        return htmlPage(c, {
          title: 'Authorize connection',
          body: consentBody(validation, `/oauth/authorize${url.search}`, 'That operator token was not accepted.'),
          status: 401,
          formAction: 'any',
        });
      }
      const { redirectUrl } = await runtime.approveOAuthAuthorize({
        clientId: validation.client.clientId,
        redirectUri: validation.redirectUri,
        codeChallenge: validation.codeChallenge,
        scope: validation.scope,
        profileId: validation.profileId,
        ...(validation.state !== undefined ? { state: validation.state } : {}),
      });
      return c.redirect(safeRedirect(redirectUrl), 303);
    } catch (error) {
      return failurePage(c, error);
    }
  });

  app.get('/auth/connect/:sourceId', async (c) => {
    try {
      const sourceId = c.req.param('sourceId');
      const ticket = c.req.query('ticket') ?? '';
      const result = ticket
        ? await runtime.validateAuthTicket(sourceId, ticket)
        : { valid: false as const };
      if (!result.valid || !result.source) {
        return messagePage(
          c,
          'Link expired',
          'This credential link is invalid or has expired. Repeat the failed action to get a fresh link.',
          403,
        );
      }
      if (result.source.authConfig.kind === 'oauth2' && result.source.authConfig.oauth) {
        return oauthConnectPage(c, runtime, result.source, ticket);
      }
      const fields = secretFieldNames(result.source);
      if (fields.length === 0) {
        return messagePage(
          c,
          'Nothing to enter',
          'This source does not declare any secret names. Ask the operator to configure them.',
          400,
        );
      }
      return htmlPage(c, {
        title: `Connect ${result.source.name}`,
        body: connectBody(runtime, result.source, ticket, fields),
      });
    } catch (error) {
      return failurePage(c, error);
    }
  });

  app.post('/auth/connect/:sourceId', small, async (c) => {
    try {
      const sourceId = c.req.param('sourceId');
      const form = await c.req.parseBody();
      const ticket = asText(form.ticket);
      const result = ticket
        ? await runtime.validateAuthTicket(sourceId, ticket)
        : { valid: false as const };
      if (!result.valid || !result.source) {
        return messagePage(
          c,
          'Link expired',
          'This credential link is invalid or has expired. Repeat the failed action to get a fresh link.',
          403,
        );
      }
      if (result.source.authConfig.kind === 'oauth2' && result.source.authConfig.oauth) {
        const clientSecret = asText(form.client_secret);
        if (clientSecret.length > MAX_SECRET_LENGTH) {
          return oauthConnectPage(c, runtime, result.source, ticket, 'The OAuth client secret is too long.');
        }
        const { authorizeUrl } = await runtime.startUpstreamOAuth(sourceId, {
          ticket, ...(clientSecret ? { clientSecret } : {}),
        });
        c.header('cache-control', 'no-store');
        c.header('referrer-policy', 'no-referrer');
        return c.redirect(safeRedirect(authorizeUrl), 303);
      }
      const fields = secretFieldNames(result.source);
      const secrets: Record<string, string> = {};
      let problem: string | undefined;
      fields.forEach((name, index) => {
        const value = asText(form[`secret_${index}`]);
        if (!value.trim()) problem = `A value for ${name} is required.`;
        else if (value.length > MAX_SECRET_LENGTH) problem = `The value for ${name} is too long.`;
        else secrets[name] = value;
      });
      if (fields.length === 0 || problem) {
        return htmlPage(c, {
          title: `Connect ${result.source.name}`,
          body: connectBody(runtime, result.source, ticket, fields, problem ?? 'No secrets are configured for this source.'),
          status: 400,
        });
      }
      const { source } = await runtime.completeAuthHandoff(sourceId, ticket, secrets);
      return htmlPage(c, {
        title: 'Connected',
        body: `<h1>Connected</h1><p>${escapeHtml(source.name)} now has its credentials. You can close this tab and retry in your agent.</p>`,
      });
    } catch (error) {
      return failurePage(c, error);
    }
  });

  app.get('/auth/oauth/callback', async (c) => {
    try {
      const { source, capabilityCount, refreshError } = await runtime.completeUpstreamOAuth(new URL(c.req.url).searchParams);
      return htmlPage(c, {
        title: 'Connected',
        body: `<h1>Connected ${escapeHtml(source.name)}</h1>
${refreshError ? `<p class="error" role="alert">${escapeHtml(refreshError)}</p>`
    : `<p>${capabilityCount} ${capabilityCount === 1 ? 'capability' : 'capabilities'} discovered.</p>`}`,
      });
    } catch (error) {
      return failurePage(c, error);
    }
  });
}
