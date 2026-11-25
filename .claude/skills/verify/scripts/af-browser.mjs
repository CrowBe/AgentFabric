#!/usr/bin/env node
// Drive the AgentFabric operator web UI in headless Chromium (Playwright), one fresh tab per run.
// Usage: af-browser.mjs <proof-dir> [--no-signin] [--viewport <W>x<H>] STEP...
// Steps (each one argument; names are exact accessible names):
//   goto:<hash|path>              e.g. goto:#/sources
//   click:<role>:<name>           e.g. click:button:Add source   click:tab:Safety & Approvals
//                                 (a name that also matches inside an open dialog clicks the dialog's)
//   click-text:<text>             click the element whose visible text is exactly <text>; use it only for
//                                 controls without a role, such as a <details> summary
//   fill:<label>=<value>          fill the field whose label is <label> (works for password inputs)
//   expect:<role>:<name>          wait until visible, e.g. expect:heading:Sources & Pool
//   expect-text:<text>            wait until the text is visible
//   snap:<name>                   save <proof>/browser/<name>.png and <name>.aria.txt
// Without --no-signin the helper first signs in through the "Operator sign-in" dialog using
// <home>/operator-token. --viewport sets the page size (default 1360x900; e.g. 390x844 for the
// mobile layout). Console errors and failed requests go to <proof>/browser/console.txt.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');
  try {
    const bin = execFileSync('mise', ['which', 'playwright'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(path.resolve(path.dirname(bin), '..', 'playwright'));
  } catch {}
  try {
    const bin = execFileSync('sh', ['-c', 'readlink -f "$(command -v playwright)"'], { encoding: 'utf8' }).trim();
    if (bin) candidates.push(path.resolve(path.dirname(bin), '..', 'playwright'));
  } catch {}
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {}
  }
  fail(`Playwright not found. Set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright (tried: ${candidates.join(', ')})`);
}

const [proofArg, ...rest] = process.argv.slice(2);
if (!proofArg) fail('usage: af-browser.mjs <proof-dir> [--no-signin] [--viewport <W>x<H>] STEP...');
const proof = proofArg.replace(/\/+$/, '');
const sessionFile = path.join(proof, 'session.env');
if (!existsSync(sessionFile)) fail(`no session.env in ${proof}`);
const session = Object.fromEntries(
  readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [key, ...value] = line.split('=');
    return [key, value.join('=').replace(/^'|'$/g, '')];
  }),
);
let signIn = true;
let viewport = { width: 1360, height: 900 };
const steps = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === '--no-signin') signIn = false;
  else if (arg === '--viewport' || arg.startsWith('--viewport=')) {
    const value = arg === '--viewport' ? rest[(i += 1)] : arg.slice('--viewport='.length);
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(value ?? '');
    if (!match) fail(`--viewport expects <W>x<H>, e.g. 390x844 (got '${value ?? ''}')`);
    viewport = { width: Number(match[1]), height: Number(match[2]) };
  } else steps.push(arg);
}
const outDir = path.join(proof, 'browser');
mkdirSync(outDir, { recursive: true });
const consoleLog = path.join(outDir, 'console.txt');
const redact = (text) => text
  .replace(/afop_[A-Za-z0-9_-]+/g, 'afop_[REDACTED]')
  .replace(/af_tok_[A-Za-z0-9._~+/-]+=*/g, 'af_tok_[REDACTED]')
  .replace(/af_(oauth_state|ticket|code|refresh)_[A-Za-z0-9._~-]+/g, 'af_$1_[REDACTED]')
  .replace(/([?&]code=)[^&#\s"'<>]+/g, '$1[REDACTED]');
const record = (line) => appendFileSync(consoleLog, `${redact(line)}\n`);

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport });
page.setDefaultTimeout(Number(process.env.AF_BROWSER_TIMEOUT_MS ?? 10_000));
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') record(`[console.${msg.type()}] ${msg.text()}`); });
page.on('pageerror', (error) => record(`[pageerror] ${error.message}`));
page.on('requestfailed', (req) => record(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));
page.on('response', (res) => { if (res.status() >= 400) record(`[http ${res.status()}] ${res.request().method()} ${res.url()}`); });

async function snap(name) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  await page.screenshot({ path: path.join(outDir, `${safe}.png`), fullPage: true });
  const aria = await page.locator('body').ariaSnapshot();
  writeFileSync(path.join(outDir, `${safe}.aria.txt`), redact(`# ${page.url()}\n# title: ${await page.title()}\n${aria}\n`));
  console.log(`snap ${path.join(outDir, `${safe}.png`)}`);
}

const split = (text, sep) => {
  const at = text.indexOf(sep);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + sep.length)];
};

// When a name matches both the page and an open dialog (e.g. the "Add source" page button and the
// dialog's submit), act on the single match inside the topmost open dialog.
async function inDialog(build) {
  const all = build(page);
  if ((await all.count()) <= 1) return all;
  const modal = page.locator('dialog[open]:visible, [role="dialog"]:visible, [role="alertdialog"]:visible').last();
  if ((await modal.count()) === 0) return all;
  const inside = build(modal);
  return (await inside.count()) === 1 ? inside : all;
}

let exitCode = 0;
try {
  await page.goto(`${session.AF_URL}/`);
  if (signIn) {
    const token = readFileSync(path.join(session.AF_HOME, 'operator-token'), 'utf8').trim();
    await page.getByRole('dialog', { name: 'Operator sign-in' }).waitFor();
    await page.getByLabel('Operator token', { exact: true }).fill(token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('tablist', { name: 'Gateway sections' }).waitFor();
    console.log('signed in');
  }
  for (const step of steps) {
    const [verb, arg] = split(step, ':');
    if (verb === 'goto') {
      await page.goto(arg.startsWith('#') ? `${session.AF_URL}/${arg}` : `${session.AF_URL}${arg}`);
    } else if (verb === 'click') {
      const [role, name] = split(arg, ':');
      await (await inDialog((scope) => scope.getByRole(role, { name, exact: true }))).click();
    } else if (verb === 'click-text') {
      await (await inDialog((scope) => scope.getByText(arg, { exact: true }))).click();
    } else if (verb === 'fill') {
      const [label, value] = split(arg, '=');
      await (await inDialog((scope) => scope.getByLabel(label, { exact: true }))).fill(value);
    } else if (verb === 'expect') {
      const [role, name] = split(arg, ':');
      await page.getByRole(role, { name, exact: true }).first().waitFor({ state: 'visible' });
    } else if (verb === 'expect-text') {
      await page.getByText(arg, { exact: false }).first().waitFor({ state: 'visible' });
    } else if (verb === 'snap') {
      await snap(arg || 'page');
    } else {
      throw new Error(`unknown step '${step}'`);
    }
    console.log(`ok ${step}`);
  }
} catch (error) {
  exitCode = 1;
  console.error(`FAILED: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  await snap('failure').catch(() => {});
} finally {
  await browser.close();
}
process.exit(exitCode);
