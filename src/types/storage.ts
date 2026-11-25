import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  AuthTicketRecord,
  CapabilityProposalRecord,
  CapabilityRecord,
  ClientTokenRecord,
  McpEventOccurrence,
  McpEventSubscriptionRecord,
  McpEventTypeRecord,
  NormalizationOverlay,
  OAuthAuthorizationCodeRecord,
  OAuthClientRecord,
  OAuthRefreshTokenRecord,
  ProfileRecord,
  ProposalStatus,
  SafetyPolicyRule,
  SecretMetadata,
  SourceRecord,
  TelemetryEventRecord,
  TelemetrySummary,
  UpstreamOAuthStateRecord,
  UpstreamOAuthTokenRecord,
} from './domain.js';

export interface StoredClientToken extends ClientTokenRecord {
  tokenHash: string;
}

export interface TelemetryEventFilter {
  profileId?: string;
  sourceId?: string;
  since?: string;
  limit?: number;
}

export interface EventOccurrenceFilter {
  name?: string;
  afterCursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface TraceStore {
  append(event: TelemetryEventRecord): Promise<void>;
  query(filter?: TelemetryEventFilter): Promise<TelemetryEventRecord[]>;
  summarize(filter?: TelemetryEventFilter): Promise<TelemetrySummary>;
  close(): Promise<void>;
}

export interface StorageAdapter {
  listSources(): Promise<SourceRecord[]>;
  getSource(id: string): Promise<SourceRecord | null>;
  getSourceByName(name: string): Promise<SourceRecord | null>;
  upsertSource(source: SourceRecord): Promise<void>;
  deleteSource(id: string): Promise<void>;

  listCapabilities(sourceId?: string): Promise<CapabilityRecord[]>;
  getCapability(id: string): Promise<CapabilityRecord | null>;
  replaceSourceCapabilities(
    sourceId: string,
    capabilities: CapabilityRecord[],
  ): Promise<void>;

  listOverlays(): Promise<NormalizationOverlay[]>;
  getOverlay(capabilityId: string): Promise<NormalizationOverlay | null>;
  upsertOverlay(overlay: NormalizationOverlay): Promise<void>;
  deleteOverlay(capabilityId: string): Promise<void>;

  listProfiles(): Promise<ProfileRecord[]>;
  getProfile(idOrName: string): Promise<ProfileRecord | null>;
  upsertProfile(profile: ProfileRecord): Promise<void>;
  deleteProfile(id: string): Promise<void>;

  listPolicies(): Promise<SafetyPolicyRule[]>;
  getPolicy(id: string): Promise<SafetyPolicyRule | null>;
  upsertPolicy(policy: SafetyPolicyRule): Promise<void>;
  deletePolicy(id: string): Promise<void>;

  listApprovals(status?: ApprovalStatus): Promise<ApprovalRequestRecord[]>;
  getApproval(id: string): Promise<ApprovalRequestRecord | null>;
  upsertApproval(approval: ApprovalRequestRecord): Promise<void>;

  listProposals(status?: ProposalStatus): Promise<CapabilityProposalRecord[]>;
  getProposal(id: string): Promise<CapabilityProposalRecord | null>;
  upsertProposal(proposal: CapabilityProposalRecord): Promise<void>;

  appendTelemetryEvent(event: TelemetryEventRecord): Promise<void>;
  listTelemetryEvents(
    filter?: TelemetryEventFilter,
  ): Promise<TelemetryEventRecord[]>;

  listClientTokens(): Promise<ClientTokenRecord[]>;
  getClientTokenByHash(tokenHash: string): Promise<StoredClientToken | null>;
  upsertClientToken(token: StoredClientToken): Promise<void>;
  markClientTokenUsed(id: string, timestamp: string): Promise<void>;
  revokeClientToken(id: string, revokedAt: string): Promise<void>;

  listOAuthClients(): Promise<OAuthClientRecord[]>;
  getOAuthClient(clientId: string): Promise<OAuthClientRecord | null>;
  upsertOAuthClient(client: OAuthClientRecord): Promise<void>;
  deleteOAuthClient(clientId: string): Promise<void>;
  saveOAuthCode(record: OAuthAuthorizationCodeRecord): Promise<void>;
  getOAuthCode(codeHash: string): Promise<OAuthAuthorizationCodeRecord | null>;
  consumeOAuthCode(codeHash: string): Promise<OAuthAuthorizationCodeRecord | null>;
  saveOAuthRefreshToken(record: OAuthRefreshTokenRecord): Promise<void>;
  getOAuthRefreshTokenByHash(
    tokenHash: string,
  ): Promise<OAuthRefreshTokenRecord | null>;
  revokeOAuthRefreshToken(tokenHash: string, revokedAt: string): Promise<void>;
  revokeOAuthRefreshTokensByClient(
    clientId: string,
    revokedAt: string,
  ): Promise<void>;
  revokeOAuthRefreshTokensByProfile(
    profileId: string,
    revokedAt: string,
  ): Promise<void>;

  saveUpstreamOAuthState(record: UpstreamOAuthStateRecord): Promise<void>;
  consumeUpstreamOAuthState(stateHash: string): Promise<UpstreamOAuthStateRecord | null>;
  deleteUpstreamOAuthStatesBySource(sourceId: string): Promise<void>;
  getUpstreamOAuthToken(sourceId: string): Promise<UpstreamOAuthTokenRecord | null>;
  upsertUpstreamOAuthToken(record: UpstreamOAuthTokenRecord): Promise<void>;
  deleteUpstreamOAuthToken(sourceId: string): Promise<void>;

  saveAuthTicket(record: AuthTicketRecord): Promise<void>;
  getAuthTicket(
    sourceId: string,
    ticketHash: string,
  ): Promise<AuthTicketRecord | null>;
  consumeAuthTicket(
    sourceId: string,
    ticketHash: string,
  ): Promise<AuthTicketRecord | null>;

  listEventTypes(): Promise<McpEventTypeRecord[]>;
  upsertEventType(eventType: McpEventTypeRecord): Promise<void>;
  deleteEventTypesBySource(sourceId: string): Promise<void>;
  appendEventOccurrence(occurrence: McpEventOccurrence): Promise<void>;
  listEventOccurrences(filter?: EventOccurrenceFilter): Promise<McpEventOccurrence[]>;
  listEventSubscriptions(
    profileId?: string,
  ): Promise<McpEventSubscriptionRecord[]>;
  getEventSubscription(id: string): Promise<McpEventSubscriptionRecord | null>;
  upsertEventSubscription(
    subscription: McpEventSubscriptionRecord,
  ): Promise<void>;
  deleteEventSubscription(id: string): Promise<void>;

  close(): Promise<void>;
}

export interface SecretStore {
  listMetadata(): Promise<SecretMetadata[]>;
  get(name: string): Promise<string | null>;
  set(name: string, value: string, description?: string): Promise<SecretMetadata>;
  delete(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
  redact(input: string): string;
  redactValue<T>(value: T): T;
}
