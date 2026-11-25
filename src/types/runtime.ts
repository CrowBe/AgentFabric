import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  CapabilityKind,
  CapabilityProposalRecord,
  CapabilityRecord,
  ClientTokenRecord,
  CreatePolicyInput,
  CreateProfileInput,
  CreateSourceInput,
  CurationHint,
  EffectiveCapability,
  GatewayMode,
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
} from './domain.js';
import type { AuthHandoffInfo } from './errors.js';
import type { EventOccurrenceFilter, SecretStore, StorageAdapter, TraceStore } from './storage.js';

export interface LlmAssistConfig {
  apiUrl?: string;
  apiKeySecretName?: string;
  apiKey?: string;
  model?: string;
  provider?: 'openai' | 'anthropic';
}

export interface RuntimeOptions {
  mode: GatewayMode;
  homeDir: string;
  publicUrl: string;
  operatorToken?: string;
  approvalTimeoutMs?: number;
  storage?: StorageAdapter;
  traceStore?: TraceStore;
  secrets?: SecretStore;
  llm?: LlmAssistConfig;
  oauthFetch?: typeof fetch;
  allowInsecureLocalOAuth?: boolean;
}

export interface OAuthAuthorizeValidationSuccess {
  ok: true;
  client: OAuthClientRecord;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  profileId: string;
  state?: string;
}

export interface OAuthAuthorizeValidationFailure {
  ok: false;
  error: string;
  description: string;
}

export type OAuthAuthorizeValidationResult =
  | OAuthAuthorizeValidationSuccess
  | OAuthAuthorizeValidationFailure;

export interface ApprovalEvent {
  type: 'created' | 'updated';
  approval: ApprovalRequestRecord;
}

export interface GatewayRuntime {
  readonly mode: GatewayMode;
  readonly publicUrl: string;
  readonly homeDir: string;
  readonly operatorToken: string;

