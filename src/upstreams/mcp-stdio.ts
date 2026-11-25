import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpStdioSourceConfig, SecretStore, SourceRecord } from '../types/index.js';
import { sourceEnvironment } from './cli-wrapper.js';

export async function stdioTransport(source: SourceRecord & { config: McpStdioSourceConfig }, secrets: SecretStore) {
  const { command, args, cwd, envAllowlist } = source.config;
  const env = await sourceEnvironment(source, envAllowlist, secrets);
  const inherited = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, undefined]));
  return new StdioClientTransport({ command, args, cwd, env: { ...inherited, ...env } as Record<string, string>, stderr: 'ignore' });
}
