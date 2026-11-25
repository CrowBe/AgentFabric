import type { CreateSourceInput, SourceKind, UpstreamOAuthConfig } from '../../../src/types/index.js';
import type { RecipeFieldInfo } from '../api';
import { SelectField, SwitchField, TextAreaField, TextField, lines, parseJsonObject } from './ui';

export type FormValues = Record<string, unknown>;

export function initialValues(fields: RecipeFieldInfo[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const fallback = field.default;
    if (field.type === 'boolean') values[field.name] = Boolean(fallback ?? false);
    else if (Array.isArray(fallback)) values[field.name] = fallback.join('\n');
    else values[field.name] = fallback === undefined ? '' : String(fallback);
  }
  return values;
}

export function DynamicForm({
  fields,
  values,
  onChange,
}: {
  fields: RecipeFieldInfo[];
  values: FormValues;
  onChange: (name: string, value: unknown) => void;
}) {
  return (
    <>
      {fields.map((field) => {
        const text = String(values[field.name] ?? '');
        const label = field.required ? `${field.label} (required)` : field.label;
        switch (field.type) {
          case 'boolean':
            return (
              <SwitchField
                key={field.name}
                label={field.label}
                checked={Boolean(values[field.name])}
                onChange={(next) => onChange(field.name, next)}
                description={field.help}
              />
            );
          case 'textarea':
          case 'list':
          case 'json':
            return (
              <TextAreaField
                key={field.name}
                label={label}
                value={text}
                onChange={(next) => onChange(field.name, next)}
                description={field.help}
                placeholder={field.placeholder}
                required={field.required}
                rows={field.type === 'textarea' ? 4 : 3}
                mono={field.type !== 'textarea'}
              />
            );
          default:
            return (
              <TextField
                key={field.name}
                label={label}
                value={text}
                onChange={(next) => onChange(field.name, next)}
                description={field.help}
                placeholder={field.placeholder}
                required={field.required}
                type={field.type === 'number' ? 'number' : 'text'}
                mono={field.name === 'url' || field.name === 'command' || field.name === 'rootPath'}
              />
            );
        }
      })}
    </>
  );
}

export const OAUTH_FIELD_NAMES = new Set([
  'scopes',
  'clientId',
  'clientSecretName',
  'authorizationEndpoint',
  'tokenEndpoint',
  'extraAuthParams',
]);

const name: RecipeFieldInfo = { name: 'name', label: 'Source name', type: 'text', required: true };

