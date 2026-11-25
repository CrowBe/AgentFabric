import {
  GatewayError,
  type CreateSourceInput,
  type SourceKind,
} from '../types/index.js';
import { upstreamOAuthSchema } from '../validation/upstream-oauth.js';
import { deriveRepoSourceName, parseGitHubSkillUrl } from '../upstreams/github-skills.js';

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
    id: 'mcp-http-oauth',
    title: 'Remote MCP server (OAuth 2.0 / 2.1)',
    description: 'Connect a remote MCP server through OAuth discovery or a pre-registered client.',
    kind: 'mcp_http',
    localOnly: false,
    fields: [
      nameField,
      { name: 'url', label: 'MCP endpoint URL', type: 'text', required: true, placeholder: 'https://example.com/mcp' },
      { name: 'scopes', label: 'OAuth scopes', type: 'list',
        help: 'Optional OAuth scopes (one per line or comma-separated). Leave empty to use server defaults.' },
      { name: 'clientId', label: 'OAuth client ID', type: 'text',
        help: 'Optional pre-registered OAuth client ID. Leave empty to use Dynamic Client Registration.' },
      { name: 'clientSecretName', label: 'OAuth client secret name', type: 'text', placeholder: 'oauth_client_secret',
        help: 'Optional vault secret name holding your pre-registered client secret.' },
      { name: 'authorizationEndpoint', label: 'Authorization endpoint', type: 'text', placeholder: 'https://auth.example.com/authorize',
        help: 'Optional override; leave empty for automatic discovery.' },
      { name: 'tokenEndpoint', label: 'Token endpoint', type: 'text', placeholder: 'https://auth.example.com/token',
        help: 'Optional override; leave empty for automatic discovery.' },
      { name: 'extraAuthParams', label: 'Extra authorization parameters', type: 'list', placeholder: 'access_type=offline\nprompt=consent',
        help: 'Optional extra authorization query parameters (key=value per line).' },
    ],
    build(values) {
      if (values.extraAuthParams != null && !Array.isArray(values.extraAuthParams) && typeof values.extraAuthParams !== 'string') {
        throw invalid('Extra authorization parameters must be a list of key=value entries');
      }
      const params = lines(values, 'extraAuthParams').map(entry => {
        const split = entry.indexOf('=');
        const key = split < 0 ? '' : entry.slice(0, split).trim();
        if (!key) throw invalid('Extra authorization parameters must use key=value');
        return [key, entry.slice(split + 1).trim()];
      });
      const scopes = list(values, 'scopes');
      const oauth = upstreamOAuthSchema.safeParse({
        ...Object.fromEntries(['clientId', 'clientSecretName', 'authorizationEndpoint', 'tokenEndpoint']
          .flatMap(name => {
            const value = text(values, name, false);
            return value ? [[name, value]] : [];
          })),
        ...(scopes.length ? { scopes } : {}),
        ...(params.length ? { extraAuthParams: Object.fromEntries(params) } : {}),
      });
      if (!oauth.success) throw invalid('Invalid OAuth recipe configuration');
      return {
        name: text(values, 'name', true) as string,
        kind: 'mcp_http',
        config: { kind: 'mcp_http', url: text(values, 'url', true) as string },
        authConfig: { kind: 'oauth2', oauth: oauth.data },
        refreshPolicy: { mode: 'manual' },
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
    title: 'CLI wrapper',
    description: 'Expose one typed CLI invocation with bounded output and explicit argument templating. Local mode only.',
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
  {
    id: 'github-skill-repo',
    title: 'Skills from GitHub repository',
    description:
      'Import a SKILL.md or skill collection directly from a GitHub repository URL and serve it over MCP.',
    kind: 'skill_repo',
    localOnly: false,
    fields: [
      {
        name: 'url',
        label: 'GitHub URL or owner/repo',
        type: 'text',
        required: true,
        placeholder: 'https://github.com/<owner>/<repo>',
        help: 'Accepts repository URLs, /tree/<ref>/<subpath>, /blob/.../SKILL.md, or <owner>/<repo>.',
      },
      {
        name: 'name',
        label: 'Source name (optional)',
        type: 'text',
        placeholder: 'auto-detected from URL',
      },
      {
        name: 'ref',
        label: 'Branch, tag, or commit (optional)',
        type: 'text',
        placeholder: 'HEAD (default branch)',
      },
      {
        name: 'path',
        label: 'Subpath in repo (optional)',
        type: 'text',
        placeholder: 'skills/vision',
      },
      { name: 'includeSkills', label: 'Only include slugs (optional)', type: 'list' },
      { name: 'tags', label: 'Tags (optional)', type: 'list' },
      {
        name: 'secretName',
        label: 'GitHub token secret (private repos)',
        type: 'text',
        placeholder: 'github_pat',
        help: 'Optional vault secret name for private repositories. Not needed for public repos.',
      },
    ],
    build(values) {
      const url = text(values, 'url', true) as string;
      const ref = text(values, 'ref', false);
      const path = text(values, 'path', false);
      const parsed = parseGitHubSkillUrl(url, {
        ...(ref ? { ref } : {}),
        ...(path ? { path } : {}),
      });
      const name = text(values, 'name', false) ?? deriveRepoSourceName(parsed);
      const includeSkills = list(values, 'includeSkills');
      const tags = list(values, 'tags');
      return {
        name,
        kind: 'skill_repo',
        config: {
          kind: 'skill_repo',
          url: parsed.canonicalUrl,
          ...(parsed.ref ? { ref: parsed.ref } : {}),
          ...(parsed.path ? { path: parsed.path } : {}),
          ...(includeSkills.length > 0 ? { includeSkills } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        },
        ...bearerAuth(values),
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
