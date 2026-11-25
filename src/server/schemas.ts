import { z } from 'zod';
import { upstreamOAuthSchema } from '../validation/upstream-oauth.js';
import {
  GatewayError,
  type CreatePolicyInput,
  type CreateProfileInput,
  type CreateSourceInput,
  type PortableConfigBundle,
  type SourceAuthConfig,
  type SourceConfig,
  type UpdateProfileInput,
  type UpdateSourceInput,
} from '../types/index.js';

export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what = 'request',
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new GatewayError('INVALID_INPUT', `Invalid ${what}`, {
    details: {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
  });
}

const nonEmpty = z.string().min(1).max(4096);
const stringList = z.array(z.string().max(4096)).max(256);
const jsonObject = z.record(z.string(), z.unknown());
const timeoutMs = z.number().int().positive().max(3_600_000);

export const exposureTier = z.enum(['direct', 'searchable', 'hidden']);
export const rulePermission = z.enum(['allow', 'require_approval', 'deny']);
export const capabilityKind = z.enum(['tool', 'prompt', 'resource', 'skill']);
export const sourceKind = z.enum([
  'mcp_stdio',
  'mcp_http',
  'cli_wrapper',
  'composite',
  'skill',
  'skill_repo',
  'shared_folder',
]);

export const sourceConfigSchema: z.ZodType<SourceConfig> = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('mcp_stdio'),
      command: nonEmpty,
      args: stringList,
      cwd: z.string().max(4096).optional(),
      envAllowlist: stringList.optional(),
      timeoutMs: timeoutMs.optional(),
    }),
    z.strictObject({
      kind: z.literal('mcp_http'),
      url: z.url({ protocol: /^https?$/ }),
      headers: z.record(z.string(), z.string()).optional(),
      timeoutMs: timeoutMs.optional(),
    }),
    z.strictObject({
      kind: z.literal('cli_wrapper'),
      toolName: nonEmpty,
      description: z.string().max(4096),
      command: nonEmpty,
      argsTemplate: stringList,
      optionalArgs: z
        .array(
          z.strictObject({
            key: nonEmpty,
            flag: nonEmpty,
            mode: z.enum(['value', 'flag', 'repeat']).optional(),
          }),
        )
        .max(64)
        .optional(),
      inputSchema: jsonObject,
      cwd: z.string().max(4096).optional(),
      envAllowlist: stringList.optional(),
      timeoutMs: timeoutMs.optional(),
      maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
      outputMode: z.enum(['text', 'json']).optional(),
      authCheckArgs: stringList.optional(),
    }),
    z.strictObject({
      kind: z.literal('composite'),
      toolName: nonEmpty,
      description: z.string().max(4096),
      inputSchema: jsonObject,
      steps: z
        .array(
          z.strictObject({
            id: nonEmpty,
            capability: nonEmpty,
            argumentsTemplate: jsonObject,
          }),
        )
        .min(1)
        .max(64),
      outputTemplate: z.unknown().optional(),
      maxSteps: z.number().int().positive().max(64).optional(),
    }),
    z.strictObject({
      kind: z.literal('skill'),
      slug: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/i, 'Invalid skill slug'),
      title: nonEmpty,
      description: z.string().max(4096),
      content: z.string().max(512 * 1024),
      tags: stringList.optional(),
    }),
    z.strictObject({
      kind: z.literal('skill_repo'),
      url: nonEmpty,
      ref: nonEmpty.optional(),
      path: nonEmpty.optional(),
      includeSkills: stringList.optional(),
      tags: stringList.optional(),
    }),
    z.strictObject({
      kind: z.literal('shared_folder'),
      shareName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'Invalid share name'),
      rootPath: nonEmpty,
      readOnly: z.boolean(),
      maxFileBytes: z.number().int().positive().optional(),
      allowedExtensions: stringList.optional(),
      description: z.string().max(4096).optional(),
    }),
  ],
);

export const authConfigSchema: z.ZodType<SourceAuthConfig> = z.strictObject({
  kind: z.enum(['none', 'bearer_secret', 'header_secret', 'env_secrets', 'oauth2']),
  oauth: upstreamOAuthSchema.optional(),
  secretName: z.string().max(256).optional(),
  headerName: z.string().max(256).optional(),
  envMap: z.record(z.string(), z.string()).optional(),
  requiredSecrets: stringList.optional(),
  cliLoginCommand: z.string().max(1024).optional(),
  instructions: z.string().max(4096).optional(),
}).refine(auth => !auth.oauth || auth.kind === 'oauth2', {
  path: ['oauth'], message: 'Interactive OAuth requires oauth2 auth',
}).refine(auth => auth.kind !== 'oauth2' || !!auth.oauth || !!auth.secretName, {
  path: ['secretName'], message: 'Vault secret name is required',
});

export const refreshPolicySchema = z.strictObject({
  mode: z.enum(['manual', 'on_connect', 'interval']),
  intervalSeconds: z.number().int().min(5).max(86_400).optional(),
});

export const createSourceSchema: z.ZodType<CreateSourceInput> = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).optional(),
    name: nonEmpty,
    kind: sourceKind,
    enabled: z.boolean().optional(),
    config: sourceConfigSchema,
    authConfig: authConfigSchema.optional(),
    refreshPolicy: refreshPolicySchema.optional(),
  })
  .refine((v) => v.kind === v.config.kind, {
    path: ['config', 'kind'],
    message: 'config.kind must match kind',
  })
  .refine((v) => !v.authConfig?.oauth || v.config.kind === 'mcp_http', {
    path: ['authConfig', 'oauth'],
    message: 'Interactive OAuth is only supported for mcp_http sources',
  });

