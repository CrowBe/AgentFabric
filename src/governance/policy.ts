import type * as T from '../types/index.js';
import { strictSchema } from '../validation/schema.js';

const rank = { allow: 0, require_approval: 1, deny: 2 } as const;
const reservedTools = new Set(['fabric_search', 'fabric_inspect', 'fabric_call', 'fabric_propose_capability']);

function glob(pattern: string, value: string) {
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) { p++; v++; }
    else if (pattern[p] === '*') { star = p++; retry = v; }
    else if (star !== -1) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export function effectivePermissions(
  profile: T.ProfileRecord, policies: T.SafetyPolicyRule[],
  target: { id: string; sourceId: string; kind?: T.CapabilityKind; originalName: string; exposedName: string; semanticGroup: string },
  defaultExposure: T.ExposureTier = profile.defaultExposure,
) {
  let exposure = defaultExposure;
  let permission: T.RulePermission = 'allow';
  const patternMatches = (pattern: string) => [target.id, target.originalName, target.exposedName].some(name => glob(pattern, name));
  for (const rule of profile.rules) {
    if ((rule.sourceId !== undefined && rule.sourceId !== target.sourceId)
      || (rule.capabilityId !== undefined && rule.capabilityId !== target.id)
      || (rule.kind !== undefined && rule.kind !== target.kind)
      || (rule.group !== undefined && rule.group !== target.semanticGroup)
      || (rule.capabilityPattern !== undefined && !patternMatches(rule.capabilityPattern))) continue;
    exposure = rule.exposure ?? exposure;
    if (rule.permission && rank[rule.permission] > rank[permission]) permission = rule.permission;
  }
  for (const policy of policies) {
    if (policy.enabled && (!policy.profileId || policy.profileId === profile.id)
      && (!policy.sourceId || policy.sourceId === target.sourceId) && patternMatches(policy.capabilityPattern)
      && rank[policy.action] > rank[permission]) permission = policy.action;
  }
  return { exposure: permission === 'deny' ? 'hidden' as const : exposure, permission };
}

export async function effectiveCatalog(storage: T.StorageAdapter, profile: T.ProfileRecord) {
  const [sources, capabilities, overlays, policies] = await Promise.all([
    storage.listSources(), storage.listCapabilities(), storage.listOverlays(), storage.listPolicies(),
  ]);
  const sourceIndex = new Map(sources.map(source => [source.id, source]));
  const overlayIndex = new Map(overlays.filter(overlay => overlay.appliedByOperator).map(overlay => [overlay.capabilityId, overlay]));
  const effective: T.EffectiveCapability[] = [];
  for (const cap of capabilities) {
    const source = sourceIndex.get(cap.sourceId);
    if (!source) continue;
    const overlay = overlayIndex.get(cap.id);
    const exposedName = overlay?.displayName || cap.originalName;
    const semanticGroup = overlay?.semanticGroup ?? source.name;
    const inputSchema = cap.inputSchema && strictSchema(cap.inputSchema);
    if (inputSchema?.properties && overlay?.parameterDescriptions) {
      for (const [key, description] of Object.entries(overlay.parameterDescriptions)) {
        const property = Object.hasOwn(inputSchema.properties, key) && Reflect.get(inputSchema.properties, key);
        if (property && typeof property === 'object' && !Array.isArray(property)) property.description = description;
      }
    }
    const target = { id: cap.id, sourceId: source.id, kind: cap.kind, originalName: cap.originalName, exposedName, semanticGroup };
    const governance = effectivePermissions(profile, policies, target, overlay?.defaultExposure);
    const tags = Array.isArray(cap.metadata?.tags) ? cap.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    effective.push({
      ...target, ...governance, sourceName: source.name, sourceHealth: source.health,
      inputSchema, description: overlay?.description ?? cap.description, uri: cap.uri, mimeType: cap.mimeType,
      tags: overlay?.tags ?? tags, available: cap.available && source.enabled && source.health === 'healthy',
      availabilityReason: source.lastError ?? cap.availabilityReason,
      hasOverlay: Boolean(overlay), overlay,
    });
  }
  effective.sort((a, b) => a.exposedName.localeCompare(b.exposedName) || a.sourceId.localeCompare(b.sourceId) || a.id.localeCompare(b.id));
  const natural = new Set(effective.map(cap => JSON.stringify([cap.kind, cap.exposedName])));
  const used = new Set([...reservedTools].map(name => JSON.stringify(['tool', name])));
  let directTools = 0;
  for (const cap of effective) {
    if (cap.exposure === 'hidden') continue;
    const key = (name: string) => JSON.stringify([cap.kind, name]);
    if (used.has(key(cap.exposedName))) {
      const prefix = cap.sourceId.replace(/[^A-Za-z0-9_.-]/g, '_');
      const base = `${prefix}.${cap.exposedName}`;
      let name = base;
      let suffix = 2;
      while (used.has(key(name)) || natural.has(key(name))) name = `${base}.${suffix++}`;
      cap.exposedName = name;
    }
    used.add(key(cap.exposedName));
    if (cap.kind === 'tool' && cap.exposure === 'direct' && ++directTools > profile.directToolBudget) cap.exposure = 'searchable';
  }
  return effective;
}

export function visibleCapability(cap: T.EffectiveCapability) { return cap.exposure !== 'hidden' && cap.permission !== 'deny'; }

export function sourceDenied(profile: T.ProfileRecord, policies: T.SafetyPolicyRule[], sourceId: string) {
  const everyCapability = (pattern?: string) => pattern === undefined || /^\*+$/.test(pattern);
  return profile.rules.some(rule => rule.permission === 'deny' && (rule.sourceId === undefined || rule.sourceId === sourceId)
      && rule.capabilityId === undefined && rule.kind === undefined && rule.group === undefined && everyCapability(rule.capabilityPattern))
    || policies.some(policy => policy.enabled && policy.action === 'deny' && (!policy.profileId || policy.profileId === profile.id)
      && (!policy.sourceId || policy.sourceId === sourceId) && everyCapability(policy.capabilityPattern));
}
