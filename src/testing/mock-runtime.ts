import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { MAX_SECRET_LENGTH } from '../auth/handoff.js';
import { hashToken } from '../auth/middleware.js';
import { InMemorySecretStore } from '../storage/secrets.js';
import { deriveRepoSourceName, parseGitHubSkillUrl } from '../upstreams/github-skills.js';
import {
  GatewayError,
  type ApprovalEvent,
  type ApprovalRequestRecord,
  type ApprovalStatus,
  type CapabilityKind,
  type CapabilityProposalRecord,
  type CapabilityRecord,
  type ClientTokenRecord,
  type CreatePolicyInput,
  type CreateProfileInput,
  type CreateSourceInput,
  type CurationHint,
  type EffectiveCapability,
  type EventOccurrenceFilter,
  type GatewayMode,
  type GatewayRuntime,
  type GatewayStatus,
  type McpEventOccurrence,
  type McpEventSubscriptionRecord,
  type McpEventTypeRecord,
  type NormalizationOverlay,
  type OAuthAuthorizeValidationResult,
  type OAuthClientRecord,
  type PortableConfigBundle,
  type ProfileRecord,
  type ProposalStatus,
  type SafetyPolicyRule,
  type SecretMetadata,
  type SourceRecord,
  type TelemetryEventRecord,
  type TelemetrySummary,
  type UpdateProfileInput,
  type UpdateSourceInput,
} from '../types/index.js';

export interface MockRuntimeOptions {
  mode?: GatewayMode;
  homeDir?: string;
  publicUrl?: string;
  operatorToken?: string;
}

