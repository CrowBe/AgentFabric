import { z } from 'zod';
import { GatewayError, type GatewayMode, type PortableConfigBundle, type SecretStore, type StorageAdapter } from '../types/index.js';
import { defaultProfile, RecordStorage, type ConfigChange } from './memory.js';
import { redactPatterns } from './secrets.js';

const id = z.string().min(1);
const text = z.string();
const timestamp = z.iso.datetime({ offset: true });
const optionalText = text.optional();
const record = z.record(z.string(), z.unknown());
const strings = z.array(text);
const exposure = z.enum(['direct', 'searchable', 'hidden']);
const permission = z.enum(['allow', 'require_approval', 'deny']);
const capabilityKind = z.enum(['tool', 'prompt', 'resource', 'skill']);
const executable = { command: id, cwd: optionalText, envAllowlist: strings.optional(), timeoutMs: z.int().positive().optional() };
const tool = { toolName: id, description: text, inputSchema: record };

export const sourceConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mcp_stdio'), ...executable, args: strings }),
  z.strictObject({ kind: z.literal('mcp_http'), url: z.url({ protocol: /^https?$/ }), headers: z.record(z.string(), text).optional(), timeoutMs: executable.timeoutMs }),
  z.strictObject({ kind: z.literal('cli_wrapper'), ...executable, ...tool, argsTemplate: strings,
    maxOutputBytes: z.int().positive().optional(), outputMode: z.enum(['text', 'json']).optional(), authCheckArgs: strings.optional() }),
  z.strictObject({ kind: z.literal('composite'), ...tool, steps: z.array(z.strictObject({
    id, capability: id, argumentsTemplate: record,
  })).min(1).max(100), outputTemplate: z.unknown().optional(), maxSteps: z.int().min(1).max(100).optional() }),
  z.strictObject({ kind: z.literal('skill'), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), title: id,
    description: text, content: text, tags: strings.optional() }),
  z.strictObject({ kind: z.literal('shared_folder'), shareName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    rootPath: id, readOnly: z.boolean(), maxFileBytes: z.int().positive().optional(),
    allowedExtensions: strings.optional(), description: optionalText }),
]);

const authSchema = z.strictObject({
  kind: z.enum(['none', 'bearer_secret', 'header_secret', 'env_secrets', 'oauth2']),
  secretName: optionalText, headerName: optionalText, envMap: z.record(z.string(), id).optional(),
  requiredSecrets: strings.optional(), cliLoginCommand: optionalText, instructions: optionalText,
}).superRefine((auth, ctx) => {
  if (['bearer_secret', 'header_secret', 'oauth2'].includes(auth.kind) && !auth.secretName) {
    ctx.addIssue({ code: 'custom', path: ['secretName'], message: 'Vault secret name is required' });
  }
  if (auth.kind === 'header_secret' && (!auth.headerName || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(auth.headerName))) {
    ctx.addIssue({ code: 'custom', path: ['headerName'], message: 'Valid header name is required' });
  }
});

const refreshSchema = z.strictObject({
  mode: z.enum(['manual', 'on_connect', 'interval']),
  intervalSeconds: z.number().positive().max(2_147_000).optional(),
});
const sourceSchema = z.strictObject({
  id, name: id, kind: z.enum(['mcp_stdio', 'mcp_http', 'cli_wrapper', 'composite', 'skill', 'shared_folder']),
  enabled: z.boolean(), config: sourceConfigSchema, authConfig: authSchema, refreshPolicy: refreshSchema,
}).refine(source => source.kind === source.config.kind, { path: ['config', 'kind'], message: 'Source and config kind must agree' });

