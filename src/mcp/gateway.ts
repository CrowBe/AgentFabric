import { SKILLS_EXTENSION_ID, SKILLS_LIST_METHOD, SKILLS_GET_METHOD, RESOURCES_DIRECTORY_READ_METHOD,
  GetSkillRequestParamsSchema, ReadResourceDirectoryRequestParamsSchema, ListSkillsRequestParamsSchema } from '@modelcontextprotocol/core/ext/skills';
import { UriTemplate, type ElicitationCompleteNotificationParams, type ElicitRequestParams, type ElicitResult } from '@modelcontextprotocol/client';
import type * as T from '../types/index.js';
import { GatewayError } from '../types/index.js';
import type { ClientIdentity } from '../auth/middleware.js';
import { visibleCapability } from '../governance/policy.js';
import type { Proposals } from '../governance/proposals.js';
import type { Telemetry } from '../governance/telemetry.js';
import { repoSkillEntry, skillEntry, skillMimeType, type StoredSkillMetadata } from '../upstreams/skills.js';
import { emptySchema, validateArguments } from '../validation/schema.js';
import { deliveryModes, Events, eventsExtension } from './events.js';

export const serverInfo = { name: 'AgentFabric', version: '0.1.0' };
export const capabilities = {
  tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true },
  events: { deliveryModes: [...deliveryModes] },
  extensions: { [eventsExtension]: { listChanged: true }, [SKILLS_EXTENSION_ID]: { directoryRead: true } },
};

const string = { type: 'string', minLength: 1 };
const object = { type: 'object', additionalProperties: true };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const kinds = ['tool', 'prompt', 'resource', 'skill'];
const builtins = [
  {
    name: 'fabric_search', description: 'Search capabilities available to this profile.',
    inputSchema: schema({ query: string, kind: { enum: kinds }, sourceId: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  },
  {
    name: 'fabric_inspect', description: 'Inspect the schema and availability of a capability.',
    inputSchema: schema({ capability: string, kind: { enum: kinds } }, ['capability']),
  },
  {
    name: 'fabric_call', description: 'Call a capability by its exposed name or ID.',
    inputSchema: schema({ capability: string, kind: { enum: kinds }, arguments: object }, ['capability']),
  },
  {
    name: 'fabric_propose_capability', description: 'Submit a CLI wrapper, composite tool, skill, or GitHub skill repo for operator review.',
    inputSchema: schema({ kind: { enum: ['cli_wrapper', 'composite', 'skill', 'skill_repo'] }, name: string, description: { type: 'string' }, definition: object },
      ['name', 'description', 'definition']),
  },
].map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: false } }));

export type Elicitation = {
  elicit?: (params: ElicitRequestParams) => Promise<ElicitResult>;
  notifyElicitationComplete?: (params: ElicitationCompleteNotificationParams) => void;
};
export type InvocationContext = Elicitation & {
  profileId: string; sessionId?: string; clientName?: string; identity: ClientIdentity; signal?: AbortSignal;
};
type Invoke = (cap: T.EffectiveCapability, args: unknown, context: InvocationContext, resourceUri?: string) => Promise<unknown>;

function find(catalog: T.EffectiveCapability[], name: string, kind?: T.CapabilityKind, exposure?: 'direct') {
  const matches = catalog.filter(cap => (cap.id === name || cap.exposedName === name) &&
    (kind === undefined || (kind === 'resource' && cap.kind === 'skill') || cap.kind === kind));
  const visible = matches.filter(visibleCapability);
  const eligible = exposure === undefined ? visible : visible.filter(cap => cap.exposure === exposure);
  const match = eligible.find(cap => cap.id === name) ?? eligible[0];
  if (match) return match;
  if (matches.length && !visible.length) {
    throw new GatewayError('CAPABILITY_DENIED', 'Capability is denied by profile policy');
  }
  throw new GatewayError('CAPABILITY_NOT_FOUND', 'Capability is unavailable to this profile');
}

function readName(params: Record<string, unknown>, key: string) {
  if (typeof params[key] !== 'string' || !params[key]) throw new GatewayError('INVALID_INPUT', `Expected a non-empty ${key}`);
  return params[key];
}

function callResult(result: unknown) {
  if (result && typeof result === 'object' && Array.isArray(Reflect.get(result, 'content'))) return result;
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) ?? '' }],
    ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}),
  };
}

function publicCapability(cap: T.EffectiveCapability) {
  const { overlay: _overlay, ...visible } = cap;
  return visible;
}

export class McpGateway {
  constructor(private readonly storage: T.StorageAdapter, private readonly secrets: T.SecretStore,
    private readonly catalog: (profileId: string) => Promise<T.EffectiveCapability[]>,
    private readonly invoke: Invoke, private readonly proposals: Proposals, private readonly telemetry: Telemetry,
    readonly events: Events, private readonly publicUrl?: string) {}