export const CUSTOM_FIELDS: Record<SourceKind, RecipeFieldInfo[]> = {
  mcp_stdio: [
    name,
    { name: 'command', label: 'Command', type: 'text', required: true, placeholder: 'npx' },
    { name: 'args', label: 'Arguments (one per line)', type: 'list' },
    { name: 'cwd', label: 'Working directory', type: 'text' },
    { name: 'envAllowlist', label: 'Allowed environment variables', type: 'list' },
    {
      name: 'envSecrets',
      label: 'Environment secrets (VAR=secret_name per line)',
      type: 'list',
      help: 'Injected from the vault at spawn time. Agents never see the values.',
    },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
  ],
  mcp_http: [
    name,
    { name: 'url', label: 'MCP endpoint URL', type: 'text', required: true, placeholder: 'https://example.com/mcp' },
    {
      name: 'secretName',
      label: 'Bearer secret name',
      type: 'text',
      help: 'Leave empty for an unauthenticated or OAuth upstream.',
    },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number' },
    {
      name: 'useOAuth',
      label: 'Use OAuth 2.0 / 2.1',
      type: 'boolean',
      help: 'Enable interactive browser OAuth sign-in with PKCE and automatic token refresh.',
    },
    {
      name: 'scopes',
      label: 'OAuth scopes',
      type: 'list',
      help: 'Optional. One per line or comma-separated. Leave empty to use server defaults.',
    },
    {
      name: 'clientId',
      label: 'OAuth client ID',
      type: 'text',
      help: 'Optional pre-registered client ID. Leave empty to use Dynamic Client Registration.',
    },
    {
      name: 'clientSecretName',
      label: 'OAuth client secret name',
      type: 'text',
      help: 'Optional vault secret name holding the pre-registered client secret.',
    },
    {
      name: 'authorizationEndpoint',
      label: 'Authorization endpoint',
      type: 'text',
      placeholder: 'https://auth.example.com/authorize',
      help: 'Optional override; leave empty for automatic discovery.',
    },
    {
      name: 'tokenEndpoint',
      label: 'Token endpoint',
      type: 'text',
      placeholder: 'https://auth.example.com/token',
      help: 'Optional override; leave empty for automatic discovery.',
    },
    {
      name: 'extraAuthParams',
      label: 'Extra authorization parameters',
      type: 'list',
      placeholder: 'access_type=offline\nprompt=consent',
      help: 'Optional extra authorization parameters (key=value per line).',
    },
  ],
  cli_wrapper: [
    name,
    { name: 'toolName', label: 'Tool name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'command', label: 'Command', type: 'text', required: true },
    { name: 'argsTemplate', label: 'Argument template (one per line)', type: 'list' },
    {
      name: 'inputSchema',
      label: 'Input JSON Schema',
      type: 'json',
      default: '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
    },
    { name: 'maxOutputBytes', label: 'Max output bytes', type: 'number', default: 65536 },
    { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 15000 },
  ],
  composite: [
    name,
    { name: 'toolName', label: 'Tool name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    {
      name: 'inputSchema',
      label: 'Input JSON Schema',
      type: 'json',
      default: '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
    },
    {
      name: 'steps',
      label: 'Steps (JSON array)',
      type: 'json',
      required: true,
      help: 'Each step: { "id", "capability", "argumentsTemplate" }. "capability" is an exposed tool name or capability ID from the pool.',
      default: '[\n  { "id": "first", "capability": "exposed_tool_name", "argumentsTemplate": {} }\n]',
    },
  ],
  skill: [
    name,
    { name: 'slug', label: 'Skill slug', type: 'text', required: true },
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'description', label: 'When to use it', type: 'textarea', required: true },
    { name: 'content', label: 'Skill content (markdown)', type: 'textarea', required: true },
    { name: 'tags', label: 'Tags', type: 'list' },
  ],
  skill_repo: [
    name,
    {
      name: 'url',
      label: 'GitHub URL or owner/repo',
      type: 'text',
      required: true,
      placeholder: 'https://github.com/owner/repo',
    },
    { name: 'ref', label: 'Branch, tag, or commit', type: 'text' },
    { name: 'path', label: 'Subpath in repository', type: 'text' },
    { name: 'includeSkills', label: 'Only include slugs (one per line)', type: 'list' },
    { name: 'tags', label: 'Tags', type: 'list' },
    { name: 'secretName', label: 'GitHub token secret (private repos)', type: 'text' },
  ],
  shared_folder: [
    name,
    { name: 'shareName', label: 'Share name', type: 'text', required: true },
    { name: 'rootPath', label: 'Folder path', type: 'text', required: true },
    { name: 'readOnly', label: 'Read-only', type: 'boolean', default: true },
    { name: 'maxFileBytes', label: 'Max file size (bytes)', type: 'number', default: 1048576 },
    { name: 'allowedExtensions', label: 'Allowed extensions', type: 'list' },
    { name: 'description', label: 'Description', type: 'text' },
  ],
};

export const KIND_LABELS: Record<SourceKind, string> = {
  mcp_stdio: 'MCP server (stdio)',
  mcp_http: 'MCP server (HTTP)',
  cli_wrapper: 'CLI wrapper',
  composite: 'Composite tool',
  skill: 'Agent skill',
  skill_repo: 'GitHub skill repo',
  shared_folder: 'Shared folder',
};

const str = (v: FormValues, key: string): string => String(v[key] ?? '').trim();
const num = (v: FormValues, key: string): number | undefined => {
  const text = str(v, key);
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
  return Math.floor(value);
};
const need = (v: FormValues, key: string, label: string): string => {
  const text = str(v, key);
  if (!text) throw new Error(`${label} is required`);
  return text;
};
const opt = <K extends string, V>(
  key: K,
  value: V | undefined | null | '',
): { [P in K]?: V } =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
    ? {}
    : ({ [key]: value } as { [P in K]?: V });

function extraAuthParams(text: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const entry of text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const split = entry.indexOf('=');
    const key = split < 0 ? '' : entry.slice(0, split).trim();
    if (!key) throw new Error(`Invalid extra authorization parameter '${entry}'. Use key=value`);
    params[key] = entry.slice(split + 1).trim();
  }
  return params;
}

function oauthConfig(v: FormValues): UpstreamOAuthConfig {
  const params = extraAuthParams(String(v.extraAuthParams ?? ''));
  return {
    ...opt('clientId', str(v, 'clientId')),
    ...opt('clientSecretName', str(v, 'clientSecretName')),
    ...opt('authorizationEndpoint', str(v, 'authorizationEndpoint')),
    ...opt('tokenEndpoint', str(v, 'tokenEndpoint')),
    ...opt('scopes', lines(String(v.scopes ?? ''))),
    ...(Object.keys(params).length ? { extraAuthParams: params } : {}),
  };
}