const dates = { createdAt: timestamp, updatedAt: timestamp };
export const profileSchema = z.strictObject({
  id, name: id, description: text, defaultExposure: z.enum(['direct', 'searchable']),
  directToolBudget: z.int().nonnegative(), rules: z.array(z.strictObject({
    id, sourceId: optionalText, capabilityId: optionalText, capabilityPattern: optionalText,
    group: optionalText, kind: capabilityKind.optional(), exposure: exposure.optional(), permission: permission.optional(),
  })), ...dates,
});
export const policySchema = z.strictObject({
  id, name: id, description: optionalText, profileId: optionalText, sourceId: optionalText,
  capabilityPattern: id, action: permission, reason: optionalText, draftedBy: optionalText,
  enabled: z.boolean(), ...dates,
});
export const overlaySchema = z.strictObject({
  capabilityId: id, displayName: optionalText, description: optionalText,
  parameterDescriptions: z.record(z.string(), text).optional(), semanticGroup: optionalText, tags: strings.optional(),
  defaultExposure: exposure.optional(), draftedBy: optionalText, draftModel: optionalText,
  appliedByOperator: z.boolean(), updatedAt: timestamp,
});

const bundleSchema = z.strictObject({
  schemaVersion: z.literal(1), exportedAt: timestamp, sources: z.array(sourceSchema),
  overlays: z.array(overlaySchema), profiles: z.array(profileSchema), policies: z.array(policySchema),
});

export function parseConfig<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new GatewayError('INVALID_INPUT', 'Invalid gateway configuration', {
    details: { issues: parsed.error.issues.map(({ path, message }) => ({ path: path.map(String).join('.'), message })) },
  });
  return parsed.data;
}

export function ensureSecretFree(value: unknown, secrets?: SecretStore) {
  const seen = new WeakSet<object>();
  function inspect(entry: unknown) {
    if (typeof entry === 'string' && (redactPatterns(entry) !== entry || (secrets && secrets.redact(entry) !== entry))) {
      throw new GatewayError('INVALID_INPUT', 'Configuration contains a raw credential');
    }
    if (entry === null || typeof entry !== 'object') return;
    if (seen.has(entry)) throw new GatewayError('INVALID_INPUT', 'Configuration must be JSON serializable');
    seen.add(entry);
    for (const [key, item] of Object.entries(entry)) { inspect(key); inspect(item); }
    seen.delete(entry);
  }
  inspect(value);
}

export function validateSourceConfig(input: unknown, secrets?: SecretStore) {
  const source = parseConfig(sourceSchema, input);
  if (source.config.kind === 'mcp_http') {
    const url = new URL(source.config.url);
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|key|credential|signature|auth/i.test(key))
      || Object.keys(source.config.headers ?? {}).some(key => /authorization|cookie|token|secret|password|key|credential|signature/i.test(key))) {
      throw new GatewayError('INVALID_INPUT', 'Use vault references for upstream HTTP credentials');
    }
  }
  ensureSecretFree(source, secrets);
  return source;
}

function validateBundle(input: unknown, secrets: SecretStore, mode?: GatewayMode) {
  const bundle = parseConfig(bundleSchema, input);
  ensureSecretFree(bundle, secrets);
  for (const source of bundle.sources) {
    validateSourceConfig(source, secrets);
    if (source.id === 'gateway') throw new GatewayError('INVALID_INPUT', 'Source ID is reserved');
    if (mode === 'remote' && (source.kind === 'cli_wrapper' || source.kind === 'mcp_stdio')) {
      throw new GatewayError('REMOTE_CLI_FORBIDDEN', 'Local CLI and stdio sources require local mode');
    }
  }
  for (const keys of [
    bundle.sources.map(source => source.id), bundle.profiles.map(profile => profile.id),
    bundle.profiles.map(profile => profile.name), bundle.policies.map(policy => policy.id),
    bundle.overlays.map(overlay => overlay.capabilityId),
  ]) if (new Set(keys).size !== keys.length) throw new GatewayError('INVALID_INPUT', 'Configuration contains duplicate identifiers');
  return bundle;
}

export async function exportConfig(storage: StorageAdapter, secrets: SecretStore): Promise<PortableConfigBundle> {
  const [sources, overlays, profiles, policies] = await Promise.all([
    storage.listSources(), storage.listOverlays(), storage.listProfiles(), storage.listPolicies(),
  ]);
  return validateBundle({
    schemaVersion: 1, exportedAt: new Date().toISOString(),
    sources: sources.map(({ id, name, kind, enabled, config, authConfig, refreshPolicy }) =>
      ({ id, name, kind, enabled, config, authConfig, refreshPolicy })),
    overlays, profiles, policies,
  }, secrets);
}

