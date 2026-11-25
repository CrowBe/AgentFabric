import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { sourceSecretNames } from '../auth/handoff.js';
import { GatewayError, type CliWrapperSourceConfig, type GatewayMode, type SecretStore, type SourceRecord } from '../types/index.js';

const run = promisify(execFile);

export async function checkSecrets(source: SourceRecord, secrets: SecretStore) {
  for (const name of sourceSecretNames(source)) {
    if (!(await secrets.get(name))) throw new GatewayError('AUTH_REQUIRED', 'Required upstream credentials are missing');
  }
}

export async function sourceEnvironment(source: SourceRecord, envAllowlist: string[] = [], secrets: SecretStore) {
  const env: Record<string, string> = Object.create(null);
  for (const name of envAllowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [key, name] of Object.entries(source.authConfig.envMap ?? {})) {
    const value = await secrets.get(name);
    if (!value) throw new GatewayError('AUTH_REQUIRED', 'Required upstream credentials are missing');
    env[key] = value;
  }
  return env;
}

export function requireLocalCli(mode: GatewayMode) {
  if (mode !== 'local') throw new GatewayError('REMOTE_CLI_FORBIDDEN', 'CLI wrappers require local mode');
}

const shellCommands = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ksh93', 'fish', 'ash', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const launchers = new Set(['env', 'busybox', 'toybox']);

function interpreter(command: string) {
  const name = basename(command.replaceAll('\\', '/')).toLowerCase();
  return shellCommands.has(name) || launchers.has(name);
}

async function resolveExecutable(config: CliWrapperSourceConfig, env: Record<string, string>) {
  const command = config.command;
  if (interpreter(command)) throw new GatewayError('INVALID_INPUT', 'CLI wrappers must name the target executable directly');
  const cwd = config.cwd ?? process.cwd();
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(cwd, command)] : (env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir, command));
  for (const candidate of candidates) {
    const target = await realpath(candidate).catch(() => undefined);
    if (!target) continue;
    const executable = await Promise.all([access(target, constants.X_OK), stat(target)])
      .then(([, info]) => info.isFile(), () => false);
    if (!executable) continue;
    if (interpreter(target)) throw new GatewayError('INVALID_INPUT', 'CLI wrappers must name the target executable directly');
    return target;
  }
  throw new GatewayError('UPSTREAM_ERROR', 'Configured CLI executable is unavailable');
}

function serializeArg(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized.includes('\0')) throw new GatewayError('INVALID_INPUT', 'CLI arguments cannot contain null bytes');
  return serialized;
}

function argv(config: CliWrapperSourceConfig, args: Record<string, unknown>) {
  const resolved = config.argsTemplate.map(template => {
    const result = template.replaceAll(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(args, key)) throw new GatewayError('INVALID_INPUT', `Missing CLI argument: ${key}`);
      return serializeArg(args[key]);
    });
    if (result.includes('\0')) throw new GatewayError('INVALID_INPUT', 'CLI arguments cannot contain null bytes');
    return result;
  });
  for (const spec of config.optionalArgs ?? []) {
    if (spec.flag.includes('\0')) throw new GatewayError('INVALID_INPUT', 'CLI arguments cannot contain null bytes');
    if (!Object.hasOwn(args, spec.key)) continue;
    const raw = args[spec.key];
    if (raw === undefined || raw === null) continue;
    if (spec.mode === 'flag') {
      if (raw === true) resolved.push(spec.flag);
    } else if (spec.mode === 'repeat') {
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item === undefined || item === null) continue;
          resolved.push(spec.flag, serializeArg(item));
        }
      }
    } else {
      resolved.push(spec.flag, serializeArg(raw));
    }
  }
  return resolved;
}

export async function executeCliWrapper(
  source: SourceRecord & { config: CliWrapperSourceConfig },
  args: Record<string, unknown> | null,
  mode: GatewayMode,
  secrets: SecretStore,
) {
  requireLocalCli(mode);
  const config = source.config;
  const resolvedArgs = args === null ? undefined : argv(config, args);
  await checkSecrets(source, secrets);
  const env = await sourceEnvironment(source, config.envAllowlist, secrets);
  const command = await resolveExecutable(config, env);
  const options = { shell: false, cwd: config.cwd, env, timeout: config.timeoutMs ?? 15_000,
    maxBuffer: config.maxOutputBytes ?? 1024 * 1024, killSignal: 'SIGKILL' as const };
  if (config.authCheckArgs) {
    try { await run(command, config.authCheckArgs, options); }
    catch (cause) { throw new GatewayError('AUTH_REQUIRED', 'The local CLI authentication check failed', { cause }); }
  }
  if (!resolvedArgs) return;
  let stdout: string;
  try { ({ stdout } = await run(command, resolvedArgs, options)); }
  catch (cause) {
    const timedOut = (cause as { killed?: boolean; signal?: string }).signal === 'SIGKILL' && (cause as { killed?: boolean }).killed;
    throw new GatewayError(timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      timedOut ? 'CLI invocation timed out' : 'CLI invocation failed', { cause });
  }
  if (config.outputMode !== 'json') return stdout;
  try { return JSON.parse(stdout) as unknown; }
  catch (cause) { throw new GatewayError('UPSTREAM_ERROR', 'CLI returned invalid JSON', { cause }); }
}
