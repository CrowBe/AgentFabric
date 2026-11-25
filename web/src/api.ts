import type {
  ApprovalEvent,
  ApprovalRequestRecord,
  ApprovalStatus,
  AuthHandoffInfo,
  CapabilityKind,
  CapabilityProposalRecord,
  ClientTokenRecord,
  CreatePolicyInput,
  CreateProfileInput,
  CreateSourceInput,
  CurationHint,
  EffectiveCapability,
  GatewayStatus,
  McpEventOccurrence,
  McpEventSubscriptionRecord,
  McpEventTypeRecord,
  NormalizationOverlay,
  OAuthClientRecord,
  PortableConfigBundle,
  ProfileRecord,
  ProposalStatus,
  SafetyPolicyRule,
  SecretMetadata,
  SourceHealthStatus,
  SourceRecord,
  TelemetryEventRecord,
  TelemetrySummary,
  UpdateProfileInput,
  UpdateSourceInput,
  UpstreamOAuthStatus,
} from '../../src/types/index.js';

export type {
  ApprovalEvent,
  ApprovalRequestRecord,
  CapabilityProposalRecord,
  ClientTokenRecord,
  CurationHint,
  EffectiveCapability,
  GatewayStatus,
  McpEventOccurrence,
  McpEventSubscriptionRecord,
  McpEventTypeRecord,
  NormalizationOverlay,
  OAuthClientRecord,
  ProfileRecord,
  SafetyPolicyRule,
  SecretMetadata,
  SourceRecord,
  TelemetryEventRecord,
  TelemetrySummary,
  UpstreamOAuthStatus,
};

const TOKEN_KEY = 'agentfabric.operatorToken';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}
let memoryToken: string | null = null;

