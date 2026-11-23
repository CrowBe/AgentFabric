export type GatewayMode = 'local' | 'remote';

export type SourceKind =
  | 'mcp_stdio'
  | 'mcp_http'
  | 'cli_wrapper'
  | 'composite'
  | 'skill'
  | 'shared_folder';

export interface RefreshPolicy {
  mode: 'manual' | 'on_connect' | 'interval';
  intervalSeconds?: number;
}

export type SourceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'auth_required'
  | 'error'
  | 'disabled'
  | 'initializing';

export interface SourceAuthConfig {
  kind: 'none' | 'bearer_secret' | 'header_secret' | 'env_secrets' | 'oauth2';
  secretName?: string;
  headerName?: string;
  envMap?: Record<string, string>;
  requiredSecrets?: string[];
  cliLoginCommand?: string;
  instructions?: string;
}

export type JsonSchemaObject = Record<string, unknown>;

export interface McpStdioSourceConfig {
  kind: 'mcp_stdio';
  command: string;
  args: string[];
  cwd?: string;
  envAllowlist?: string[];
  timeoutMs?: number;
}

export interface McpHttpSourceConfig {
  kind: 'mcp_http';
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CliWrapperSourceConfig {
  kind: 'cli_wrapper';
  toolName: string;
  description: string;
  command: string;
  argsTemplate: string[];
  inputSchema: JsonSchemaObject;
  cwd?: string;
  envAllowlist?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  outputMode?: 'text' | 'json';
  authCheckArgs?: string[];
}

export interface CompositeStep {
  id: string;
  capability: string;
  argumentsTemplate: Record<string, unknown>;
}

export interface CompositeSourceConfig {
  kind: 'composite';
  toolName: string;
  description: string;
  inputSchema: JsonSchemaObject;
  steps: CompositeStep[];
  outputTemplate?: unknown;
  maxSteps?: number;
}

export interface SkillSourceConfig {
  kind: 'skill';
  slug: string;
  title: string;
  description: string;
  content: string;
  tags?: string[];
}

export interface SharedFolderSourceConfig {
  kind: 'shared_folder';
  shareName: string;
  rootPath: string;
  readOnly: boolean;
  maxFileBytes?: number;
  allowedExtensions?: string[];
  description?: string;
}

export type SourceConfig =
  | McpStdioSourceConfig
  | McpHttpSourceConfig
  | CliWrapperSourceConfig
  | CompositeSourceConfig
  | SkillSourceConfig
  | SharedFolderSourceConfig;

export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  enabled: boolean;
  config: SourceConfig;
  authConfig: SourceAuthConfig;
  refreshPolicy: RefreshPolicy;
  health: SourceHealthStatus;
  lastError?: string;
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceInput {
  id?: string;
  name: string;
  kind: SourceKind;
  enabled?: boolean;
  config: SourceConfig;
  authConfig?: SourceAuthConfig;
  refreshPolicy?: RefreshPolicy;
}

export interface UpdateSourceInput {
  name?: string;
  enabled?: boolean;
  config?: SourceConfig;
  authConfig?: SourceAuthConfig;
  refreshPolicy?: RefreshPolicy;
}

export type CapabilityKind = 'tool' | 'prompt' | 'resource' | 'skill';

export type ExposureTier = 'direct' | 'searchable' | 'hidden';

export interface PromptArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
}

export interface CapabilityRecord {
  id: string;
  sourceId: string;
  kind: CapabilityKind;
  originalName: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  uri?: string;
  mimeType?: string;
  promptArguments?: PromptArgumentSpec[];
  metadata?: Record<string, unknown>;
  available: boolean;
  availabilityReason?: string;
  lastSeenAt: string;
}

export interface NormalizationOverlay {
  capabilityId: string;
  displayName?: string;
  description?: string;
  parameterDescriptions?: Record<string, string>;
  semanticGroup?: string;
  tags?: string[];
  defaultExposure?: ExposureTier;
  draftedBy?: string;
  draftModel?: string;
  appliedByOperator: boolean;
  updatedAt: string;
}

export type RulePermission = 'allow' | 'require_approval' | 'deny';

export interface EffectiveCapability {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceHealth: SourceHealthStatus;
  kind: CapabilityKind;
  originalName: string;
  exposedName: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  uri?: string;
  mimeType?: string;
  semanticGroup: string;
  tags: string[];
  exposure: ExposureTier;
  permission: RulePermission;
  available: boolean;
  availabilityReason?: string;
  hasOverlay: boolean;
  overlay?: NormalizationOverlay;
}

export interface ProfileRule {
  id: string;
  sourceId?: string;
  capabilityId?: string;
  capabilityPattern?: string;
  group?: string;
  kind?: CapabilityKind;
  exposure?: ExposureTier;
  permission?: RulePermission;
}