export function createMockRuntime(
  options: MockRuntimeOptions = {},
): GatewayRuntime {
  const mode: GatewayMode = options.mode ?? 'local';
  const homeDir = options.homeDir ?? '/tmp/agentfabric-mock';
  const publicUrl = (options.publicUrl ?? 'http://127.0.0.1:7432').replace(
    /\/+$/,
    '',
  );
  const operatorToken = options.operatorToken ?? 'mock-operator-token';
  const startedAt = Date.now();
  const emitter = new EventEmitter();

  const nowIso = (): string => new Date().toISOString();

  const sources = new Map<string, SourceRecord>();
  const capabilities = new Map<string, CapabilityRecord>();
  const overlays = new Map<string, NormalizationOverlay>();
  const profiles = new Map<string, ProfileRecord>();
  const policies = new Map<string, SafetyPolicyRule>();
  const approvals = new Map<string, ApprovalRequestRecord>();
  const proposals = new Map<string, CapabilityProposalRecord>();
  const telemetryEvents: TelemetryEventRecord[] = [];
  const tokens = new Map<string, ClientTokenRecord & { rawToken: string }>();
  const oauthClients = new Map<string, OAuthClientRecord>();
  const secrets = new Map<string, { value: string; description?: string; updatedAt: string }>();
  const upstreamRedirectUri = `${publicUrl}/auth/oauth/callback`;
  const upstreamStates = new Map<string, { id: string; expiresAt: number }>();
  const upstreamConnections = new Set<string>();
  const authTickets = new Map<string, { sourceId: string; expiresAt: number }>();
  const eventTypes = new Map<string, McpEventTypeRecord>([
    [
      'fabric.source.health_changed',
      {
        name: 'fabric.source.health_changed',
        sourceId: 'gateway',
        description: 'Emitted when an upstream source transitions health state',
        inputSchema: {
          type: 'object',
          properties: { sourceId: { type: 'string' } },
          additionalProperties: false,
        },
        payloadSchema: {
          type: 'object',
          properties: {
            sourceId: { type: 'string' },
            health: { type: 'string' },
          },
          required: ['sourceId', 'health'],
        },
        supportedModes: ['poll', 'push', 'webhook'],
      },
    ],
  ]);
  const eventOccurrences: McpEventOccurrence[] = [];
  const eventSubscriptions = new Map<string, McpEventSubscriptionRecord>();
  let eventCursorSeq = 0;

  const defaultCreatedAt = nowIso();
  profiles.set('default', {
    id: 'default',
    name: 'default',
    description: 'Default workspace profile',
    defaultExposure: 'direct',
    directToolBudget: 24,
    rules: [],
    createdAt: defaultCreatedAt,
    updatedAt: defaultCreatedAt,
  });

  const requireSource = (id: string): SourceRecord => {
    const found = sources.get(id);
    if (!found) {
      throw new GatewayError('NOT_FOUND', `Source '${id}' not found`, 404);
    }
    return found;
  };

  function requireHttpSource(id: string) {
    const source = requireSource(id);
    if (source.config.kind !== 'mcp_http') throw new GatewayError('INVALID_INPUT', 'Upstream OAuth requires an mcp_http source');
    return { ...source, config: source.config };
  }

  function clearUpstreamOAuth(id: string) {
    upstreamConnections.delete(id);
    for (const [stateHash, record] of upstreamStates) {
      if (record.id === id) upstreamStates.delete(stateHash);
    }
  }

  const requireProfile = (idOrName: string): ProfileRecord => {
    const direct = profiles.get(idOrName);
    if (direct) return direct;
    for (const p of profiles.values()) {
      if (p.name === idOrName) return p;
    }
    throw new GatewayError('NOT_FOUND', `Profile '${idOrName}' not found`, 404);
  };

  const synthesizeCapabilitiesForSource = (source: SourceRecord): CapabilityRecord[] => {
    const ts = nowIso();
    const list: CapabilityRecord[] = [];
    if (source.config.kind === 'skill') {
      list.push({
        id: `${source.id}:skill:${source.config.slug}`,
        sourceId: source.id,
        kind: 'skill',
        originalName: source.config.slug,
        description: source.config.description,
        uri: `skill://${source.config.slug}`,
        mimeType: 'text/markdown',
        available: source.enabled,
        lastSeenAt: ts,
      });
    } else if (source.config.kind === 'skill_repo') {
      const parsed = parseGitHubSkillUrl(source.config.url, {
        ref: source.config.ref,
        path: source.config.path,
      });
      const slug = deriveRepoSourceName(parsed)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '') || 'skill';
      list.push({
        id: `${source.id}:skill:${slug}`,
        sourceId: source.id,
        kind: 'skill',
        originalName: slug,
        description: `Imported from ${parsed.canonicalUrl}`,
        uri: `skill://${slug}`,
        mimeType: 'text/markdown',
        metadata: {
          skillSlug: slug,
          skillContent: `# ${slug}\n\nImported from ${parsed.canonicalUrl}`,
          tags: source.config.tags ?? [],
        },
        available: source.enabled,
        lastSeenAt: ts,
      });
    } else if (source.config.kind === 'shared_folder') {
      list.push({
        id: `${source.id}:tool:${source.config.shareName}_list`,
        sourceId: source.id,
        kind: 'tool',
        originalName: `${source.config.shareName}_list`,
        description: `List files inside shared folder ${source.config.shareName}`,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          additionalProperties: false,
        },
        available: source.enabled,
        lastSeenAt: ts,
      });
    } else if (
      source.config.kind === 'cli_wrapper' ||
      source.config.kind === 'composite'
    ) {
      list.push({
        id: `${source.id}:tool:${source.config.toolName}`,
        sourceId: source.id,
        kind: 'tool',
        originalName: source.config.toolName,
        description: source.config.description,
        inputSchema: source.config.inputSchema,
        available: source.enabled,
        lastSeenAt: ts,
      });
    } else {
      list.push({
        id: `${source.id}:tool:${source.name}_ping`,
        sourceId: source.id,
        kind: 'tool',
        originalName: `${source.name}_ping`,
        description: `Ping ${source.name}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        available: source.enabled,
        lastSeenAt: ts,
      });
    }
    for (const [k, cap] of capabilities.entries()) {
      if (cap.sourceId === source.id) capabilities.delete(k);
    }
    for (const cap of list) capabilities.set(cap.id, cap);
    return list;
  };

  return {
    mode,
    publicUrl,
    homeDir,
    operatorToken,

    async handleMcpRequest(req, profileName) {
      const auth = req.headers.get('authorization');
      if (!auth || !auth.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
            },
          },
        );
      }
      const tokenValue = auth.slice('Bearer '.length).trim();
      const match = [...tokens.values()].find(
        (t) => !t.revokedAt && t.rawToken === tokenValue,
      );
      if (!match) {
        return new Response(
          JSON.stringify({
            error: { code: 'UNAUTHORIZED', message: 'Invalid bearer token' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      if (profileName && match.profileId !== profileName) {
        const target = profiles.get(match.profileId);
        if (!target || target.name !== profileName) {
          return new Response(
            JSON.stringify({
              error: { code: 'FORBIDDEN', message: 'Token profile mismatch' },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
      }
      if (req.method === 'GET') {
        return new Response('event: ready\ndata: {}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (req.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      const body = (await req.json().catch(() => ({}))) as {
        id?: unknown;
        method?: string;
      };
      if (body.method === 'initialize') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {}, prompts: {}, resources: {} },
              serverInfo: { name: 'agentfabric-mock', version: '0.1.0' },
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': randomUUID(),
            },
          },
        );
      }
      if (body.method === 'tools/list') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: {
              tools: [
                {
                  name: 'fabric_search',
                  description: 'Search pooled capabilities',
                  inputSchema: {
                    type: 'object',
                    properties: { query: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },

    async handleOAuthProtectedResourceMetadata() {
      return new Response(
        JSON.stringify({
          resource: `${publicUrl}/mcp`,
          authorization_servers: [publicUrl],
          bearer_methods_supported: ['header'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },

    async handleOAuthAuthorizationServerMetadata() {
      return new Response(
        JSON.stringify({
          issuer: publicUrl,
          authorization_endpoint: `${publicUrl}/oauth/authorize`,
          token_endpoint: `${publicUrl}/oauth/token`,
          registration_endpoint: `${publicUrl}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },

    async handleOAuthRegister(req) {
      const body = (await req.json().catch(() => ({}))) as {
        client_name?: string;
        redirect_uris?: string[];
      };
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        return new Response(
          JSON.stringify({ error: 'invalid_client_metadata' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const record: OAuthClientRecord = {
        clientId: `client_${randomUUID().slice(0, 8)}`,
        clientName: body.client_name ?? 'Mock MCP Client',
        redirectUris: body.redirect_uris,
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: 'none',
        createdAt: nowIso(),
      };
      oauthClients.set(record.clientId, record);
      return new Response(
        JSON.stringify({
          client_id: record.clientId,
          client_name: record.clientName,
          redirect_uris: record.redirectUris,
          grant_types: record.grantTypes,
          response_types: record.responseTypes,
          token_endpoint_auth_method: record.tokenEndpointAuthMethod,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    },

    async handleOAuthToken() {
      return new Response(
        JSON.stringify({
          access_token: `af_tok_${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },

    async validateOAuthAuthorize(params): Promise<OAuthAuthorizeValidationResult> {
      const clientId = params.get('client_id') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      const codeChallenge = params.get('code_challenge') ?? '';
      const scope = params.get('scope') ?? 'mcp';
      const profileId = params.get('profile') ?? 'default';
      const state = params.get('state') ?? undefined;
      const client = oauthClients.get(clientId);
      if (!client) {
        return { ok: false, error: 'invalid_client', description: 'Unknown client_id' };
      }
      if (!client.redirectUris.includes(redirectUri)) {
        return {
          ok: false,
          error: 'invalid_request',
          description: 'Redirect URI mismatch',
        };
      }
      if (!codeChallenge) {
        return {
          ok: false,
          error: 'invalid_request',
          description: 'PKCE code_challenge required',
        };
      }
      return {
        ok: true,
        client,
        redirectUri,
        codeChallenge,
        scope,
        profileId,
        state,
      };
    },

    async approveOAuthAuthorize(input) {
      const url = new URL(input.redirectUri);
      url.searchParams.set('code', `code_${randomUUID()}`);
      if (input.state) url.searchParams.set('state', input.state);
      return { redirectUrl: url.toString() };
    },

    authenticateOperator(req) {
      const auth = req.headers.get('authorization');
      if (auth === `Bearer ${operatorToken}`) return true;
      const header = req.headers.get('x-operator-token');
      if (header === operatorToken) return true;
      return false;
    },

    async validateAuthTicket(sourceId, ticket) {
      const source = sources.get(sourceId);
      if (!source) return { valid: false, reason: 'Source not found' };
      const entry = authTickets.get(ticket);
      if (!entry || entry.sourceId !== sourceId || entry.expiresAt < Date.now()) {
        return { valid: false, source, reason: 'Invalid or expired auth ticket' };
      }
      return { valid: true, source };
    },

    async completeAuthHandoff(sourceId, ticket, newSecrets) {
      const validation = await this.validateAuthTicket(sourceId, ticket);
      if (!validation.valid || !validation.source) {
        throw new GatewayError(
          'UNAUTHORIZED',
          validation.reason ?? 'Invalid auth ticket',
          401,
        );
      }
      authTickets.delete(ticket);
      for (const [k, v] of Object.entries(newSecrets)) {
        secrets.set(k, { value: v, updatedAt: nowIso() });
      }
      const updated: SourceRecord = {
        ...validation.source,
        health: 'healthy',
        lastError: undefined,
        updatedAt: nowIso(),
      };
      sources.set(sourceId, updated);
      return { source: updated };
    },

    async getUpstreamOAuthStatus(id) {
      const { authConfig } = requireHttpSource(id);
      const oauth = authConfig.kind === 'oauth2' ? authConfig.oauth : undefined;
      return { configured: !!oauth, connected: upstreamConnections.has(id), redirectUri: upstreamRedirectUri,
        hasRefreshToken: false, clientId: oauth?.clientId, authorizationEndpoint: oauth?.authorizationEndpoint,
        tokenEndpoint: oauth?.tokenEndpoint };
    },

    async startUpstreamOAuth(id, options) {
      const source = requireHttpSource(id);
      const oauth = source.authConfig.oauth;
      if (source.authConfig.kind !== 'oauth2' || !oauth) throw new GatewayError('INVALID_INPUT', 'Source is not configured for upstream OAuth');
      const name = oauth.clientSecretName;
      const clientSecret = options?.clientSecret;
      if (clientSecret !== undefined && (!options?.ticket || !name || !clientSecret.length || clientSecret.length > MAX_SECRET_LENGTH)) {
        throw new GatewayError('INVALID_INPUT', 'Unexpected or invalid OAuth client secret');
      }
      if (options?.ticket) {
        const entry = authTickets.get(options.ticket);
        if (!entry || entry.sourceId !== id || entry.expiresAt <= Date.now()) {
          throw new GatewayError('FORBIDDEN', 'Invalid or expired auth ticket');
        }
        if (name && !clientSecret && !secrets.has(name)) {
          throw new GatewayError('AUTH_REQUIRED', 'An OAuth client secret is required');
        }
        authTickets.delete(options.ticket);
        if (name && clientSecret) secrets.set(name, { value: clientSecret, updatedAt: nowIso() });
      }
      if (name && !secrets.has(name)) throw new GatewayError('AUTH_REQUIRED', `Required vault secret '${name}' is missing`);
      const state = randomUUID();
      const codeChallenge = createHash('sha256').update(randomBytes(48).toString('base64url')).digest('base64url');
      const authorizeUrl = new URL(oauth.authorizationEndpoint ?? new URL('/authorize', source.config.url).href);
      for (const [key, value] of Object.entries({ ...oauth.extraAuthParams, state,
        response_type: 'code', redirect_uri: upstreamRedirectUri, client_id: oauth.clientId ?? 'mock-client',
        code_challenge: codeChallenge, code_challenge_method: 'S256', ...(oauth.resource ? { resource: oauth.resource } : {}),
      })) {
        authorizeUrl.searchParams.set(key, value);
      }
      if (oauth.scopes?.length) authorizeUrl.searchParams.set('scope', oauth.scopes.join(' '));
      upstreamStates.set(hashToken(state), { id, expiresAt: Date.now() + 10 * 60_000 });
      return { authorizeUrl: authorizeUrl.href, redirectUri: upstreamRedirectUri };
    },

    async completeUpstreamOAuth(params) {
      const state = params.get('state');
      if (!state) throw new GatewayError('INVALID_INPUT', 'Missing OAuth state parameter');
      const stateHash = hashToken(state);
      const entry = upstreamStates.get(stateHash);
      upstreamStates.delete(stateHash);
      if (!entry || entry.expiresAt <= Date.now()) throw new GatewayError('UNAUTHORIZED', 'OAuth authorization session is invalid or expired');
      const code = params.get('code');
      const error = params.get('error');
      if (error) {
        const vault = new InMemorySecretStore();
        for (const [name, secret] of secrets) await vault.set(name, secret.value);
        const description = params.get('error_description');
        let message = `Upstream OAuth provider denied authorization: ${error}${description ? ': ' + description : ''}`;
        for (const sensitive of [state, code, params.get('access_token'), params.get('refresh_token'), params.get('client_secret')]) {
          if (sensitive) message = message.replaceAll(sensitive, '[REDACTED]');
        }
        throw new GatewayError('AUTH_REQUIRED', vault.redact(message));
      }
      if (!code) throw new GatewayError('INVALID_INPUT', 'Missing OAuth authorization code');
      upstreamConnections.add(entry.id);
      const { source, capabilities } = await this.refreshSource(entry.id);
      return { source, capabilityCount: capabilities.length };
    },

    async disconnectUpstreamOAuth(id) {
      const source = requireHttpSource(id);
      if (!source.authConfig.oauth) throw new GatewayError('INVALID_INPUT', 'Source is not configured for upstream OAuth');
      clearUpstreamOAuth(id);
      sources.set(id, { ...source, health: source.enabled ? 'auth_required' : 'disabled',
        lastError: source.enabled ? 'Upstream OAuth disconnected' : undefined, updatedAt: nowIso() });
    },

    async listSources() {
      return [...sources.values()];
    },

    async getSource(id) {
      return sources.get(id) ?? null;
    },

    async createSource(input: CreateSourceInput) {
      const id = input.id ?? `src_${randomUUID().slice(0, 8)}`;
      if (sources.has(id)) {
        throw new GatewayError('CONFLICT', `Source '${id}' already exists`, 409);
      }
      if (mode === 'remote' && input.kind === 'cli_wrapper') {
        throw new GatewayError(
          'REMOTE_CLI_FORBIDDEN',
          'CLI wrapper sources are disabled in remote mode',
          403,
        );
      }
      const ts = nowIso();
      const record: SourceRecord = {
        id,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled ?? true,
        config: input.config,
        authConfig: input.authConfig ?? { kind: 'none' },
        refreshPolicy: input.refreshPolicy ?? { mode: 'manual' },
        health: input.enabled === false ? 'disabled' : input.authConfig?.oauth ? 'auth_required' : 'healthy',
        lastRefreshedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      };
      sources.set(id, record);
      if (!record.authConfig.oauth) synthesizeCapabilitiesForSource(record);
      return record;
    },

    async updateSource(id: string, patch: UpdateSourceInput) {
      const existing = requireSource(id);
      const updated: SourceRecord = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.config !== undefined ? { config: patch.config } : {}),
        ...(patch.authConfig !== undefined ? { authConfig: patch.authConfig } : {}),
        ...(patch.refreshPolicy !== undefined
          ? { refreshPolicy: patch.refreshPolicy }
          : {}),
        health:
          patch.enabled === false
            ? 'disabled'
            : existing.health === 'disabled'
              ? 'healthy'
              : existing.health,
        updatedAt: nowIso(),
      };
      if (existing.authConfig.oauth && (!updated.authConfig.oauth ||
        (existing.config.kind === 'mcp_http' && updated.config.kind === 'mcp_http' &&
          new URL(existing.config.url).origin !== new URL(updated.config.url).origin))) clearUpstreamOAuth(id);
      if (updated.authConfig.oauth && !upstreamConnections.has(id) && updated.enabled) updated.health = 'auth_required';
      sources.set(id, updated);
      if (updated.health !== 'auth_required' || !updated.authConfig.oauth) synthesizeCapabilitiesForSource(updated);
      return updated;
    },

    async deleteSource(id: string) {
      requireSource(id);
      clearUpstreamOAuth(id);
      sources.delete(id);
      for (const [capId, cap] of capabilities.entries()) {
        if (cap.sourceId === id) {
          capabilities.delete(capId);
          overlays.delete(capId);
        }
      }
    },

    async refreshSource(id: string) {
      const source = requireSource(id);
      if (source.enabled && source.authConfig.oauth && !upstreamConnections.has(id)) {
        const test = await this.testSource(id);
        throw new GatewayError('AUTH_REQUIRED', 'Upstream OAuth authorization is required', { authHandoff: test.authHandoff });
      }
      const caps = synthesizeCapabilitiesForSource(source);
      const updated: SourceRecord = {
        ...source,
        health: source.enabled ? 'healthy' : 'disabled',
        lastRefreshedAt: nowIso(),
        updatedAt: nowIso(),
      };
      sources.set(id, updated);
      return { source: updated, capabilities: caps };
    },

    async testSource(id: string) {
      const source = requireSource(id);
      const interactive = source.authConfig.kind === 'oauth2' && !!source.authConfig.oauth;
      const name = source.authConfig.secretName;
      const error = interactive
        ? upstreamConnections.has(id) ? undefined : 'Upstream OAuth authorization is required'
        : source.authConfig.kind !== 'none' && name && !secrets.has(name) ? `Missing secret '${name}'` : undefined;
      if (error) {
        const ticket = `tkt_${randomUUID().slice(0, 8)}`;
        const expiresAt = Date.now() + 10 * 60_000;
        authTickets.set(ticket, { sourceId: id, expiresAt });
        return {
          ok: false,
          health: 'auth_required',
          latencyMs: 5,
          capabilityCount: 0,
          error,
          authHandoff: {
            sourceId: id,
            authUrl: `${publicUrl}/auth/connect/${encodeURIComponent(id)}?ticket=${ticket}`,
            ...(mode === 'local' && source.authConfig.cliLoginCommand
              ? { cliCommand: source.authConfig.cliLoginCommand }
              : {}),
            reason: `Credentials required for ${source.name}`,
            expiresAt: new Date(expiresAt).toISOString(),
          },
        };
      }
      const count = [...capabilities.values()].filter(
        (c) => c.sourceId === id,
      ).length;
      return {
        ok: source.enabled,
        health: source.health,
        latencyMs: 4,
        capabilityCount: count,
      };
    },

    async listCapabilities(filter?: {
      profileId?: string;
      sourceId?: string;
      kind?: CapabilityKind;
      query?: string;
    }): Promise<EffectiveCapability[]> {
      const profile = filter?.profileId
        ? requireProfile(filter.profileId)
        : requireProfile('default');
      const result: EffectiveCapability[] = [];
      for (const cap of capabilities.values()) {
        if (filter?.sourceId && cap.sourceId !== filter.sourceId) continue;
        if (filter?.kind && cap.kind !== filter.kind) continue;
        const src = sources.get(cap.sourceId);
        if (!src) continue;
        const overlay = overlays.get(cap.id);
        const applied = overlay?.appliedByOperator ? overlay : undefined;
        const exposedName = applied?.displayName ?? cap.originalName;
        const description = applied?.description ?? cap.description;
        if (filter?.query) {
          const q = filter.query.toLowerCase();
          if (
            !exposedName.toLowerCase().includes(q) &&
            !description.toLowerCase().includes(q)
          ) {
            continue;
          }
        }
        result.push({
          id: cap.id,
          sourceId: src.id,
          sourceName: src.name,
          sourceHealth: src.health,
          kind: cap.kind,
          originalName: cap.originalName,
          exposedName,
          description,
          inputSchema: cap.inputSchema,
          uri: cap.uri,
          mimeType: cap.mimeType,
          semanticGroup: applied?.semanticGroup ?? src.name,
          tags: applied?.tags ?? [],
          exposure: applied?.defaultExposure ?? profile.defaultExposure,
          permission: 'allow',
          available: cap.available,
          availabilityReason: cap.availabilityReason,
          hasOverlay: Boolean(applied),
          overlay,
        });
      }
      return result;
    },

    async getCapabilityContent(capabilityId: string) {
      const cap = capabilities.get(capabilityId);
      if (!cap) {
        throw new GatewayError('CAPABILITY_NOT_FOUND', `Capability '${capabilityId}' not found`, 404);
      }
      const src = sources.get(cap.sourceId);
      if (src?.config.kind === 'skill') {
        return {
          uri: cap.uri ?? `skill://${src.config.slug}`,
          mimeType: cap.mimeType ?? 'text/markdown',
          content: src.config.content,
        };
      }
      if (src?.config.kind === 'skill_repo' && typeof cap.metadata?.skillContent === 'string') {
        return {
          uri: cap.uri ?? `skill://${cap.originalName}`,
          mimeType: cap.mimeType ?? 'text/markdown',
          content: cap.metadata.skillContent,
        };
      }
      throw new GatewayError('NOT_FOUND', 'Capability has no previewable skill content', 404);
    },

    async draftOverlay(capabilityId: string, guidance?: string) {
      const cap = capabilities.get(capabilityId);
      if (!cap) {
        throw new GatewayError(
          'CAPABILITY_NOT_FOUND',
          `Capability '${capabilityId}' not found`,
          404,
        );
      }
      const draft: NormalizationOverlay = {
        capabilityId,
        displayName: cap.originalName,
        description: guidance
          ? `${cap.description} (${guidance})`
          : cap.description,
        semanticGroup: 'general',
        tags: ['drafted'],
        defaultExposure: 'direct',
        draftedBy: 'mock-assistant',
        appliedByOperator: false,
        updatedAt: nowIso(),
      };
      overlays.set(capabilityId, draft);
      return draft;
    },

    async applyOverlay(capabilityId, overlay) {
      if (!capabilities.has(capabilityId)) {
        throw new GatewayError(
          'CAPABILITY_NOT_FOUND',
          `Capability '${capabilityId}' not found`,
          404,
        );
      }
      const saved: NormalizationOverlay = {
        ...overlay,
        capabilityId,
        appliedByOperator: true,
        updatedAt: nowIso(),
      };
      overlays.set(capabilityId, saved);
      return saved;
    },

    async deleteOverlay(capabilityId) {
      overlays.delete(capabilityId);
    },

    async listProfiles() {
      return [...profiles.values()];
    },

    async getProfile(idOrName) {
      const direct = profiles.get(idOrName);
      if (direct) return direct;
      for (const p of profiles.values()) {
        if (p.name === idOrName) return p;
      }
      return null;
    },

    async createProfile(input: CreateProfileInput) {
      const id = input.id ?? `prof_${randomUUID().slice(0, 8)}`;
      const ts = nowIso();
      const record: ProfileRecord = {
        id,
        name: input.name,
        description: input.description ?? '',
        defaultExposure: input.defaultExposure ?? 'direct',
        directToolBudget: input.directToolBudget ?? 24,
        rules: input.rules ?? [],
        createdAt: ts,
        updatedAt: ts,
      };
      profiles.set(id, record);
      return record;
    },

    async updateProfile(id: string, patch: UpdateProfileInput) {
      const existing = requireProfile(id);
      const updated: ProfileRecord = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.defaultExposure !== undefined
          ? { defaultExposure: patch.defaultExposure }
          : {}),
        ...(patch.directToolBudget !== undefined
          ? { directToolBudget: patch.directToolBudget }
          : {}),
        ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
        updatedAt: nowIso(),
      };
      profiles.set(existing.id, updated);
      return updated;
    },

    async deleteProfile(id: string) {
      if (id === 'default') {
        throw new GatewayError('CONFLICT', 'Cannot delete default profile', 409);
      }
      requireProfile(id);
      profiles.delete(id);
      const revokedAt = nowIso();
      for (const token of tokens.values()) {
        if (token.profileId === id && !token.revokedAt) token.revokedAt = revokedAt;
      }
    },

    async listTokens() {
      return [...tokens.values()].map(({ rawToken: _raw, ...record }) => record);
    },

    async createToken(input) {
      const profile = requireProfile(input.profileId);
      const raw = `af_tok_${randomUUID().replace(/-/g, '')}`;
      const record: ClientTokenRecord = {
        id: `tok_${randomUUID().slice(0, 8)}`,
        label: input.label,
        profileId: profile.id,
        tokenPrefix: raw.slice(0, 12),
        scopes: input.scopes ?? ['mcp'],
        createdAt: nowIso(),
      };
      tokens.set(record.id, { ...record, rawToken: raw });
      return { token: raw, record };
    },

    async revokeToken(id) {
      const found = tokens.get(id);
      if (!found) {
        throw new GatewayError('NOT_FOUND', `Token '${id}' not found`, 404);
      }
      found.revokedAt = nowIso();
    },

    async listOAuthClients() {
      return [...oauthClients.values()];
    },

    async revokeOAuthClient(clientId) {
      if (!oauthClients.delete(clientId)) {
        throw new GatewayError('NOT_FOUND', `OAuth client '${clientId}' not found`, 404);
      }
      const revokedAt = nowIso();
      for (const token of tokens.values()) {
        if (token.clientId === clientId && !token.revokedAt) {
          token.revokedAt = revokedAt;
        }
      }
    },

    async listSecrets(): Promise<SecretMetadata[]> {
      return [...secrets.entries()].map(([name, meta]) => ({
        name,
        description: meta.description,
        updatedAt: meta.updatedAt,
      }));
    },

    async setSecret(name, value, description) {
      const updatedAt = nowIso();
      secrets.set(name, { value, description, updatedAt });
      return { name, description, updatedAt };
    },

    async deleteSecret(name) {
      secrets.delete(name);
    },

    async listPolicies() {
      return [...policies.values()];
    },

    async createPolicy(input: CreatePolicyInput) {
      const ts = nowIso();
      const rule: SafetyPolicyRule = {
        id: `pol_${randomUUID().slice(0, 8)}`,
        name: input.name,
        description: input.description,
        profileId: input.profileId,
        sourceId: input.sourceId,
        capabilityPattern: input.capabilityPattern,
        action: input.action,
        reason: input.reason,
        draftedBy: input.draftedBy,
        enabled: input.enabled ?? true,
        createdAt: ts,
        updatedAt: ts,
      };
      policies.set(rule.id, rule);
      return rule;
    },

    async deletePolicy(id) {
      if (!policies.delete(id)) {
        throw new GatewayError('NOT_FOUND', `Policy '${id}' not found`, 404);
      }
    },

    async draftPolicy(input) {
      return {
        name: `Draft policy: ${input.description.slice(0, 32)}`,
        description: input.description,
        profileId: input.profileId,
        sourceId: input.sourceId,
        capabilityPattern: '*delete*',
        action: 'require_approval',
        reason: input.description,
        draftedBy: 'mock-assistant',
        enabled: true,
      };
    },

    async listApprovals(status?: ApprovalStatus) {
      const all = [...approvals.values()];
      return status ? all.filter((a) => a.status === status) : all;
    },

    async decideApproval(id, decision, note) {
      const existing = approvals.get(id);
      if (!existing) {
        throw new GatewayError('NOT_FOUND', `Approval '${id}' not found`, 404);
      }
      const updated: ApprovalRequestRecord = {
        ...existing,
        status: decision,
        decidedBy: 'operator',
        decisionNote: note,
        decidedAt: nowIso(),
      };
      approvals.set(id, updated);
      const evt: ApprovalEvent = { type: 'updated', approval: updated };
      emitter.emit('approval', evt);
      return updated;
    },

    subscribeApprovals(listener) {
      emitter.on('approval', listener);
      return () => {
        emitter.off('approval', listener);
      };
    },

    async listProposals(status?: ProposalStatus) {
      const all = [...proposals.values()];
      return status ? all.filter((p) => p.status === status) : all;
    },

    async activateProposal(id, note) {
      const prop = proposals.get(id);
      if (!prop) {
        throw new GatewayError('NOT_FOUND', `Proposal '${id}' not found`, 404);
      }
      const source = await this.createSource({
        name: prop.name,
        kind: prop.kind,
        config: prop.definition,
      });
      const updated: CapabilityProposalRecord = {
        ...prop,
        status: 'activated',
        reviewNote: note,
        activatedSourceId: source.id,
        reviewedAt: nowIso(),
      };
      proposals.set(id, updated);
      return { proposal: updated, source };
    },

    async rejectProposal(id, note) {
      const prop = proposals.get(id);
      if (!prop) {
        throw new GatewayError('NOT_FOUND', `Proposal '${id}' not found`, 404);
      }
      const updated: CapabilityProposalRecord = {
        ...prop,
        status: 'rejected',
        reviewNote: note,
        reviewedAt: nowIso(),
      };
      proposals.set(id, updated);
      return updated;
    },

    async listEventTypes() {
      return [...eventTypes.values()];
    },

    async listEventSubscriptions(profileId?: string) {
      const all = [...eventSubscriptions.values()];
      return profileId ? all.filter((s) => s.profileId === profileId) : all;
    },

    async listEventOccurrences(filter?: EventOccurrenceFilter) {
      let items = eventOccurrences;
      if (filter?.name) {
        items = items.filter((e) => e.name === filter.name);
      }
      if (filter?.afterCursor) {
        const afterNum = Number(filter.afterCursor);
        if (!Number.isNaN(afterNum)) {
          items = items.filter((e) => Number(e.cursor) > afterNum);
        }
      }
      const limit = filter?.limit ?? 100;
      return filter?.order === 'desc' ? items.slice(-limit).reverse() : items.slice(-limit);
    },

    async emitEvent(input) {
      eventCursorSeq += 1;
      const occurrence: McpEventOccurrence = {
        eventId: `evt_${randomUUID().slice(0, 8)}`,
        name: input.name,
        sourceId: input.sourceId ?? 'gateway',
        timestamp: nowIso(),
        data: input.data,
        cursor: String(eventCursorSeq),
      };
      eventOccurrences.push(occurrence);
      return occurrence;
    },

    async deleteEventSubscription(id) {
      if (!eventSubscriptions.delete(id)) {
        throw new GatewayError('NOT_FOUND', `Event subscription '${id}' not found`, 404);
      }
    },

    async getTelemetrySummary(): Promise<TelemetrySummary> {
      const totalCalls = telemetryEvents.length;
      const errorCount = telemetryEvents.filter((e) => e.status !== 'ok').length;
      return {
        totalCalls,
        errorCount,
        errorRate: totalCalls > 0 ? errorCount / totalCalls : 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        bySource: [],
        byCapability: [],
        byProfile: [],
        byStatus: {},
      };
    },

    async listTelemetryEvents(filter) {
      const limit = filter?.limit ?? 100;
      return telemetryEvents.slice(-limit);
    },

    async getCurationHints(): Promise<CurationHint[]> {
      return [];
    },

    async exportConfig(): Promise<PortableConfigBundle> {
      return {
        schemaVersion: 1,
        exportedAt: nowIso(),
        sources: [...sources.values()].map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          enabled: s.enabled,
          config: s.config,
          authConfig: s.authConfig,
          refreshPolicy: s.refreshPolicy,
        })),
        overlays: [...overlays.values()],
        profiles: [...profiles.values()],
        policies: [...policies.values()],
      };
    },

    async importConfig(bundle, options) {
      if (!options?.merge) {
        upstreamStates.clear();
        upstreamConnections.clear();
        sources.clear();
        overlays.clear();
        policies.clear();
      }
      for (const s of bundle.sources) {
        const safeSource =
          !options?.enableExecutables && (s.kind === 'cli_wrapper' || s.kind === 'mcp_stdio')
            ? { ...s, enabled: false }
            : s;
        await this.createSource(safeSource);
      }
      for (const o of bundle.overlays) {
        overlays.set(o.capabilityId, o);
      }
      for (const p of bundle.profiles) {
        profiles.set(p.id, p);
      }
      for (const pol of bundle.policies) {
        policies.set(pol.id, pol);
      }
      return {
        importedSources: bundle.sources.length,
        importedProfiles: bundle.profiles.length,
        importedOverlays: bundle.overlays.length,
        importedPolicies: bundle.policies.length,
      };
    },

    async getStatus(): Promise<GatewayStatus> {
      const allSources = [...sources.values()];
      return {
        mode,
        version: '0.1.0',
        publicUrl,
        homeDir,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        counts: {
          sources: allSources.length,
          healthySources: allSources.filter((s) => s.health === 'healthy').length,
          degradedSources: allSources.filter(
            (s) => s.health !== 'healthy' && s.health !== 'disabled',
          ).length,
          capabilities: capabilities.size,
          profiles: profiles.size,
          pendingApprovals: [...approvals.values()].filter(
            (a) => a.status === 'pending',
          ).length,
          pendingProposals: [...proposals.values()].filter(
            (p) => p.status === 'pending_review',
          ).length,
          activeTokens: [...tokens.values()].filter((t) => !t.revokedAt).length,
          activeEventSubscriptions: eventSubscriptions.size,
        },
      };
    },

    async close() {
      emitter.removeAllListeners();
    },
  };
}