export function setToken(token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

const signsOutOperator = (error: ApiError): boolean => error.code === 'UNAUTHORIZED' || error.code === 'ERROR';

async function toApiError(response: Response): Promise<ApiError> {
  let code = 'ERROR';
  let message = `Request failed (${response.status})`;
  let details: unknown;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    details = body.error?.details;
  } catch {
  }
  return new ApiError(message, response.status, code, details);
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      accept: 'application/json',
      ...authHeaders(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = await toApiError(response);
    if (response.status === 401 && signsOutOperator(error)) for (const listener of unauthorizedListeners) listener();
    throw error;
  }
  return (await response.json()) as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = (error.details as { issues?: Array<{ path: string; message: string }> } | undefined)
      ?.issues;
    if (issues?.length) {
      return `${error.message}: ${issues.map((i) => `${i.path || 'body'} ${i.message}`).join('; ')}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const enc = encodeURIComponent;
const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export interface RecipeFieldInfo {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'boolean' | 'number' | 'list' | 'json';
  required?: boolean;
  default?: string | number | boolean | string[];
  placeholder?: string;
  help?: string;
}
export interface RecipeInfo {
  id: string;
  title: string;
  description: string;
  kind: SourceRecord['kind'];
  localOnly: boolean;
  fields: RecipeFieldInfo[];
}
export interface ConnectSnippetInfo {
  id: string;
  label: string;
  description: string;
  auth: 'oauth' | 'bearer';
  language: string;
  target: string;
  content: string;
}
export interface ConnectSnippets {
  profile: { id: string; name: string };
  mcpUrl: string;
  tokenPlaceholder: string;
  surfaces: string[];
  localWrites: 'none';
  warnings: string[];
  snippets: ConnectSnippetInfo[];
}
export interface SourceTestResult {
  ok: boolean;
  health: SourceHealthStatus;
  latencyMs: number;
  capabilityCount: number;
  error?: string;
  authHandoff?: AuthHandoffInfo;
}

export const api = {
  status: () => request<GatewayStatus>('GET', '/api/status'),

  sources: () => request<{ sources: SourceRecord[] }>('GET', '/api/sources').then((r) => r.sources),
  createSource: (input: CreateSourceInput) =>
    request<{ source: SourceRecord }>('POST', '/api/sources', input).then((r) => r.source),
  updateSource: (id: string, patch: UpdateSourceInput) =>
    request<{ source: SourceRecord }>('PATCH', `/api/sources/${enc(id)}`, patch).then((r) => r.source),
  deleteSource: (id: string) => request<{ ok: true }>('DELETE', `/api/sources/${enc(id)}`),
  refreshSource: (id: string) =>
    request<{ source: SourceRecord }>('POST', `/api/sources/${enc(id)}/refresh`),
  testSource: (id: string) => request<SourceTestResult>('POST', `/api/sources/${enc(id)}/test`),
  sourceOAuthStatus: (id: string) =>
    request<{ oauth: UpstreamOAuthStatus }>('GET', `/api/sources/${enc(id)}/oauth`).then((r) => r.oauth),
  startSourceOAuth: (id: string) =>
    request<{ authorizeUrl: string; redirectUri: string }>('POST', `/api/sources/${enc(id)}/oauth/start`),
  disconnectSourceOAuth: (id: string) => request<{ ok: true }>('DELETE', `/api/sources/${enc(id)}/oauth`),

  recipes: () => request<{ recipes: RecipeInfo[] }>('GET', '/api/recipes').then((r) => r.recipes),
  instantiateRecipe: (id: string, values: Record<string, unknown>) =>
    request<{ source: SourceRecord }>('POST', `/api/recipes/${enc(id)}/instantiate`, { values }).then(
      (r) => r.source,
    ),

  capabilities: (filter: { profileId?: string; sourceId?: string; kind?: CapabilityKind; query?: string } = {}) =>
    request<{ capabilities: EffectiveCapability[] }>('GET', `/api/capabilities${qs(filter)}`).then(
      (r) => r.capabilities,
    ),
  capabilityContent: (id: string) =>
    request<{ uri: string; mimeType: string; content: string; files?: Record<string, string> }>(
      'GET',
      `/api/capabilities/${enc(id)}/content`,
    ),
  draftOverlay: (id: string, guidance?: string) =>
    request<{ overlay: NormalizationOverlay }>(
      'POST',
      `/api/capabilities/${enc(id)}/overlay/draft`,
      guidance ? { guidance } : {},
    ).then((r) => r.overlay),
  applyOverlay: (id: string, overlay: Record<string, unknown>) =>
    request<{ overlay: NormalizationOverlay }>('PUT', `/api/capabilities/${enc(id)}/overlay`, overlay).then(
      (r) => r.overlay,
    ),
  clearOverlay: (id: string) => request<{ ok: true }>('DELETE', `/api/capabilities/${enc(id)}/overlay`),

  profiles: () => request<{ profiles: ProfileRecord[] }>('GET', '/api/profiles').then((r) => r.profiles),
  createProfile: (input: CreateProfileInput) =>
    request<{ profile: ProfileRecord }>('POST', '/api/profiles', input).then((r) => r.profile),
  updateProfile: (id: string, patch: UpdateProfileInput) =>
    request<{ profile: ProfileRecord }>('PATCH', `/api/profiles/${enc(id)}`, patch).then((r) => r.profile),
  deleteProfile: (id: string) => request<{ ok: true }>('DELETE', `/api/profiles/${enc(id)}`),
  connectSnippets: (id: string) =>
    request<ConnectSnippets>('GET', `/api/profiles/${enc(id)}/connect-snippets`),

  tokens: () => request<{ tokens: ClientTokenRecord[] }>('GET', '/api/tokens').then((r) => r.tokens),
  createToken: (input: { label: string; profileId: string; scopes?: string[] }) =>
    request<{ token: string; record: ClientTokenRecord }>('POST', '/api/tokens', input),
  revokeToken: (id: string) => request<{ ok: true }>('DELETE', `/api/tokens/${enc(id)}`),
  oauthClients: () =>
    request<{ clients: OAuthClientRecord[] }>('GET', '/api/oauth-clients').then((r) => r.clients),
  revokeOAuthClient: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/oauth-clients/${enc(id)}`),

  secrets: () => request<{ secrets: SecretMetadata[] }>('GET', '/api/secrets').then((r) => r.secrets),
  setSecret: (name: string, value: string, description?: string) =>
    request<{ secret: SecretMetadata }>('PUT', `/api/secrets/${enc(name)}`, {
      value,
      ...(description ? { description } : {}),
    }).then((r) => r.secret),
  deleteSecret: (name: string) => request<{ ok: true }>('DELETE', `/api/secrets/${enc(name)}`),

  policies: () => request<{ policies: SafetyPolicyRule[] }>('GET', '/api/policies').then((r) => r.policies),
  createPolicy: (input: CreatePolicyInput) =>
    request<{ policy: SafetyPolicyRule }>('POST', '/api/policies', input).then((r) => r.policy),
  deletePolicy: (id: string) => request<{ ok: true }>('DELETE', `/api/policies/${enc(id)}`),
  draftPolicy: (input: { description: string; profileId?: string; sourceId?: string }) =>
    request<{ policy: Omit<SafetyPolicyRule, 'id' | 'createdAt' | 'updatedAt'> }>(
      'POST',
      '/api/policies/draft',
      input,
    ).then((r) => r.policy),

  approvals: (status?: ApprovalStatus) =>
    request<{ approvals: ApprovalRequestRecord[] }>('GET', `/api/approvals${qs({ status })}`).then(
      (r) => r.approvals,
    ),
  decideApproval: (id: string, decision: 'approved' | 'denied', note?: string) =>
    request<{ approval: ApprovalRequestRecord }>('POST', `/api/approvals/${enc(id)}/decide`, {
      decision,
      ...(note ? { note } : {}),
    }).then((r) => r.approval),

  proposals: (status?: ProposalStatus) =>
    request<{ proposals: CapabilityProposalRecord[] }>('GET', `/api/proposals${qs({ status })}`).then(
      (r) => r.proposals,
    ),
  activateProposal: (id: string, note?: string) =>
    request<{ proposal: CapabilityProposalRecord; source: SourceRecord }>(
      'POST',
      `/api/proposals/${enc(id)}/activate`,
      note ? { note } : {},
    ),
  rejectProposal: (id: string, note?: string) =>
    request<{ proposal: CapabilityProposalRecord }>(
      'POST',
      `/api/proposals/${enc(id)}/reject`,
      note ? { note } : {},
    ),

  eventTypes: () =>
    request<{ eventTypes: McpEventTypeRecord[] }>('GET', '/api/events/types').then((r) => r.eventTypes),
  eventSubscriptions: () =>
    request<{ subscriptions: McpEventSubscriptionRecord[] }>('GET', '/api/events/subscriptions').then(
      (r) => r.subscriptions,
    ),
  deleteEventSubscription: (id: string) =>
    request<{ ok: true }>('DELETE', `/api/events/subscriptions/${enc(id)}`),
  eventOccurrences: (
    filter: { name?: string; afterCursor?: string; limit?: number; order?: 'asc' | 'desc' } = {},
  ) =>
    request<{ occurrences: McpEventOccurrence[] }>('GET', `/api/events/occurrences${qs(filter)}`).then(
      (r) => r.occurrences,
    ),
  emitEvent: (input: { name: string; sourceId?: string; data: Record<string, unknown> }) =>
    request<{ occurrence: McpEventOccurrence }>('POST', '/api/events/emit', input).then((r) => r.occurrence),

  telemetrySummary: (filter: { profileId?: string; sourceId?: string; since?: string } = {}) =>
    request<TelemetrySummary>('GET', `/api/telemetry/summary${qs(filter)}`),
  telemetryEvents: (filter: { profileId?: string; sourceId?: string; limit?: number } = {}) =>
    request<{ events: TelemetryEventRecord[] }>('GET', `/api/telemetry/events${qs(filter)}`).then(
      (r) => r.events,
    ),
  curationHints: (profileId?: string) =>
    request<{ hints: CurationHint[] }>('GET', `/api/telemetry/hints${qs({ profileId })}`).then((r) => r.hints),

  exportConfig: () => request<PortableConfigBundle>('GET', '/api/config/export'),
  importConfig: (bundle: unknown, merge: boolean) =>
    request<{
      importedSources: number;
      importedProfiles: number;
      importedOverlays: number;
      importedPolicies: number;
    }>('POST', '/api/config/import', { bundle, merge }),
};

export async function streamApprovals(
  handlers: {
    onSnapshot(approvals: ApprovalRequestRecord[]): void;
    onEvent(event: ApprovalEvent): void;
    onConnection(connected: boolean): void;
  },
  signal: AbortSignal,
): Promise<void> {
  let delay = 1000;
  while (!signal.aborted) {
    try {
      const response = await fetch('/api/approvals/stream', {
        headers: { accept: 'text/event-stream', ...authHeaders() },
        signal,
      });
      if (response.status === 401) {
        for (const listener of unauthorizedListeners) listener();
        return;
      }
      if (!response.ok || !response.body) throw new Error('stream unavailable');
      handlers.onConnection(true);
      delay = 1000;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          try {
            const parsed: unknown = JSON.parse(data.join('\n'));
            if (event === 'snapshot') {
              handlers.onSnapshot((parsed as { approvals: ApprovalRequestRecord[] }).approvals);
            } else if (event === 'approval') handlers.onEvent(parsed as ApprovalEvent);
          } catch {
          }
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    handlers.onConnection(false);
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 15_000);
  }
}