export async function importConfig(
  storage: StorageAdapter,
  secrets: SecretStore,
  input: unknown,
  merge = false,
  mode?: GatewayMode,
  enableExecutables = false,
) {
  const bundle = validateBundle(input, secrets, mode);
  const [oldSources, oldProfiles, oldPolicies, oldOverlays, caps, types] = await Promise.all([
    storage.listSources(), storage.listProfiles(), storage.listPolicies(), storage.listOverlays(),
    storage.listCapabilities(), storage.listEventTypes(),
  ]);
  const affectedIds = new Set(merge ? bundle.sources.map(source => source.id) : oldSources.map(source => source.id));
  const finalProfiles = new Map((merge ? oldProfiles : []).map(profile => [profile.id, profile]));
  for (const profile of bundle.profiles) finalProfiles.set(profile.id, profile);
  if (!finalProfiles.has('default')) finalProfiles.set('default', defaultProfile());
  const aliases = new Map([...finalProfiles.values()].map(profile => [profile.id, profile.id]));
  for (const profile of finalProfiles.values()) {
    const claimed = aliases.get(profile.name);
    if (claimed && claimed !== profile.id) throw new GatewayError('INVALID_INPUT', 'Profile ID or name is in use');
    aliases.set(profile.name, profile.id);
  }
  const timestamp = new Date().toISOString();
  const records = bundle.sources.map(source => {
    const isExecutable = source.kind === 'cli_wrapper' || source.kind === 'mcp_stdio';
    const enabled = isExecutable && !enableExecutables ? false : source.enabled;
    return {
      ...source,
      enabled,
      health: enabled ? ('initializing' as const) : ('disabled' as const),
      createdAt: oldSources.find(old => old.id === source.id)?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  });
  const removedProfiles = oldProfiles.filter(profile => !finalProfiles.has(profile.id));
  if (storage instanceof RecordStorage) {
    const changes: ConfigChange[] = [
      ...caps.filter(cap => affectedIds.has(cap.sourceId)).map(cap => ({ table: 'capabilities' as const, key: cap.id })),
      ...types.filter(type => affectedIds.has(type.sourceId))
        .map(type => ({ table: 'event_types' as const, key: JSON.stringify([type.sourceId, type.name]) })),
      ...removedProfiles.map(profile => ({ table: 'profiles' as const, key: profile.id })),
    ];
    if (!merge) changes.push(
      ...oldSources.map(source => ({ table: 'sources' as const, key: source.id })),
      ...oldPolicies.map(policy => ({ table: 'policies' as const, key: policy.id })),
      ...oldOverlays.map(overlay => ({ table: 'overlays' as const, key: overlay.capabilityId })),
    );
    changes.push(
      ...records.map(row => ({ table: 'sources' as const, key: row.id, row })),
      ...[...finalProfiles.values()].map(row => ({ table: 'profiles' as const, key: row.id, row })),
      ...bundle.policies.map(row => ({ table: 'policies' as const, key: row.id, row })),
      ...bundle.overlays.map(row => ({ table: 'overlays' as const, key: row.capabilityId, row })),
    );
    await storage.applyConfig(changes);
  } else {
    if (!merge) {
      for (const source of oldSources) await storage.deleteSource(source.id);
      for (const overlay of oldOverlays) await storage.deleteOverlay(overlay.capabilityId);
      for (const policy of oldPolicies) await storage.deletePolicy(policy.id);
    } else {
      for (const sourceId of affectedIds) {
        await storage.replaceSourceCapabilities(sourceId, []);
        await storage.deleteEventTypesBySource(sourceId);
      }
    }
    for (const profile of removedProfiles) await storage.deleteProfile(profile.id);
    for (const source of records) await storage.upsertSource(source);
    for (const profile of finalProfiles.values()) await storage.upsertProfile(profile);
    for (const policy of bundle.policies) await storage.upsertPolicy(policy);
    for (const overlay of bundle.overlays) await storage.upsertOverlay(overlay);
  }
  return { importedSources: bundle.sources.length, importedProfiles: bundle.profiles.length,
    importedOverlays: bundle.overlays.length, importedPolicies: bundle.policies.length };
}