export function buildCustomSource(
  kind: SourceKind,
  v: FormValues,
  refresh: { mode: 'manual' | 'on_connect' | 'interval'; seconds: string },
): CreateSourceInput {
  const base = {
    name: need(v, 'name', 'Source name'),
    kind,
    refreshPolicy:
      refresh.mode === 'interval'
        ? { mode: 'interval' as const, intervalSeconds: Math.max(5, Number(refresh.seconds) || 900) }
        : { mode: refresh.mode },
  };
  switch (kind) {
    case 'mcp_stdio': {
      const envMap: Record<string, string> = {};
      for (const entry of lines(str(v, 'envSecrets'))) {
        const [variable, secret] = entry.split('=').map((part) => part.trim());
        if (!variable || !secret) throw new Error(`Invalid environment secret '${entry}'. Use VAR=secret_name`);
        envMap[variable] = secret;
      }
      return {
        ...base,
        config: {
          kind,
          command: need(v, 'command', 'Command'),
          args: lines(String(v.args ?? '')),
          ...opt('cwd', str(v, 'cwd')),
          envAllowlist: lines(String(v.envAllowlist ?? '')),
          ...opt('timeoutMs', num(v, 'timeoutMs')),
        },
        ...(Object.keys(envMap).length
          ? {
              authConfig: {
                kind: 'env_secrets' as const,
                envMap,
                requiredSecrets: Object.values(envMap),
              },
            }
          : {}),
      };
    }
    case 'mcp_http': {
      const secretName = str(v, 'secretName');
      const config = { kind, url: need(v, 'url', 'URL'), ...opt('timeoutMs', num(v, 'timeoutMs')) };
      if (Boolean(v.useOAuth)) {
        if (secretName) throw new Error('Choose either a bearer secret or OAuth, not both');
        return { ...base, config, authConfig: { kind: 'oauth2', oauth: oauthConfig(v) } };
      }
      return {
        ...base,
        config,
        authConfig: secretName
          ? { kind: 'bearer_secret', secretName, requiredSecrets: [secretName] }
          : { kind: 'none' },
      };
    }
    case 'cli_wrapper':
      return {
        ...base,
        config: {
          kind,
          toolName: need(v, 'toolName', 'Tool name'),
          description: need(v, 'description', 'Description'),
          command: need(v, 'command', 'Command'),
          argsTemplate: lines(String(v.argsTemplate ?? '')),
          inputSchema: parseJsonObject(str(v, 'inputSchema') || '{}', 'Input schema'),
          envAllowlist: [],
          outputMode: 'text',
          ...opt('maxOutputBytes', num(v, 'maxOutputBytes')),
          ...opt('timeoutMs', num(v, 'timeoutMs')),
        },
      };
    case 'composite': {
      let steps: unknown;
      try {
        steps = JSON.parse(str(v, 'steps'));
      } catch {
        throw new Error('Steps must be valid JSON');
      }
      if (!Array.isArray(steps)) throw new Error('Steps must be a JSON array');
      return {
        ...base,
        config: {
          kind,
          toolName: need(v, 'toolName', 'Tool name'),
          description: need(v, 'description', 'Description'),
          inputSchema: parseJsonObject(str(v, 'inputSchema') || '{}', 'Input schema'),
          steps: steps as never,
        },
      };
    }
    case 'skill':
      return {
        ...base,
        config: {
          kind,
          slug: need(v, 'slug', 'Slug'),
          title: need(v, 'title', 'Title'),
          description: need(v, 'description', 'Description'),
          content: need(v, 'content', 'Content'),
          ...opt('tags', lines(String(v.tags ?? ''))),
        },
      };
    case 'skill_repo': {
      const secretName = str(v, 'secretName');
      return {
        ...base,
        config: {
          kind,
          url: need(v, 'url', 'GitHub URL'),
          ...opt('ref', str(v, 'ref')),
          ...opt('path', str(v, 'path')),
          ...opt('includeSkills', lines(String(v.includeSkills ?? ''))),
          ...opt('tags', lines(String(v.tags ?? ''))),
        },
        authConfig: secretName
          ? { kind: 'bearer_secret', secretName, requiredSecrets: [secretName] }
          : { kind: 'none' },
      };
    }
    case 'shared_folder':
      return {
        ...base,
        config: {
          kind,
          shareName: need(v, 'shareName', 'Share name'),
          rootPath: need(v, 'rootPath', 'Folder path'),
          readOnly: Boolean(v.readOnly),
          ...opt('maxFileBytes', num(v, 'maxFileBytes')),
          ...opt('allowedExtensions', lines(String(v.allowedExtensions ?? ''))),
          ...opt('description', str(v, 'description')),
        },
      };
  }
}

export { SelectField };
