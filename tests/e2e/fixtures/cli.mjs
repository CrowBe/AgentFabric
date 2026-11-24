import { appendFileSync } from 'node:fs';

const [, , callLog, value] = process.argv;
appendFileSync(callLog, 'cli_echo\n');
process.stdout.write(`cli:${value}`);
