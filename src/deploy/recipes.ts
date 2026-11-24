import {
  GatewayError,
  type CreateSourceInput,
  type SourceKind,
} from '../types/index.js';

export type RecipeFieldType =
  | 'text'
  | 'textarea'
  | 'boolean'
  | 'number'
  | 'list'
  | 'json';

export interface RecipeField {
  name: string;
  label: string;
  type: RecipeFieldType;
  required?: boolean;
  default?: string | number | boolean | string[];
  placeholder?: string;
  help?: string;
}

export type RecipeValues = Record<string, unknown>;

export interface StarterRecipe {
  id: string;
  title: string;
  description: string;
  kind: SourceKind;
  /** Spawns local processes or reads the local disk, so it is refused in remote mode. */
  localOnly: boolean;
  fields: RecipeField[];
  build(values: RecipeValues): CreateSourceInput;
}

export type RecipeSummary = Omit<StarterRecipe, 'build'>;

const invalid = (message: string): GatewayError =>
  new GatewayError('INVALID_INPUT', message);

function text(values: RecipeValues, name: string, required: boolean): string | undefined {
  const raw = values[name];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw invalid(`'${name}' is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw invalid(`'${name}' must be a string`);
  const trimmed = raw.trim();
  if (!trimmed && required) throw invalid(`'${name}' is required`);
  return trimmed || undefined;
}

function list(values: RecipeValues, name: string): string[] {
  const raw = values[name];
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    if (!raw.every((item) => typeof item === 'string')) {
      throw invalid(`'${name}' must be a list of strings`);
    }
    return raw.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') throw invalid(`'${name}' must be a list of strings`);
  return raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function lines(values: RecipeValues, name: string): string[] {
  const raw = values[name];
  if (Array.isArray(raw)) return list(values, name);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(values: RecipeValues, name: string, fallback: boolean): boolean {
  const raw = values[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw invalid(`'${name}' must be true or false`);
}

function num(values: RecipeValues, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw invalid(`'${name}' must be a positive number`);
  return Math.floor(value);
}

function jsonObject(values: RecipeValues, name: string): Record<string, unknown> {
  const raw = values[name];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { type: 'object', properties: {}, additionalProperties: false };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid(`'${name}' must be valid JSON`);
    }
  }
  if (parsed === undefined || parsed === null) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`'${name}' must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

const nameField: RecipeField = {
  name: 'name',
  label: 'Source name',
  type: 'text',
  required: true,
  placeholder: 'my-source',
};

const bearerFields: RecipeField[] = [
  {
    name: 'secretName',
    label: 'Bearer secret name',
    type: 'text',
    placeholder: 'upstream_token',
    help: 'Name of a gateway secret holding the upstream bearer token. Leave empty for an unauthenticated upstream. Set the value in Auth & Secrets; agents never see it.',
  },
];

function bearerAuth(values: RecipeValues): Pick<CreateSourceInput, 'authConfig'> {
  const secretName = text(values, 'secretName', false);
  return secretName
    ? {
        authConfig: {
          kind: 'bearer_secret',
          secretName,
          requiredSecrets: [secretName],
        },
      }
    : { authConfig: { kind: 'none' } };
}

export const STARTER_RECIPES: readonly StarterRecipe[] = [
  {
    id: 'mcp-stdio-generic',
    title: 'MCP server (stdio command)',
    description:
      'Run any stdio MCP server as a managed child process, for example an npx or uvx launcher. Local mode only.',
    kind: 'mcp_stdio',
    localOnly: true,
    fields: [
      nameField,
      { name: 'command', label: 'Command', type: 'text', required: true, placeholder: 'npx' },
      {
        name: 'args',
        label: 'Arguments (one per line)',
        type: 'list',
        placeholder: '-y\n@scope/some-mcp-server',
      },
      { name: 'cwd', label: 'Working directory', type: 'text' },
      {
        name: 'envAllowlist',
        label: 'Allowed environment variables',
        type: 'list',
        help: 'Only these variables are passed to the child process. Everything else is dropped.',
      },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    ],
    build(values) {
      const cwd = text(values, 'cwd', false);
      const timeoutMs = num(values, 'timeoutMs');
      return {
        name: text(values, 'name', true) as string,
        kind: 'mcp_stdio',
        config: {
          kind: 'mcp_stdio',
          command: text(values, 'command', true) as string,
          args: lines(values, 'args'),
          ...(cwd ? { cwd } : {}),
          envAllowlist: list(values, 'envAllowlist'),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
        refreshPolicy: { mode: 'on_connect' },
      };
    },
  },
  {
    id: 'mcp-http-remote',
    title: 'Remote MCP server (HTTP)',
    description:
      'Pool any remote streamable-HTTP MCP server. Works in local and remote mode.',
    kind: 'mcp_http',
    localOnly: false,
    fields: [
      nameField,
      {
        name: 'url',
        label: 'MCP endpoint URL',
        type: 'text',
        required: true,
        placeholder: 'https://example.com/mcp',
      },
      ...bearerFields,
    ],
    build(values) {
      return {
        name: text(values, 'name', true) as string,
        kind: 'mcp_http',
        config: { kind: 'mcp_http', url: text(values, 'url', true) as string },
        ...bearerAuth(values),
        refreshPolicy: { mode: 'on_connect' },
      };
    },
  },
  {
    id: 'openconnector-http',
    title: 'OpenConnector (HTTP MCP)',
    description:
      'Attach a self-hosted OpenConnector instance through its MCP HTTP endpoint, so connectors come from the open-source project instead of hand-maintained adapters.',
    kind: 'mcp_http',
    localOnly: false,
    fields: [
      nameField,
      {
        name: 'url',
        label: 'OpenConnector MCP endpoint',
        type: 'text',
        required: true,
        placeholder: 'http://127.0.0.1:8080/mcp',
        help: 'The MCP endpoint of your OpenConnector deployment.',
      },
      ...bearerFields,
    ],
    build(values) {
      return {
        name: text(values, 'name', true) as string,
        kind: 'mcp_http',
        config: { kind: 'mcp_http', url: text(values, 'url', true) as string },
        ...bearerAuth(values),
        refreshPolicy: { mode: 'interval', intervalSeconds: 900 },
      };
    },
  },
  {
    id: 'cli-wrapper-readonly',
    title: 'Read-only CLI wrapper',
    description:
      'Expose one CLI invocation as a typed tool with bounded output. Arguments come only from the declared input schema. Local mode only.',
    kind: 'cli_wrapper',
    localOnly: true,
    fields: [
      nameField,
      { name: 'toolName', label: 'Tool name', type: 'text', required: true, placeholder: 'git_log' },
      { name: 'description', label: 'Description', type: 'textarea', required: true },
      { name: 'command', label: 'Command', type: 'text', required: true, placeholder: 'git' },
      {
        name: 'argsTemplate',
        label: 'Argument template (one per line)',
        type: 'list',
        placeholder: 'log\n--oneline\n-n\n{{count}}',
      },
      {
        name: 'inputSchema',
        label: 'Input JSON Schema',
        type: 'json',
        default:
          '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
      },
      { name: 'cwd', label: 'Working directory', type: 'text' },
      { name: 'maxOutputBytes', label: 'Max output bytes', type: 'number', default: 65536 },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 15000 },
    ],
    build(values) {
      const cwd = text(values, 'cwd', false);
      return {
        name: text(values, 'name', true) as string,
        kind: 'cli_wrapper',
        config: {
          kind: 'cli_wrapper',
          toolName: text(values, 'toolName', true) as string,
          description: text(values, 'description', true) as string,
          command: text(values, 'command', true) as string,
          argsTemplate: lines(values, 'argsTemplate'),
          inputSchema: jsonObject(values, 'inputSchema'),
          ...(cwd ? { cwd } : {}),
          envAllowlist: [],
          timeoutMs: num(values, 'timeoutMs') ?? 15_000,
          maxOutputBytes: num(values, 'maxOutputBytes') ?? 65_536,
          outputMode: 'text',
        },
        refreshPolicy: { mode: 'manual' },
      };
    },
  },
  {
    id: 'shared-workspace-folder',
    title: 'Shared workspace folder',
    description:
      'Share one bounded folder with connected harnesses over workspace:// resources. Read-only by default; the gateway never reaches outside the root.',
    kind: 'shared_folder',
    localOnly: false,
    fields: [
      nameField,
      {
        name: 'shareName',
        label: 'Share name',
        type: 'text',
        required: true,
        placeholder: 'notes',
      },
      {
        name: 'rootPath',
        label: 'Folder path',
        type: 'text',
        required: true,
        placeholder: '/home/me/notes',
      },
      { name: 'readOnly', label: 'Read-only', type: 'boolean', default: true },
      { name: 'maxFileBytes', label: 'Max file size (bytes)', type: 'number', default: 1048576 },
      {
        name: 'allowedExtensions',
        label: 'Allowed extensions',
        type: 'list',
        placeholder: '.md\n.txt',
      },
      { name: 'description', label: 'Description', type: 'text' },
    ],
    build(values) {
      const description = text(values, 'description', false);
      const allowed = list(values, 'allowedExtensions');
      return {
        name: text(values, 'name', true) as string,
        kind: 'shared_folder',
        config: {
          kind: 'shared_folder',
          shareName: text(values, 'shareName', true) as string,
          rootPath: text(values, 'rootPath', true) as string,
          readOnly: bool(values, 'readOnly', true),
          maxFileBytes: num(values, 'maxFileBytes') ?? 1_048_576,
          ...(allowed.length > 0 ? { allowedExtensions: allowed } : {}),
          ...(description ? { description } : {}),
        },
        refreshPolicy: { mode: 'manual' },
      };
    },
  },
  {
    id: 'agent-skill',
    title: 'Agent skill',
    description:
      'Publish a reusable skill (markdown) over MCP as skill:// so every harness gets it without local skill folders.',
    kind: 'skill',
    localOnly: false,
    fields: [
      nameField,
      { name: 'slug', label: 'Skill slug', type: 'text', required: true, placeholder: 'code-review' },
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'description', label: 'When to use it', type: 'textarea', required: true },
      { name: 'content', label: 'Skill content (markdown)', type: 'textarea', required: true },
      { name: 'tags', label: 'Tags', type: 'list' },
    ],
    build(values) {
      const tags = list(values, 'tags');
      return {
        name: text(values, 'name', true) as string,
        kind: 'skill',
        config: {
          kind: 'skill',
          slug: text(values, 'slug', true) as string,
          title: text(values, 'title', true) as string,
          description: text(values, 'description', true) as string,
          content: text(values, 'content', true) as string,
          ...(tags.length > 0 ? { tags } : {}),
        },
        refreshPolicy: { mode: 'manual' },
      };
    },
  },
];

export function listRecipes(): RecipeSummary[] {
  return STARTER_RECIPES.map(({ build: _build, ...summary }) => summary);
}

export function getRecipe(id: string): StarterRecipe | undefined {
  return STARTER_RECIPES.find((recipe) => recipe.id === id);
}

/** Turn operator-entered recipe values into a source create input. */
export function instantiateRecipe(
  id: string,
  values: RecipeValues,
): { recipe: StarterRecipe; input: CreateSourceInput } {
  const recipe = getRecipe(id);
  if (!recipe) throw new GatewayError('NOT_FOUND', `Recipe '${id}' not found`);
  const known = new Set(recipe.fields.map((field) => field.name));
  const unexpected = Object.keys(values).filter((key) => !known.has(key));
  if (unexpected.length > 0) {
    throw invalid(`Unexpected recipe fields: ${unexpected.join(', ')}`);
  }
  return { recipe, input: recipe.build(values) };
}
