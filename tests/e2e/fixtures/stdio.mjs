import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mcpResponse } from './mcp-responses.mjs';

const [, , callLog, behavior] = process.argv;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'tools/call') {
    appendFileSync(callLog, `${request.params.name}\n`);
    if (behavior === 'crash-on-call') process.exit(17);
  }
  process.stdout.write(`${JSON.stringify(mcpResponse(request, 'stdio', process.env.FIXTURE_SECRET))}\n`);
});
