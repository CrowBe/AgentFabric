import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { MemoryTraceStore } from '../../src/storage/memory.js';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

describe('cli_wrapper optionalArgs', () => {
  it('resolves value, flag, and repeat optional arguments cleanly and fails closed on invalid input', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'af-cli-opt-'));
    temps.push(homeDir);
    const runtime = await createGatewayRuntime({
      mode: 'local',
      homeDir,
      publicUrl: 'http://127.0.0.1:7432',
      traceStore: new MemoryTraceStore(),
    });

    try {
      await runtime.createSource({
        name: 'echo-cli',
        kind: 'cli_wrapper',
        config: {
          kind: 'cli_wrapper',
          toolName: 'echo_args',
          description: 'Echo resolved CLI arguments as JSON',
          command: process.execPath,
          argsTemplate: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '{{action}}'],
          optionalArgs: [
            { key: 'query', flag: '--query', mode: 'value' },
            { key: 'today', flag: '--today', mode: 'flag' },
            { key: 'attendee', flag: '--attendee', mode: 'repeat' },
          ],
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              query: { type: 'string' },
              today: { type: 'boolean' },
              attendee: { type: 'array', items: { type: 'string' } },
            },
            required: ['action'],
            additionalProperties: false,
          },
          outputMode: 'json',
        },
      });

      const { token } = await runtime.createToken({ label: 'agent', profileId: 'default' });
      const sdk = new Client({ name: 'test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7432/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (url, init) => runtime.handleMcpRequest(new Request(url, init), null),
      });
      await sdk.connect(transport);

      try {
        const minimal = await sdk.callTool({ name: 'echo_args', arguments: { action: 'list' } });
        expect(JSON.parse((minimal.content as Array<{ text: string }>)[0]!.text)).toEqual(['list']);

        const full = await sdk.callTool({
          name: 'echo_args',
          arguments: {
            action: 'search',
            query: 'roadmap',
            today: true,
            attendee: ['alice@example.com', 'bob@example.com'],
          },
        });
        expect(JSON.parse((full.content as Array<{ text: string }>)[0]!.text)).toEqual([
          'search',
          '--query',
          'roadmap',
          '--today',
          '--attendee',
          'alice@example.com',
          '--attendee',
          'bob@example.com',
        ]);

        const noFlag = await sdk.callTool({
          name: 'echo_args',
          arguments: { action: 'list', today: false },
        });
        expect(JSON.parse((noFlag.content as Array<{ text: string }>)[0]!.text)).toEqual(['list']);

        await expect(
          sdk.callTool({
            name: 'echo_args',
            arguments: { action: 'search', query: 'bad\0value' },
          }),
        ).rejects.toThrowError(/null bytes/i);

        await expect(
          sdk.callTool({
            name: 'echo_args',
            arguments: { action: 'list', nope: '1' },
          }),
        ).rejects.toThrowError();

        const bundle = await runtime.exportConfig();
        expect(bundle.sources[0]?.config).toMatchObject({
          kind: 'cli_wrapper',
          optionalArgs: [
            { key: 'query', flag: '--query', mode: 'value' },
            { key: 'today', flag: '--today', mode: 'flag' },
            { key: 'attendee', flag: '--attendee', mode: 'repeat' },
          ],
        });
        const freshHome = await mkdtemp(join(tmpdir(), 'af-cli-import-'));
        temps.push(freshHome);
        const imported = await createGatewayRuntime({
          mode: 'local',
          homeDir: freshHome,
          publicUrl: 'http://127.0.0.1:7432',
          traceStore: new MemoryTraceStore(),
        });
        try {
          await imported.importConfig(bundle, { merge: false, enableExecutables: true });
          const sources = await imported.listSources();
          expect(sources[0]?.config).toMatchObject({
            kind: 'cli_wrapper',
            optionalArgs: [
              { key: 'query', flag: '--query', mode: 'value' },
              { key: 'today', flag: '--today', mode: 'flag' },
              { key: 'attendee', flag: '--attendee', mode: 'repeat' },
            ],
          });
        } finally {
          await imported.close();
        }
      } finally {
        await sdk.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