export const updateSourceSchema: z.ZodType<UpdateSourceInput> = z
  .strictObject({
    name: nonEmpty.optional(),
    enabled: z.boolean().optional(),
    config: sourceConfigSchema.optional(),
    authConfig: authConfigSchema.optional(),
    refreshPolicy: refreshPolicySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' });

export const profileRuleSchema = z.strictObject({
  id: nonEmpty,
  sourceId: z.string().optional(),
  capabilityId: z.string().optional(),
  capabilityPattern: z.string().optional(),
  group: z.string().optional(),
  kind: capabilityKind.optional(),
  exposure: exposureTier.optional(),
  permission: rulePermission.optional(),
});

const budget = z.number().int().min(0).max(500);

export const createProfileSchema: z.ZodType<CreateProfileInput> = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i, 'Use letters, digits, - _ .'),
  description: z.string().max(2048).optional(),
  defaultExposure: z.enum(['direct', 'searchable']).optional(),
  directToolBudget: budget.optional(),
  rules: z.array(profileRuleSchema).max(512).optional(),
});

export const updateProfileSchema: z.ZodType<UpdateProfileInput> = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).optional(),
    description: z.string().max(2048).optional(),
    defaultExposure: z.enum(['direct', 'searchable']).optional(),
    directToolBudget: budget.optional(),
    rules: z.array(profileRuleSchema).max(512).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' });

export const overlayInputSchema = z.strictObject({
  displayName: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  parameterDescriptions: z.record(z.string(), z.string().max(2048)).optional(),
  semanticGroup: z.string().max(128).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  defaultExposure: exposureTier.optional(),
  draftedBy: z.string().max(128).optional(),
  draftModel: z.string().max(128).optional(),
});

export const overlayDraftSchema = z.strictObject({
  guidance: z.string().max(2048).optional(),
});

export const createPolicySchema: z.ZodType<CreatePolicyInput> = z.strictObject({
  name: nonEmpty,
  description: z.string().max(2048).optional(),
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
  capabilityPattern: nonEmpty,
  action: rulePermission,
  reason: z.string().max(2048).optional(),
  draftedBy: z.string().max(128).optional(),
  enabled: z.boolean().optional(),
});

export const draftPolicySchema = z.strictObject({
  description: z.string().min(1).max(4096),
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
});

export const createTokenSchema = z.strictObject({
  label: z.string().min(1).max(128),
  profileId: nonEmpty,
  scopes: z.array(z.string().min(1).max(64)).max(16).optional(),
});

export const secretNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 'Invalid secret name');

export const setSecretSchema = z.strictObject({
  value: z.string().min(1).max(64 * 1024),
  description: z.string().max(512).optional(),
});

export const decideApprovalSchema = z.strictObject({
  decision: z.enum(['approved', 'denied']),
  note: z.string().max(2048).optional(),
});

export const reviewNoteSchema = z.strictObject({
  note: z.string().max(2048).optional(),
});

export const emitEventSchema = z.strictObject({
  name: nonEmpty,
  sourceId: z.string().optional(),
  data: jsonObject,
});

export const recipeInstantiateSchema = z.strictObject({
  values: z.record(z.string(), z.unknown()),
});

const bundleSourceSchema = z.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  kind: sourceKind,
  enabled: z.boolean(),
  config: sourceConfigSchema,
  authConfig: authConfigSchema,
  refreshPolicy: refreshPolicySchema,
});

const bundleOverlaySchema = overlayInputSchema.extend({
  capabilityId: nonEmpty,
  appliedByOperator: z.boolean(),
  updatedAt: z.string(),
});

const bundleProfileSchema = z.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  description: z.string(),
  defaultExposure: z.enum(['direct', 'searchable']),
  directToolBudget: budget,
  rules: z.array(profileRuleSchema).max(512),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const bundlePolicySchema = z.strictObject({
  id: nonEmpty,
  name: nonEmpty,
  description: z.string().optional(),
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
  capabilityPattern: nonEmpty,
  action: rulePermission,
  reason: z.string().optional(),
  draftedBy: z.string().optional(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const bundleSchema: z.ZodType<PortableConfigBundle> = z.strictObject({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  sources: z.array(bundleSourceSchema).max(1024),
  overlays: z.array(bundleOverlaySchema).max(8192),
  profiles: z.array(bundleProfileSchema).max(256),
  policies: z.array(bundlePolicySchema).max(1024),
});

export const importConfigSchema = z.strictObject({
  bundle: bundleSchema,
  merge: z.boolean().optional(),
  enableExecutables: z.boolean().optional(),
});

const limit = z.coerce.number().int().min(1).max(1000);

export const capabilityQuerySchema = z.strictObject({
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
  kind: capabilityKind.optional(),
  query: z.string().max(256).optional(),
});

export const statusQuerySchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'denied', 'expired']).optional(),
});

export const proposalQuerySchema = z.strictObject({
  status: z.enum(['pending_review', 'activated', 'rejected']).optional(),
});

export const profileQuerySchema = z.strictObject({
  profileId: z.string().optional(),
});

export const occurrenceQuerySchema = z.strictObject({
  name: z.string().optional(),
  afterCursor: z.string().optional(),
  limit: limit.optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const telemetrySummaryQuerySchema = z.strictObject({
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
});

export const telemetryEventsQuerySchema = z.strictObject({
  profileId: z.string().optional(),
  sourceId: z.string().optional(),
  limit: limit.optional(),
});
