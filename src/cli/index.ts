#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listRecipes } from '../deploy/recipes.js';
import type { NodeServerOptions } from '../deploy/node.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  startServer(options: NodeServerOptions): Promise<void>;
  readStoredToken(homeDir: string | undefined): Promise<string | undefined>;
}

class CliError extends Error {}

const HELP = `AgentFabric gateway CLI

Usage: agentfabric <command> [options]

Commands:
  start                         Start the persistent gateway (Node)
  status                        Show gateway health and counts
  token create                  Mint a scoped bearer token for a profile
  export [--out FILE]           Export secret-free configuration
  import FILE [--replace]       Import configuration (merges unless --replace)
  approvals list                List approval requests (--status pending|approved|denied|expired)
  approvals approve ID          Approve a pending request
  approvals deny ID             Deny a pending request
  skills list                   List pooled MCP skills
  skills add URL                Import skill(s) from a GitHub URL (--name, --ref, --path, --include, --tag, --secret)
  proposals list                List agent capability proposals (--status pending_review|activated|rejected)
  proposals activate ID         Approve and activate a capability proposal
  proposals reject ID           Reject a capability proposal
  recipes list                  List starter recipes
  events list                   List event occurrences
  events emit NAME              Emit an event (--data JSON, --source ID)

Connection options (all commands except start and recipes):
  --url URL        Gateway URL (default $AGENTFABRIC_URL or http://127.0.0.1:7432)
  --token TOKEN    Operator token (default $AGENTFABRIC_OPERATOR_TOKEN or <home>/operator-token)
  --home DIR       Gateway home (default $AGENTFABRIC_HOME or ~/.agentfabric)
  --json           Print raw JSON

Start options: --port N  --host HOST  --public-url URL  --mode local|remote  --home DIR
`;

const OPTIONS = {
  url: { type: 'string' },
  token: { type: 'string' },
  home: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  port: { type: 'string' },
  host: { type: 'string' },
  'public-url': { type: 'string' },
  mode: { type: 'string' },
  profile: { type: 'string' },
  label: { type: 'string' },
  scope: { type: 'string', multiple: true },
  out: { type: 'string' },
  replace: { type: 'boolean' },
  status: { type: 'string' },
  note: { type: 'string' },
  name: { type: 'string' },
  ref: { type: 'string' },
  path: { type: 'string' },
  include: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  secret: { type: 'string' },
  after: { type: 'string' },
  limit: { type: 'string' },
  source: { type: 'string' },
  data: { type: 'string' },
} as const;