  private async resolveSkill(cap: T.EffectiveCapability) {
    const source = await this.storage.getSource(cap.sourceId);
    const redact = (text: string) => this.secrets.redact(text);
    if (source?.config.kind === 'skill') {
      return {
        entry: skillEntry(source.config, redact),
        files: {} as Record<string, string>,
        mainSize: Buffer.byteLength(redact(source.config.content)),
      };
    }
    if (source?.config.kind === 'skill_repo') {
      const raw = await this.storage.getCapability(cap.id);
      const meta = raw?.metadata as StoredSkillMetadata | undefined;
      if (typeof meta?.skillContent === 'string') {
        const entry = repoSkillEntry(cap.originalName, meta, redact);
        const files = Object.fromEntries(
          Object.entries(meta.skillFiles ?? {}).map(([rel, text]) => [rel, redact(text)]),
        );
        return { entry, files, mainSize: Buffer.byteLength(redact(meta.skillContent)) };
      }
    }
    throw new GatewayError('CAPABILITY_NOT_FOUND', 'Skill is unavailable');
  }

  async dispatch(method: string, params: Record<string, unknown>, identity: ClientIdentity, context: InvocationContext): Promise<unknown> {
    if (method === 'ping') return {};
    if (method === 'events/poll') return this.events.poll(identity, params);
    if (method === 'events/subscribe') return this.events.subscribe(identity, params);
    if (method === 'events/unsubscribe') return this.events.unsubscribe(identity, params);
    if (method === 'events/list') {
      return this.secrets.redactValue({ events: (await this.events.listTypes(context.profileId)).map(({ sourceId: _source, supportedModes, ...type }) =>
        ({ ...type, delivery: supportedModes, supportedModes })) });
    }
    if (!['tools/list', 'tools/call', 'prompts/list', 'prompts/get', 'resources/list', 'resources/templates/list',
      'resources/read', SKILLS_LIST_METHOD, SKILLS_GET_METHOD, RESOURCES_DIRECTORY_READ_METHOD].includes(method)) {
      throw new GatewayError('NOT_FOUND', 'Method not found', { details: { rpcCode: -32601 } });
    }

    const catalog = await this.catalog(context.profileId);
    const visible = catalog.filter(visibleCapability);
    const direct = visible.filter(cap => cap.exposure === 'direct');
    const redact = <T>(value: T) => this.secrets.redactValue(value);
    switch (method) {
      case 'tools/list':
        return redact({ tools: [...builtins, ...direct.filter(cap => cap.kind === 'tool').map(cap => ({
          name: cap.exposedName, description: cap.description, inputSchema: cap.inputSchema ?? emptySchema,
        }))] });
      case 'tools/call': {
        const name = readName(params, 'name');
        const args = Object.hasOwn(params, 'arguments') ? params.arguments : {};
        const builtin = builtins.find(tool => tool.name === name);
        if (!builtin) return callResult(await this.invoke(find(catalog, name, 'tool', 'direct'), args, context));
        return this.telemetry.measure({ profileId: context.profileId, sessionId: context.sessionId, clientName: context.clientName, toolName: name }, args, async () => {
          validateArguments(builtin.inputSchema, args);
          switch (name) {
            case 'fabric_search': {
              const q = String(args.query ?? '').toLowerCase();
              const hits = visible.filter(cap => (!args.sourceId || cap.sourceId === args.sourceId)
                && (!args.kind || cap.kind === args.kind) && (!q || [cap.exposedName, cap.description, cap.semanticGroup, ...cap.tags]
                  .some(field => field.toLowerCase().includes(q)))).slice(0, (args.limit as number | undefined) ?? 20);
              if (q) await Promise.all(hits.map(cap => this.telemetry.measure({
                profileId: context.profileId, sessionId: context.sessionId, clientName: context.clientName, toolName: name, sourceId: cap.sourceId, capabilityId: cap.id, exposureTier: cap.exposure,
              }, {}, async () => undefined)));
              return callResult(redact({ capabilities: hits.map(({ inputSchema: _schema, ...cap }) => publicCapability(cap)) }));
            }
            case 'fabric_inspect':
              return callResult(redact(publicCapability(find(catalog, String(args.capability), args.kind as T.CapabilityKind | undefined))));
            case 'fabric_call':
              return callResult(await this.invoke(find(catalog, String(args.capability), args.kind as T.CapabilityKind | undefined),
                args.arguments ?? {}, context));
            default: {
              const created = await this.proposals.create(args, context.profileId, context.sessionId);
              return callResult(redact({ ...created, ...(this.publicUrl ? { reviewUrl: `${this.publicUrl}/#/safety` } : {}) }));
            }
          }
        });
      }
      case 'prompts/list': {
        const prompts = await Promise.all(direct.filter(cap => cap.kind === 'prompt').map(async cap => ({
          name: cap.exposedName, description: cap.description, arguments: (await this.storage.getCapability(cap.id))?.promptArguments,
        })));
        return redact({ prompts });
      }
      case 'prompts/get':
        return this.invoke(find(direct, readName(params, 'name'), 'prompt'),
          Object.hasOwn(params, 'arguments') ? params.arguments : {}, context);
      case 'resources/list': {
        const resources = [];
        for (const cap of visible) {
          if (!cap.uri || (cap.kind !== 'skill' && (cap.kind !== 'resource' || cap.exposure !== 'direct'))) continue;
          const raw = await this.storage.getCapability(cap.id);
          if (raw?.metadata?.uriTemplate && !raw.metadata.share) continue;
          resources.push({ name: cap.exposedName, description: cap.description, uri: cap.uri, mimeType: cap.mimeType });
        }
        return redact({ resources });
      }
      case 'resources/templates/list': {
        const resourceTemplates = [];
        for (const cap of direct.filter(cap => cap.kind === 'resource')) {
          const raw = await this.storage.getCapability(cap.id);
          if (typeof raw?.metadata?.uriTemplate !== 'string') continue;
          resourceTemplates.push({ name: cap.exposedName, uriTemplate: raw.metadata.uriTemplate, description: cap.description, mimeType: cap.mimeType });
        }
        return redact({ resourceTemplates });
      }
      case 'resources/read': {
        const uri = readName(params, 'uri');
        const candidates = visible.filter(cap => cap.kind === 'skill' || (cap.kind === 'resource' && cap.exposure === 'direct'));
        let found = candidates.find(cap => cap.uri === uri)
          ?? candidates.find(cap => cap.kind === 'skill' && cap.uri && uri.startsWith(`${cap.uri}/`));
        if (!found) {
          for (const cap of candidates) {
            const raw = await this.storage.getCapability(cap.id);
            const template = raw?.metadata?.uriTemplate;
            if (typeof template !== 'string') continue;
            if (raw?.metadata?.share ? uri.startsWith(cap.uri ?? '\0') : new UriTemplate(template).match(uri) !== null) {
              found = cap;
              break;
            }
          }
        }
        if (!found) throw new GatewayError('CAPABILITY_NOT_FOUND', 'Resource is unavailable to this profile');
        return this.invoke(found, {}, context, uri);
      }
      case SKILLS_LIST_METHOD: {
        if (!ListSkillsRequestParamsSchema.safeParse(params).success) throw new GatewayError('INVALID_INPUT', 'Invalid skill list parameters');
        const skills = await Promise.all(visible.filter(cap => cap.kind === 'skill' && cap.available).map(async cap =>
          (await this.resolveSkill(cap)).entry));
        return { skills, ttlMs: 0, cacheScope: 'private' };
      }
      case SKILLS_GET_METHOD:
      case RESOURCES_DIRECTORY_READ_METHOD: {
        const parsed = (method === SKILLS_GET_METHOD ? GetSkillRequestParamsSchema : ReadResourceDirectoryRequestParamsSchema).safeParse(params);
        if (!parsed.success) throw new GatewayError('INVALID_INPUT', 'A skill URI is required');
        const normalizedUri = parsed.data.uri.length > 'skill://'.length
          ? parsed.data.uri.replace(/\/SKILL\.md$/, '').replace(/\/+$/, '')
          : parsed.data.uri;
        const cap = visible.find(c => c.kind === 'skill' && c.available && (c.uri === parsed.data.uri || c.uri === normalizedUri));
        if (!cap) throw new GatewayError('CAPABILITY_NOT_FOUND', 'Skill is unavailable to this profile');
        await this.invoke(cap, {}, context, cap.uri);
        const { entry: skill, files, mainSize } = await this.resolveSkill(cap);
        if (method === SKILLS_GET_METHOD) return { skill, ttlMs: 0, cacheScope: 'private' };
        return {
          resources: [
            { uri: skill.uri, name: 'SKILL.md', mimeType: 'text/markdown', size: mainSize },
            ...Object.entries(files).map(([relPath, text]) => ({
              uri: `${skill.uri}/${relPath}`,
              name: relPath,
              mimeType: skillMimeType(relPath),
              size: Buffer.byteLength(text),
            })),
          ],
          ttlMs: 0,
          cacheScope: 'private',
        };
      }
    }
  }
}