  handleMcpRequest(req: Request, profileName: string | null): Promise<Response>;
  handleOAuthProtectedResourceMetadata(req: Request): Promise<Response>;
  handleOAuthAuthorizationServerMetadata(req: Request): Promise<Response>;
  handleOAuthRegister(req: Request): Promise<Response>;
  handleOAuthToken(req: Request): Promise<Response>;
  validateOAuthAuthorize(
    params: URLSearchParams,
  ): Promise<OAuthAuthorizeValidationResult>;
  approveOAuthAuthorize(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    profileId: string;
    state?: string;
  }): Promise<{ redirectUrl: string }>;

  authenticateOperator(req: Request): boolean;
  validateAuthTicket(
    sourceId: string,
    ticket: string,
  ): Promise<{ valid: boolean; source?: SourceRecord; reason?: string }>;
  completeAuthHandoff(
    sourceId: string,
    ticket: string,
    secrets: Record<string, string>,
  ): Promise<{ source: SourceRecord }>;

  getUpstreamOAuthStatus(sourceId: string): Promise<UpstreamOAuthStatus>;
  startUpstreamOAuth(sourceId: string, options?: { ticket?: string; clientSecret?: string }): Promise<{ authorizeUrl: string; redirectUri: string }>;
  completeUpstreamOAuth(params: URLSearchParams): Promise<{ source: SourceRecord; capabilityCount: number; refreshError?: string }>;
  disconnectUpstreamOAuth(sourceId: string): Promise<void>;

  listSources(): Promise<SourceRecord[]>;
  getSource(id: string): Promise<SourceRecord | null>;
  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  updateSource(id: string, patch: UpdateSourceInput): Promise<SourceRecord>;
  deleteSource(id: string): Promise<void>;
  refreshSource(
    id: string,
  ): Promise<{ source: SourceRecord; capabilities: CapabilityRecord[] }>;
  testSource(id: string): Promise<{
    ok: boolean;
    health: SourceHealthStatus;
    latencyMs: number;
    capabilityCount: number;
    error?: string;
    authHandoff?: AuthHandoffInfo;
  }>;
  listCapabilities(filter?: {
    profileId?: string;
    sourceId?: string;
    kind?: CapabilityKind;
    query?: string;
  }): Promise<EffectiveCapability[]>;
  getCapabilityContent(capabilityId: string): Promise<{
    uri: string;
    mimeType: string;
    content: string;
    files?: Record<string, string>;
  }>;
  draftOverlay(
    capabilityId: string,
    guidance?: string,
  ): Promise<NormalizationOverlay>;
  applyOverlay(
    capabilityId: string,
    overlay: Omit<
      NormalizationOverlay,
      'capabilityId' | 'appliedByOperator' | 'updatedAt'
    >,
  ): Promise<NormalizationOverlay>;
  deleteOverlay(capabilityId: string): Promise<void>;

  listProfiles(): Promise<ProfileRecord[]>;
  getProfile(idOrName: string): Promise<ProfileRecord | null>;
  createProfile(input: CreateProfileInput): Promise<ProfileRecord>;
  updateProfile(id: string, patch: UpdateProfileInput): Promise<ProfileRecord>;
  deleteProfile(id: string): Promise<void>;

  listTokens(): Promise<ClientTokenRecord[]>;
  createToken(input: {
    label: string;
    profileId: string;
    scopes?: string[];
  }): Promise<{ token: string; record: ClientTokenRecord }>;
  revokeToken(id: string): Promise<void>;
  listOAuthClients(): Promise<OAuthClientRecord[]>;
  revokeOAuthClient(clientId: string): Promise<void>;
  listSecrets(): Promise<SecretMetadata[]>;
  setSecret(
    name: string,
    value: string,
    description?: string,
  ): Promise<SecretMetadata>;
  deleteSecret(name: string): Promise<void>;

  listPolicies(): Promise<SafetyPolicyRule[]>;
  createPolicy(input: CreatePolicyInput): Promise<SafetyPolicyRule>;
  deletePolicy(id: string): Promise<void>;
  draftPolicy(input: {
    description: string;
    profileId?: string;
    sourceId?: string;
  }): Promise<Omit<SafetyPolicyRule, 'id' | 'createdAt' | 'updatedAt'>>;
  listApprovals(status?: ApprovalStatus): Promise<ApprovalRequestRecord[]>;
  decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    note?: string,
  ): Promise<ApprovalRequestRecord>;
  subscribeApprovals(listener: (event: ApprovalEvent) => void): () => void;
  listProposals(status?: ProposalStatus): Promise<CapabilityProposalRecord[]>;
  activateProposal(
    id: string,
    note?: string,
  ): Promise<{ proposal: CapabilityProposalRecord; source: SourceRecord }>;
  rejectProposal(
    id: string,
    note?: string,
  ): Promise<CapabilityProposalRecord>;

  listEventTypes(profileId?: string): Promise<McpEventTypeRecord[]>;
  listEventSubscriptions(
    profileId?: string,
  ): Promise<McpEventSubscriptionRecord[]>;
  listEventOccurrences(
    filter?: EventOccurrenceFilter,
  ): Promise<McpEventOccurrence[]>;
  emitEvent(input: {
    name: string;
    sourceId?: string;
    data: Record<string, unknown>;
  }): Promise<McpEventOccurrence>;
  deleteEventSubscription(id: string): Promise<void>;

  getTelemetrySummary(filter?: {
    profileId?: string;
    sourceId?: string;
    since?: string;
  }): Promise<TelemetrySummary>;
  listTelemetryEvents(filter?: {
    profileId?: string;
    sourceId?: string;
    limit?: number;
  }): Promise<TelemetryEventRecord[]>;
  getCurationHints(profileId?: string): Promise<CurationHint[]>;
  exportConfig(): Promise<PortableConfigBundle>;
  importConfig(
    bundle: PortableConfigBundle,
    options?: { merge?: boolean; enableExecutables?: boolean },
  ): Promise<{
    importedSources: number;
    importedProfiles: number;
    importedOverlays: number;
    importedPolicies: number;
  }>;
  getStatus(): Promise<GatewayStatus>;
  close(): Promise<void>;
}