export interface ProfileRecord {
  id: string;
  name: string;
  description: string;
  defaultExposure: 'direct' | 'searchable';
  directToolBudget: number;
  rules: ProfileRule[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  id?: string;
  name: string;
  description?: string;
  defaultExposure?: 'direct' | 'searchable';
  directToolBudget?: number;
  rules?: ProfileRule[];
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  defaultExposure?: 'direct' | 'searchable';
  directToolBudget?: number;
  rules?: ProfileRule[];
}

export interface SafetyPolicyRule {
  id: string;
  name: string;
  description?: string;
  profileId?: string;
  sourceId?: string;
  capabilityPattern: string;
  action: RulePermission;
  reason?: string;
  draftedBy?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyInput {
  name: string;
  description?: string;
  profileId?: string;
  sourceId?: string;
  capabilityPattern: string;
  action: RulePermission;
  reason?: string;
  draftedBy?: string;
  enabled?: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequestRecord {
  id: string;
  profileId: string;
  sessionId?: string;
  clientName?: string;
  sourceId: string;
  capabilityId: string;
  toolName: string;
  redactedArguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decisionNote?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export type ProposalStatus = 'pending_review' | 'activated' | 'rejected';

export interface CapabilityProposalRecord {
  id: string;
  kind: 'cli_wrapper' | 'composite';
  name: string;
  description: string;
  profileId?: string;
  proposedBySessionId?: string;
  definition: CliWrapperSourceConfig | CompositeSourceConfig;
  status: ProposalStatus;
  reviewNote?: string;
  activatedSourceId?: string;
  createdAt: string;
  reviewedAt?: string;
}

export type TelemetryStatus =
  | 'ok'
  | 'validation_error'
  | 'auth_required'
  | 'approval_denied'
  | 'approval_timeout'
  | 'upstream_error'
  | 'not_found'
  | 'forbidden';

export interface TelemetryEventRecord {
  id: string;
  timestamp: string;
  profileId: string;
  sessionId?: string;
  clientName?: string;
  sourceId?: string;
  capabilityId?: string;
  toolName: string;
  exposureTier?: ExposureTier;
  status: TelemetryStatus;
  errorCode?: string;
  latencyMs: number;
  inputBytes: number;
  outputBytes: number;
}

export interface TelemetryBreakdownItem {
  key: string;
  label?: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface TelemetrySummary {
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  bySource: TelemetryBreakdownItem[];
  byCapability: TelemetryBreakdownItem[];
  byProfile: TelemetryBreakdownItem[];
  byStatus: Record<string, number>;
}

export interface CurationHint {
  type:
    | 'frequently_searched'
    | 'high_error_rate'
    | 'unused_direct'
    | 'slow_capability';
  capabilityId: string;
  toolName: string;
  sourceId: string;
  message: string;
  metrics: Record<string, number>;
}

export interface ClientTokenRecord {
  id: string;
  label: string;
  profileId: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: string;
}

export interface OAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  profileId: string;
  expiresAt: string;
  createdAt: string;
}

export interface OAuthRefreshTokenRecord {
  tokenHash: string;
  clientId: string;
  profileId: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface AuthTicketRecord {
  ticketHash: string;
  sourceId: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
}

export interface SecretMetadata {
  name: string;
  description?: string;
  updatedAt: string;
}

export type McpEventDeliveryMode = 'poll' | 'push' | 'webhook';

export interface McpEventTypeRecord {
  name: string;
  sourceId: string;
  description: string;
  inputSchema: JsonSchemaObject;
  payloadSchema: JsonSchemaObject;
  supportedModes: McpEventDeliveryMode[];
}

export interface McpEventOccurrence {
  eventId: string;
  name: string;
  sourceId: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string;
}

export interface McpEventSubscriptionRecord {
  id: string;
  profileId: string;
  name: string;
  arguments: Record<string, unknown>;
  mode: McpEventDeliveryMode;
  callbackUrl?: string;
  secretName?: string;
  cursor?: string;
  ttlMs: number;
  refreshBefore: string;
  expiresAt: string;
  createdAt: string;
}

export interface PortableConfigBundle {
  schemaVersion: 1;
  exportedAt: string;
  sources: Array<{
    id: string;
    name: string;
    kind: SourceKind;
    enabled: boolean;
    config: SourceConfig;
    authConfig: SourceAuthConfig;
    refreshPolicy: RefreshPolicy;
  }>;
  overlays: NormalizationOverlay[];
  profiles: ProfileRecord[];
  policies: SafetyPolicyRule[];
}

export interface GatewayStatus {
  mode: GatewayMode;
  version: string;
  publicUrl: string;
  homeDir?: string;
  uptimeSeconds: number;
  counts: {
    sources: number;
    healthySources: number;
    degradedSources: number;
    capabilities: number;
    profiles: number;
    pendingApprovals: number;
    pendingProposals: number;
    activeTokens: number;
    activeEventSubscriptions: number;
  };
}