async function readStoredToken(homeDir: string | undefined): Promise<string | undefined> {
  const home = homeDir ?? process.env.AGENTFABRIC_HOME ?? join(homedir(), '.agentfabric');
  try {
    return (await readFile(join(home, 'operator-token'), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    fetch: (input, init) => fetch(input, init),
    env: process.env,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
    async startServer(options) {
      const { runNodeServer } = await import('../deploy/node.js');
      await runNodeServer(options);
    },
    readStoredToken,
  };
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class Client {
  constructor(
    private readonly io: CliIo,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.io.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError(
        `Cannot reach the gateway at ${this.baseUrl}. Start it with 'agentfabric start' or pass --url.`,
      );
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      if (response.status === 401) {
        throw new CliError(
          'Operator authentication failed. Pass --token, set AGENTFABRIC_OPERATOR_TOKEN, or check <home>/operator-token.',
        );
      }
      throw new CliError(
        `${response.status} ${error?.code ?? 'ERROR'}: ${error?.message ?? 'Request failed'}`,
      );
    }
    return parsed as T;
  }
}

const q = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

export async function runCli(
  argv: string[],
  ioOverride?: Partial<CliIo>,
): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...ioOverride };
  const out = (text: string): void => io.stdout(`${text}\n`);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [command, sub, ...rest] = positionals;
    if (values.help || !command || command === 'help') {
      out(HELP);
      return 0;
    }

    if (command === 'recipes') {
      if (sub !== 'list') throw new CliError('Usage: agentfabric recipes list');
      const recipes = listRecipes();
      if (values.json) out(JSON.stringify({ recipes }, null, 2));
      else {
        out(
          table([
            ['ID', 'KIND', 'LOCAL ONLY', 'TITLE'],
            ...recipes.map((r) => [r.id, r.kind, r.localOnly ? 'yes' : 'no', r.title]),
          ]),
        );
      }
      return 0;
    }

    if (command === 'start') {
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        throw new CliError(`Invalid --port '${values.port}'`);
      }
      if (values.mode !== undefined && values.mode !== 'local' && values.mode !== 'remote') {
        throw new CliError("--mode must be 'local' or 'remote'");
      }
      await io.startServer({
        ...(port !== undefined ? { port } : {}),
        ...(values.host ? { host: values.host } : {}),
        ...(values.home ? { homeDir: values.home } : {}),
        ...(values['public-url'] ? { publicUrl: values['public-url'] } : {}),
        ...(values.mode ? { mode: values.mode } : {}),
      });
      return 0;
    }

    const client = await connect(io, values);
    switch (command) {
      case 'status': {
        const health = await io.fetch(`${client.base}/healthz`).then(
          (r) => r.json() as Promise<{ ok: boolean; mode: string; version: string }>,
          () => {
            throw new CliError(`Cannot reach the gateway at ${client.base}.`);
          },
        );
        const status = await client.api.call<Record<string, unknown>>('GET', '/api/status');
        if (values.json) out(JSON.stringify({ health, status }, null, 2));
        else {
          const counts = (status.counts ?? {}) as Record<string, number>;
          out(`Gateway ${health.ok ? 'healthy' : 'unhealthy'} · mode ${health.mode} · v${health.version}`);
          out(`Public URL  ${String(status.publicUrl)}`);
          out(
            table(
              Object.entries(counts).map(([key, value]) => [key, String(value)]),
            ),
          );
        }
        return 0;
      }
      case 'token': {
        if (sub !== 'create') throw new CliError('Usage: agentfabric token create --profile NAME');
        if (!values.profile) throw new CliError('--profile is required');
        const result = await client.api.call<{
          token: string;
          record: { id: string; label: string; profileId: string };
        }>('POST', '/api/tokens', {
          label: values.label ?? `cli-${values.profile}`,
          profileId: values.profile,
          ...(values.scope?.length ? { scopes: values.scope } : {}),
        });
        if (values.json) out(JSON.stringify(result, null, 2));
        else {
          out(`Token ${result.record.id} for profile ${result.record.profileId}:`);
          out(result.token);
          out('Store it now. It is shown only once.');
        }
        return 0;
      }
      case 'export': {
        const bundle = await client.api.call<unknown>('GET', '/api/config/export');
        const text = JSON.stringify(bundle, null, 2);
        if (values.out) {
          await io.writeFile(values.out, `${text}\n`);
          out(`Exported secret-free configuration to ${values.out}`);
        } else out(text);
        return 0;
      }
      case 'import': {
        if (!sub) throw new CliError('Usage: agentfabric import FILE [--replace]');
        let bundle: unknown;
        try {
          bundle = JSON.parse(await io.readFile(sub));
        } catch {
          throw new CliError(`Cannot read a JSON bundle from ${sub}`);
        }
        const result = await client.api.call<Record<string, number>>(
          'POST',
          '/api/config/import',
          { bundle, merge: !values.replace },
        );
        if (values.json) out(JSON.stringify(result, null, 2));
        else {
          out(
            `Imported ${result.importedSources} sources, ${result.importedProfiles} profiles, ${result.importedOverlays} overlays, ${result.importedPolicies} policies`,
          );
        }
        return 0;
      }
      case 'approvals': {
        if (sub === 'list') {
          const { approvals } = await client.api.call<{
            approvals: Array<{
              id: string;
              status: string;
              toolName: string;
              profileId: string;
              reason: string;
              expiresAt: string;
            }>;
          }>('GET', `/api/approvals${q({ status: values.status })}`);
          if (values.json) out(JSON.stringify({ approvals }, null, 2));
          else if (approvals.length === 0) out('No approvals.');
          else {
            out(
              table([
                ['ID', 'STATUS', 'PROFILE', 'TOOL', 'REASON'],
                ...approvals.map((a) => [a.id, a.status, a.profileId, a.toolName, a.reason]),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'approve' || sub === 'deny') {
          const id = rest[0];
          if (!id) throw new CliError(`Usage: agentfabric approvals ${sub} ID [--note TEXT]`);
          const { approval } = await client.api.call<{ approval: { id: string; status: string } }>(
            'POST',
            `/api/approvals/${encodeURIComponent(id)}/decide`,
            {
              decision: sub === 'approve' ? 'approved' : 'denied',
              ...(values.note ? { note: values.note } : {}),
            },
          );
          out(values.json ? JSON.stringify({ approval }, null, 2) : `Approval ${approval.id} is now ${approval.status}`);
          return 0;
        }
        throw new CliError('Usage: agentfabric approvals list|approve|deny');
      }
      case 'skills': {
        if (sub === 'list') {
          const { capabilities } = await client.api.call<{
            capabilities: Array<{
              exposedName: string;
              sourceName: string;
              uri?: string;
              available: boolean;
            }>;
          }>('GET', '/api/capabilities?kind=skill');
          if (values.json) out(JSON.stringify({ skills: capabilities }, null, 2));
          else if (capabilities.length === 0) out('No skills in the pool.');
          else {
            out(
              table([
                ['SLUG', 'SOURCE', 'URI', 'AVAILABLE'],
                ...capabilities.map((c) => [
                  c.exposedName,
                  c.sourceName,
                  c.uri ?? `skill://${c.exposedName}`,
                  c.available ? 'yes' : 'no',
                ]),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'add') {
          const url = rest[0];
          if (!url) {
            throw new CliError(
              'Usage: agentfabric skills add <github-url> [--name NAME] [--ref REF] [--path SUBPATH] [--include SLUG...] [--tag TAG...] [--secret NAME]',
            );
          }
          const recipeValues: Record<string, unknown> = {
            url,
            ...(values.name ? { name: values.name } : {}),
            ...(values.ref ? { ref: values.ref } : {}),
            ...(values.path ? { path: values.path } : {}),
            ...(values.include?.length ? { includeSkills: values.include } : {}),
            ...(values.tag?.length ? { tags: values.tag } : {}),
            ...(values.secret ? { secretName: values.secret } : {}),
          };
          const { source } = await client.api.call<{
            source: { id: string; name: string; health: string };
          }>('POST', '/api/recipes/github-skill-repo/instantiate', { values: recipeValues });
          const { capabilities } = await client.api.call<{
            capabilities: Array<{ exposedName: string }>;
          }>('GET', `/api/capabilities${q({ sourceId: source.id, kind: 'skill' })}`);
          if (values.json) {
            out(JSON.stringify({ source, skillCount: capabilities.length, skills: capabilities }, null, 2));
          } else {
            out(`Imported ${capabilities.length} skill(s) from ${source.name} (${source.id}, health: ${source.health})`);
          }
          return 0;
        }
        throw new CliError('Usage: agentfabric skills list|add');
      }
      case 'proposals': {
        if (sub === 'list') {
          const { proposals } = await client.api.call<{
            proposals: Array<{ id: string; kind: string; name: string; status: string; profileId?: string }>;
          }>('GET', `/api/proposals${q({ status: values.status })}`);
          if (values.json) out(JSON.stringify({ proposals }, null, 2));
          else if (proposals.length === 0) out('No proposals.');
          else {
            out(
              table([
                ['ID', 'KIND', 'NAME', 'STATUS', 'PROFILE'],
                ...proposals.map((p) => [p.id, p.kind, p.name, p.status, p.profileId ?? '-']),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'activate' || sub === 'reject') {
          const id = rest[0];
          if (!id) throw new CliError(`Usage: agentfabric proposals ${sub} ID [--note TEXT]`);
          const result = await client.api.call<{ proposal: { id: string; status: string }; source?: { id: string } }>(
            'POST',
            `/api/proposals/${encodeURIComponent(id)}/${sub}`,
            values.note ? { note: values.note } : {},
          );
          if (values.json) out(JSON.stringify(result, null, 2));
          else {
            out(
              `Proposal ${result.proposal.id} is now ${result.proposal.status}` +
                (result.source ? ` (source ${result.source.id})` : ''),
            );
          }
          return 0;
        }
        throw new CliError('Usage: agentfabric proposals list|activate|reject');
      }
      case 'events': {
        if (sub === 'list') {
          const { occurrences } = await client.api.call<{
            occurrences: Array<{ cursor: string; name: string; sourceId: string; timestamp: string }>;
          }>(
            'GET',
            `/api/events/occurrences${q({ name: values.name, afterCursor: values.after, limit: values.limit })}`,
          );
          if (values.json) out(JSON.stringify({ occurrences }, null, 2));
          else if (occurrences.length === 0) out('No event occurrences.');
          else {
            out(
              table([
                ['CURSOR', 'NAME', 'SOURCE', 'TIMESTAMP'],
                ...occurrences.map((o) => [o.cursor, o.name, o.sourceId, o.timestamp]),
              ]),
            );
          }
          return 0;
        }
        if (sub === 'emit') {
          const name = rest[0];
          if (!name) throw new CliError('Usage: agentfabric events emit NAME [--data JSON] [--source ID]');
          let data: unknown = {};
          if (values.data) {
            try {
              data = JSON.parse(values.data);
            } catch {
              throw new CliError('--data must be valid JSON');
            }
          }
          const { occurrence } = await client.api.call<{ occurrence: { eventId: string; cursor: string } }>(
            'POST',
            '/api/events/emit',
            { name, data, ...(values.source ? { sourceId: values.source } : {}) },
          );
          out(values.json ? JSON.stringify({ occurrence }, null, 2) : `Emitted ${name} (event ${occurrence.eventId}, cursor ${occurrence.cursor})`);
          return 0;
        }
        throw new CliError('Usage: agentfabric events list|emit');
      }
      default:
        throw new CliError(`Unknown command '${command}'. Run 'agentfabric help'.`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof TypeError && 'code' in error) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function connect(
  io: CliIo,
  values: Values,
): Promise<{ base: string; api: Client }> {
  const base = (values.url ?? io.env.AGENTFABRIC_URL ?? `http://127.0.0.1:${io.env.AGENTFABRIC_PORT ?? 7432}`).replace(
    /\/+$/,
    '',
  );
  const token =
    values.token ??
    io.env.AGENTFABRIC_OPERATOR_TOKEN ??
    (await io.readStoredToken(values.home ?? io.env.AGENTFABRIC_HOME));
  if (!token) {
    throw new CliError(
      'No operator token found. Pass --token, set AGENTFABRIC_OPERATOR_TOKEN, or start the gateway once to create <home>/operator-token.',
    );
  }
  return { base, api: new Client(io, base, token) };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
