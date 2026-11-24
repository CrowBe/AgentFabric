import { randomUUID } from 'node:crypto';
import type * as T from '../types/index.js';
import { GatewayError } from '../types/index.js';
import { createAuthHandoffs } from '../auth/handoff.js';
import { authenticateOperator, issueClientToken, randomToken } from '../auth/middleware.js';
import { createOAuth } from '../auth/oauth.js';
import { Approvals } from '../governance/approvals.js';
import { createLlmAssist } from '../governance/llm-assist.js';
import { effectiveCatalog, visibleCapability } from '../governance/policy.js';
import { Proposals } from '../governance/proposals.js';
import { Telemetry } from '../governance/telemetry.js';
import { Events } from '../mcp/events.js';
import { McpGateway, serverInfo, type InvocationContext } from '../mcp/gateway.js';
import { McpTransport } from '../mcp/transport.js';
import { defaultProfile } from '../storage/memory.js';
import { ensureSecretFree, exportConfig, importConfig, overlaySchema, parseConfig, policySchema, profileSchema,
  validateSourceConfig } from '../storage/portability.js';
import { EncryptedSecretStore } from '../storage/secrets.js';
import { requireLocalCli } from '../upstreams/cli-wrapper.js';
import { validateComposite } from '../upstreams/composite.js';
import { UpstreamManager } from '../upstreams/manager.js';
import { emptySchema, validateArguments } from '../validation/schema.js';

type CompositeState = { path: string[]; budget: { remaining: number } };

function now() { return new Date().toISOString(); }

export async function createGatewayRuntime(options: T.RuntimeOptions): Promise<T.GatewayRuntime> {
  const { mode, homeDir } = options;
  const url = new URL(options.publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new GatewayError('INVALID_INPUT', 'Invalid gateway public URL');
  }
  const publicUrl = url.href.replace(/\/+$/, '');
  const operatorToken = options.operatorToken ?? randomToken('af_tok_operator_');
  const approvalTimeout = options.approvalTimeoutMs ?? 120_000;
  if (!Number.isInteger(approvalTimeout) || approvalTimeout < 1 || approvalTimeout > 2_147_483_647) {
    throw new GatewayError('INVALID_INPUT', 'Invalid approval timeout');
  }
  const storage = options.storage ?? await (await import('../storage/turso.js')).TursoStorageAdapter.open(homeDir);
  let trace: T.TraceStore | undefined;
  let events: Events | undefined;
  let manager: UpstreamManager | undefined;
  try {
    trace = options.traceStore ?? await (await import('../storage/trace-db.js')).DuckDbTraceStore.open(homeDir);
    const secrets = options.secrets ?? await EncryptedSecretStore.open(homeDir);
    const handoffs = createAuthHandoffs(storage, secrets, publicUrl, mode);
    const { runtime, eventService, upstreams } = buildRuntime(storage, trace, secrets, handoffs);
    events = eventService;
    manager = upstreams;
    if (!await storage.getProfile('default')) await storage.upsertProfile(defaultProfile());
    await events.initialize();
    const sources = await storage.listSources();
    for (const source of sources) manager.schedule(source);
    await manager.refreshAll(sources.filter(source => source.enabled &&
      (source.refreshPolicy.mode === 'interval' || !['mcp_stdio', 'mcp_http'].includes(source.kind))));
    await runtime.listApprovals('pending');
    return runtime;
  } catch (error) {
    await Promise.allSettled([events?.close(), manager?.close()]);
    await Promise.allSettled([trace?.close(), storage.close()]);
    throw error;
  }

  function buildRuntime(storage: T.StorageAdapter, trace: T.TraceStore, secrets: T.SecretStore, handoffs: ReturnType<typeof createAuthHandoffs>) {
    const startedAt = Date.now();
    const emitCatalog = (sourceId?: string, profileId?: string) => eventService.emit({
      name: 'fabric.catalog.changed', sourceId, data: { ...(sourceId ? { sourceId } : {}), ...(profileId ? { profileId } : {}) },
    }).catch(() => {});
    const upstreams = new UpstreamManager(storage, secrets, mode, homeDir, event => eventService.emit(event), handoffs.issue);
    const eventService = new Events(storage, secrets, upstreams);
    const approvals = new Approvals(storage, secrets, publicUrl, approvalTimeout, (name, approval) => eventService.emit({
      name, sourceId: approval.sourceId,
      data: { id: approval.id, profileId: approval.profileId, capabilityId: approval.capabilityId,
        sourceId: approval.sourceId, toolName: approval.toolName, status: approval.status },
    }));
    const proposals = new Proposals(storage, secrets, proposal => eventService.emit({
      name: 'fabric.proposal.created', data: { id: proposal.id, profileId: proposal.profileId, status: proposal.status },
    }));
    const telemetry = new Telemetry(storage, secrets, trace);
    const llm = createLlmAssist(secrets, options.llm);
    const oauth = createOAuth(storage, publicUrl);
    let closing: Promise<void> | undefined;
    let connecting: Promise<unknown> | undefined;
    const sourceCreates = new Set<string>();
    let profileMutation: Promise<unknown> = Promise.resolve();

    function editProfiles<R>(operation: () => Promise<R>) {
      const next = profileMutation.then(operation);
      profileMutation = next.catch(() => {});
      return next;
    }

    async function onConnect() {
      if (!connecting) {
        connecting = storage.listSources().then(sources =>
          upstreams.refreshAll(sources.filter(source => source.enabled && source.refreshPolicy.mode === 'on_connect')))
          .finally(() => { connecting = undefined; });
      }
      await connecting;
    }

    async function profile(idOrName = 'default') {
      const result = await storage.getProfile(idOrName);
      if (!result) throw new GatewayError('NOT_FOUND', 'Profile does not exist');
      return result;
    }

    async function capability(id: string) {
      const result = await storage.getCapability(id);
      if (!result) throw new GatewayError('CAPABILITY_NOT_FOUND', 'Capability does not exist');
      return result;
    }

    async function catalog(profileId: string) { return effectiveCatalog(storage, await profile(profileId)); }

    function liveSource(source: T.SourceRecord) {
      if (source.kind === 'cli_wrapper') requireLocalCli(mode);
      if (source.config.kind !== source.kind) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source kind does not match its configuration');
      if (!source.enabled) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Source is disabled');
    }

    async function guardProposalSource(source: T.SourceRecord) {
      if (!source.id.startsWith('proposal-')) return;
      const proposal = await storage.getProposal(source.id.slice('proposal-'.length));
      if (proposal && (proposal.status !== 'activated' || proposal.activatedSourceId !== source.id)) {
        throw new GatewayError('PROPOSAL_NOT_ACTIVATED', 'The capability proposal is pending operator activation');
      }
    }

    async function invoke(cap: T.EffectiveCapability, args: unknown, context: InvocationContext, resourceUri?: string,
      state: CompositeState = { path: [], budget: { remaining: 100 } }): Promise<unknown> {
      return telemetry.measure({ profileId: context.profileId, sessionId: context.sessionId, clientName: context.clientName, sourceId: cap.sourceId, capabilityId: cap.id,
        toolName: cap.exposedName, exposureTier: cap.exposure }, args, async () => {
        validateArguments(cap.inputSchema ?? emptySchema, args);
        if (!visibleCapability(cap)) throw new GatewayError('CAPABILITY_DENIED', 'Capability is denied by profile policy');
        if (state.path.includes(cap.id) || state.path.length >= 10 || --state.budget.remaining < 0) {
          throw new GatewayError('INVALID_INPUT', 'Composite cycle or execution bound reached');
        }
        if (!await eventService.identityActive(context.identity)) throw new GatewayError('FORBIDDEN', 'Client access was revoked');
        const source = await upstreams.source(cap.sourceId);
        liveSource(source);
        await guardProposalSource(source);
        if (cap.permission === 'require_approval') {
          await approvals.require({ profileId: context.profileId, sessionId: context.sessionId, clientName: context.clientName,
            sourceId: source.id, capabilityId: cap.id,
            toolName: cap.exposedName, reason: 'Operator approval is required by profile policy' }, args);
        }
        const [fresh, raw, latest] = await Promise.all([catalog(context.profileId), capability(cap.id), upstreams.source(cap.sourceId)]);
        const effective = fresh.find(item => item.id === cap.id);
        if (!effective || !visibleCapability(effective) || effective.permission !== cap.permission || source.updatedAt !== latest.updatedAt) {
          throw new GatewayError('CAPABILITY_DENIED', 'Capability or policy changed before execution');
        }
        validateArguments(effective.inputSchema ?? emptySchema, args);
        if (cap.permission === 'require_approval' && !await eventService.identityActive(context.identity)) {
          throw new GatewayError('FORBIDDEN', 'Client access was revoked');
        }
        if (closing) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Gateway is closing');
        liveSource(latest);
        const callArgs = resourceUri === undefined ? args : { ...args, uri: resourceUri };
        const result = await upstreams.invoke(latest, raw, callArgs, async (name, nestedArgs) => {
          const visible = (await catalog(context.profileId)).filter(visibleCapability);
          const nested = visible.find(item => item.kind === 'tool' && item.id === name)
            ?? visible.find(item => item.kind === 'tool' && item.exposedName === name);
          if (!nested) throw new GatewayError('CAPABILITY_NOT_FOUND', 'Composite step capability is unavailable');
          const output = await invoke(nested, nestedArgs, context, undefined, { path: [...state.path, cap.id], budget: state.budget });
          if (output && typeof output === 'object' && Reflect.get(output, 'isError') === true) {
            throw new GatewayError('UPSTREAM_ERROR', 'Composite step returned an error');
          }
          return output;
        });
        return secrets.redactValue(result);
      });
    }

    const gateway = new McpGateway(storage, secrets, catalog, invoke, proposals, telemetry, eventService);
    const transport = new McpTransport(storage, secrets, publicUrl, gateway, onConnect);

    async function saveSource(input: T.CreateSourceInput, proposalActivation = false) {
      const id = input.id ?? randomUUID();
      if ((id.startsWith('proposal-') && !proposalActivation) || id === 'gateway') throw new GatewayError('CONFLICT', 'Source ID is reserved');
      if (sourceCreates.has(id)) throw new GatewayError('CONFLICT', 'Source already exists');
      if (mode === 'remote' && input.kind === 'cli_wrapper') requireLocalCli(mode);
      const validated = validateSourceConfig({ id, name: input.name, kind: input.kind, config: input.config,
        enabled: input.enabled ?? true, authConfig: input.authConfig ?? { kind: 'none' },
        refreshPolicy: input.refreshPolicy ?? { mode: 'manual' } }, secrets);
      if (validated.config.kind === 'composite') validateComposite(validated.config);
      sourceCreates.add(id);
      try {
        if (await storage.getSource(id)) throw new GatewayError('CONFLICT', 'Source already exists');
        const source: T.SourceRecord = { ...validated, health: validated.enabled ? 'initializing' : 'disabled', createdAt: now(), updatedAt: now() };
        await storage.upsertSource(source);
        upstreams.schedule(source);
        if (source.enabled && !proposalActivation) await upstreams.refreshAll([source]);
        return upstreams.source(id);
      } finally { sourceCreates.delete(id); }
    }

    const runtime: T.GatewayRuntime = {
      mode, homeDir, publicUrl, operatorToken,
      ...oauth,
      handleMcpRequest: (request, profileName) => transport.handle(request, profileName),
      authenticateOperator: request => authenticateOperator(request, operatorToken),
      validateAuthTicket: handoffs.validate,
      async completeAuthHandoff(id, ticket, credentials) {
        const source = await handoffs.complete(id, ticket, credentials);
        await upstreams.refreshAll([source]);
        return { source: await upstreams.source(id) };
      },
      listSources: () => storage.listSources(),
      getSource: id => storage.getSource(id),
      createSource: input => saveSource(input),
      async updateSource(id, patch) {
        let updated!: T.SourceRecord;
        await upstreams.mutate(id, async () => {
          const source = await upstreams.source(id);
          if (mode === 'remote' && source.kind === 'cli_wrapper' && patch.enabled !== false) requireLocalCli(mode);
          const validated = validateSourceConfig({
            id, name: patch.name ?? source.name, kind: source.kind, config: patch.config ?? source.config,
            enabled: patch.enabled ?? source.enabled, authConfig: patch.authConfig ?? source.authConfig,
            refreshPolicy: patch.refreshPolicy ?? source.refreshPolicy,
          }, secrets);
          if (validated.config.kind === 'composite') validateComposite(validated.config);
          updated = { ...source, ...validated, health: validated.enabled ? 'initializing' : 'disabled',
            updatedAt: new Date(Math.max(Date.now(), Date.parse(source.updatedAt) + 1)).toISOString() };
          await storage.upsertSource(updated);
          upstreams.schedule(updated);
        });
        await upstreams.refreshAll([updated]);
        await emitCatalog(id);
        return upstreams.source(id);
      },
      async deleteSource(id) {
        await upstreams.mutate(id, async () => {
          await upstreams.source(id);
          upstreams.unschedule(id);
          await storage.deleteSource(id);
        });
        await emitCatalog(id);
      },
      refreshSource: id => upstreams.refresh(id),
      async testSource(id) {
        const start = performance.now();
        await upstreams.source(id);
        try {
          const { source, capabilities } = await upstreams.refresh(id);
          return { ok: source.health === 'healthy', health: source.health, latencyMs: performance.now() - start, capabilityCount: capabilities.length };
        } catch (error) {
          const source = await upstreams.source(id);
          return { ok: false, health: source.health, latencyMs: performance.now() - start, capabilityCount: 0,
            error: error instanceof GatewayError ? secrets.redact(error.message) : 'Source check failed',
            authHandoff: error instanceof GatewayError ? error.authHandoff : undefined };
        }
      },
      async listCapabilities(filter) {
        const query = filter?.query?.toLowerCase();
        return (await catalog(filter?.profileId ?? 'default')).filter(cap =>
          (filter?.sourceId === undefined || cap.sourceId === filter.sourceId) &&
          (filter?.kind === undefined || cap.kind === filter.kind) &&
          (!query || [cap.exposedName, cap.description, cap.semanticGroup, ...cap.tags].some(field => field.toLowerCase().includes(query))));
      },
      async draftOverlay(id, guidance) {
        return secrets.redactValue(await llm.draftOverlay(await capability(id), guidance));
      },
      async applyOverlay(id, overlay) {
        const cap = await capability(id);
        const saved = parseConfig(overlaySchema, { ...overlay, capabilityId: id, appliedByOperator: true, updatedAt: now() });
        ensureSecretFree(saved, secrets);
        await storage.upsertOverlay(saved);
        await emitCatalog(cap.sourceId);
        return saved;
      },
      async deleteOverlay(id) {
        const cap = await storage.getCapability(id);
        await storage.deleteOverlay(id);
        await emitCatalog(cap?.sourceId);
      },
      listProfiles: () => storage.listProfiles(),
      getProfile: id => storage.getProfile(id),
      createProfile: input => editProfiles(async () => {
        const id = input.id ?? randomUUID();
        if (await storage.getProfile(id) || await storage.getProfile(input.name)) throw new GatewayError('CONFLICT', 'Profile ID or name is in use');
        const record = parseConfig(profileSchema, { id, name: input.name, description: input.description ?? '',
          defaultExposure: input.defaultExposure ?? 'direct', directToolBudget: input.directToolBudget ?? 24,
          rules: input.rules ?? [], createdAt: now(), updatedAt: now() });
        await storage.upsertProfile(record);
        return record;
      }),
      updateProfile: (id, patch) => editProfiles(async () => {
        const existing = await profile(id);
        const record = parseConfig(profileSchema, { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, updatedAt: now() });
        const match = await storage.getProfile(record.name);
        if (match && match.id !== record.id) throw new GatewayError('CONFLICT', 'Profile name is in use');
        await storage.upsertProfile(record);
        await emitCatalog(undefined, record.id);
        return record;
      }),
      deleteProfile: id => editProfiles(async () => {
        const record = await profile(id);
        if (record.id === 'default') throw new GatewayError('CONFLICT', 'Cannot delete the default profile');
        for (const token of await storage.listClientTokens()) if (token.profileId === record.id && !token.revokedAt) {
          await storage.revokeClientToken(token.id, now());
        }
        await storage.deleteProfile(record.id);
      }),
      listTokens: () => storage.listClientTokens(),
      async createToken(input) {
        return issueClientToken(storage, { ...input, profileId: (await profile(input.profileId)).id });
      },
      async revokeToken(id) {
        if (!(await storage.listClientTokens()).some(token => token.id === id)) throw new GatewayError('NOT_FOUND', 'Token does not exist');
        await storage.revokeClientToken(id, now());
      },
      listOAuthClients: () => storage.listOAuthClients(),
      listSecrets: () => secrets.listMetadata(),
      setSecret: (name, value, description) => secrets.set(name, value, description),
      deleteSecret: name => secrets.delete(name),
      listPolicies: () => storage.listPolicies(),
      async createPolicy(input) {
        const policy = parseConfig(policySchema, { ...input, id: randomUUID(), enabled: input.enabled ?? true, createdAt: now(), updatedAt: now() });
        ensureSecretFree(policy, secrets);
        await storage.upsertPolicy(policy);
        await emitCatalog(policy.sourceId, policy.profileId);
        return policy;
      },
      async deletePolicy(id) {
        const policy = await storage.getPolicy(id);
        if (!policy) throw new GatewayError('NOT_FOUND', 'Policy does not exist');
        await storage.deletePolicy(id);
        await emitCatalog(policy.sourceId, policy.profileId);
      },
      draftPolicy: llm.draftPolicy,
      async listApprovals(status) {
        await approvals.expirePending();
        return storage.listApprovals(status);
      },
      decideApproval: (id, decision, note) => approvals.decide(id, decision, note),
      subscribeApprovals: listener => approvals.subscribe(listener),
      listProposals: status => storage.listProposals(status),
      async activateProposal(id, note) {
        const activated = await proposals.activate(id, input => saveSource(input, true), note);
        await upstreams.refreshAll([activated.source]);
        return { ...activated, source: await upstreams.source(activated.source.id) };
      },
      rejectProposal: (id, note) => proposals.reject(id, note),
      listEventTypes: profileId => eventService.listTypes(profileId),
      listEventSubscriptions: profileId => eventService.listSubscriptions(profileId),
      listEventOccurrences: filter => storage.listEventOccurrences(filter),
      emitEvent: input => eventService.emit(input),
      deleteEventSubscription: id => eventService.delete(id),
      getTelemetrySummary: filter => telemetry.summarize(filter),
      listTelemetryEvents: filter => telemetry.query(filter),
      async getCurationHints(id) {
        const active = await profile(id);
        return telemetry.hints(await catalog(active.id), active.id);
      },
      exportConfig: () => exportConfig(storage, secrets),
      async importConfig(bundle, importOptions) {
        const result = await editProfiles(() => upstreams.reconfigure(() =>
          importConfig(storage, secrets, bundle, importOptions?.merge ?? false, mode)));
        const current = await storage.listSources();
        await upstreams.refreshAll(current.filter(source => source.enabled &&
          (source.refreshPolicy.mode !== 'manual' || !['mcp_stdio', 'mcp_http'].includes(source.kind))));
        await emitCatalog();
        return result;
      },
      async getStatus() {
        const [sources, caps, profiles, pendingApprovals, pendingProposals, tokens, subscriptions] = await Promise.all([
          storage.listSources(), storage.listCapabilities(), storage.listProfiles(), runtime.listApprovals('pending'),
          storage.listProposals('pending_review'), storage.listClientTokens(), eventService.listSubscriptions(),
        ]);
        return { mode, version: serverInfo.version, publicUrl, homeDir,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          counts: { sources: sources.length, healthySources: sources.filter(source => source.health === 'healthy').length,
            degradedSources: sources.filter(source => !['healthy', 'disabled'].includes(source.health)).length,
            capabilities: caps.length, profiles: profiles.length, pendingApprovals: pendingApprovals.length,
            pendingProposals: pendingProposals.length, activeTokens: tokens.filter(token => !token.revokedAt).length,
            activeEventSubscriptions: subscriptions.length } };
      },
      close() {
        return closing ??= (async () => {
          transport.close();
          await approvals.close();
          await upstreams.close();
          await eventService.close();
          await Promise.all([trace.close(), storage.close()]);
        })();
      },
    };
    return { runtime, eventService, upstreams };
  }
}
