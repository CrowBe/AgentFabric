---
name: verify
description: Launch and drive the real AgentFabric MCP gateway the way an operator and a harness do, then capture proof. Covers the MCP endpoint (/mcp/<profile>: tools, prompts, resources, skills, fabric_search/inspect/call, events), the operator REST API (/api/*), the operator web console (headless Chromium), and the agentfabric CLI. Use it to confirm a change works in the running app, to reproduce a bug end to end, or before claiming any gateway, UI, CLI, auth, approval, events, telemetry, or portability behavior works.
---

# Verify AgentFabric

AgentFabric is one Node process (`node dist/cli/index.js start`) that serves everything on one port:

| Surface | Who uses it | Handle |
| --- | --- | --- |
| MCP gateway | harnesses (Claude Code, Codex, Cursor, Claude on the web) | `POST /mcp/<profile>` JSON-RPC, bearer `af_tok_…` |
| Operator REST API | web console, CLI | `/api/*`, bearer = operator token `afop_…` |
| Operator web console | the human operator | `/` (React app, token gate dialog "Operator sign-in") |
| CLI | the operator in a terminal | `agentfabric status\|token\|export\|import\|approvals\|events\|recipes` |
| OAuth + discovery | remote harnesses | `/.well-known/oauth-protected-resource/mcp/<profile>`, `/oauth/*` |

Every drive in this skill goes through those real user paths. All helpers live in `.claude/skills/verify/scripts/`, take the **proof directory** as their first argument, and record a redacted transcript of every call into it. The feature map in [`features/README.md`](features/README.md) lists the journeys to drive.

Run all commands from the repository root. `S=.claude/skills/verify/scripts` below.

## Launch

```sh
S=.claude/skills/verify/scripts
P=$($S/af-launch.sh)            # optional arg: RUN_ID (letters, digits, . _ -)
echo "$P"                       # e.g. /tmp/agentfabric-verify-proof-20261124-114431-4242
```

What it does:

1. Rebuilds with `npm run build` when `dist/cli/index.js` or `dist/web/index.html` is missing or older than `src/` / `web/` (`dist/` is gitignored). Needs `node_modules` (`npm ci`) and Node.js 26+.
2. Creates a fresh home `${TMPDIR:-/tmp}/agentfabric-verify-home-<RUN_ID>` (mode 700) and a proof dir `${TMPDIR:-/tmp}/agentfabric-verify-proof-<RUN_ID>`. Both are outside the repo. Refuses to reuse a RUN_ID.
3. Starts `node dist/cli/index.js start --host 127.0.0.1 --port 0 --home <home>` with `AGENTFABRIC_HOME=<home>` and every inherited `AGENTFABRIC_*` variable (operator token, URL, port, public URL, mode, LLM settings) removed. Port `0` takes a free port, so it never collides with a real gateway on 7432 and never touches `~/.agentfabric`. Set `AF_PORT=<n>` to pin a port.
4. Waits for the startup banner (` Web UI         http://127.0.0.1:<port>/`), then for **usable**: `/healthz` returns `"ok":true`, `GET /api/status` with the operator token reports `homeDir` = our home, and `GET /api/profiles/default` returns 200 (the runtime seeds the `default` profile on first boot).
5. Writes `<proof>/session.env` (`AF_URL`, `AF_PORT`, `AF_PID`, `AF_HOME`, `AF_PROOF`, `AF_RUN_ID`, `AF_REPO`) and `<proof>/launch.txt` (banner with the token redacted, git SHA). Prints the proof dir as the last stdout line.

A fresh home starts empty: no sources, one `default` profile (`defaultExposure: direct`, `directToolBudget: 24`), no tokens. The operator token is generated into `<home>/operator-token` (mode 600). Seed what a journey needs through the API (each feature file lists its seed calls).

If launch fails, it prints the redacted log and tells you to run Cleanup. Do it.

Teardown is the Cleanup section. Shell variables do not persist between tool calls, so re-set `P=<proof dir>` in each call.

## Doctor

```sh
$S/af-doctor.sh "$P"            # read-only; exit 0 = "doctor: healthy"
```

Checks, without mutating anything: the PID in `session.env` is our `node dist/cli/index.js start … --home <home>` process; `ss` shows that PID owns the port; `/healthz` is ok; unauthenticated `GET /api/status` fails closed with 401; the operator token is accepted and `/api/status` reports our `homeDir`, mode `local`, and current counts; `/` serves the console shell (`<title>AgentFabric Gateway</title>`); the home is not `~/.agentfabric`. Run it first whenever anything looks off. Never drive an instance whose doctor fails or that this run did not launch.

## Drive

Pick the journey from [`features/README.md`](features/README.md). The helpers:

| Helper | Drives | Example |
| --- | --- | --- |
| `af-api.sh "$P" METHOD PATH [JSON\|@file]` | operator REST API with the operator token. `AF_NOAUTH=1` omits it. Stdout = body, stderr = `HTTP <code>`, exit 0 only for 2xx. | `$S/af-api.sh "$P" GET /api/status` |
| `af-mcp.sh "$P" PROFILE METHOD [PARAMS_JSON]` | one MCP JSON-RPC request to `POST /mcp/<PROFILE>` with `MCP-Protocol-Version: 2026-07-28`. First use per profile mints a client token via `POST /api/tokens` and caches it in `<home>/mcp-token-<PROFILE>`. `AF_MCP_TOKEN=<tok>\|none`, `AF_MCP_VERSION`, `AF_MCP_SESSION`, `AF_MAX_TIME` (seconds, default 30). | `$S/af-mcp.sh "$P" default tools/list` |
| `af-cli.sh "$P" ARGS…` | the real `agentfabric` CLI with `--url`/`--home` appended. Exit code is the CLI's. | `$S/af-cli.sh "$P" approvals list --status pending` |
| `node $S/af-browser.mjs "$P" [--no-signin] STEP…` | headless Chromium via Playwright. Signs in through the "Operator sign-in" dialog first unless `--no-signin`. | see below |
| `af-db.sh "$P" state\|traces "SQL"` | read-only SQL on a **copy** of `<home>/state.db` (sqlite3) or `<home>/traces.duckdb` (`@duckdb/node-api`). | `$S/af-db.sh "$P" state "select id,status from approvals"` |

Browser steps (one argument each, names are exact accessible names):

- `goto:#/<view>` where view ∈ `overview sources skills profiles safety events auth telemetry`
- `click:<role>:<name>` e.g. `click:tab:Safety & Approvals`, `click:button:Approve verify_echo`
- `fill:<label>=<value>` e.g. `fill:Secret name (required)=verify_api_key`
- `expect:<role>:<name>` e.g. `expect:heading:Sources & Pool`, `expect:article:Approval for verify_echo`
- `expect-text:<text>` e.g. `expect-text:Nothing is waiting for approval.`
- `snap:<name>` writes `<proof>/browser/<name>.png` and `<name>.aria.txt`

Console view headings (h1) and tab names: `Overview` / tab `Overview & Connect`; `Sources & Pool`; `Skills & Shared Folders` / tab `Skills & Folders`; `Profiles & Discovery`; `Safety & Approvals`; `Events`; `Auth & Secrets`; `Telemetry & Portability`. The page title is `<tab label> · AgentFabric`.

Smoke drive that touches every surface (use it after any change, then drive the specific journey):

```sh
$S/af-api.sh "$P" POST /api/sources '{"id":"verify-echo","name":"Verify Echo","kind":"cli_wrapper","config":{"kind":"cli_wrapper","toolName":"verify_echo","description":"Echo a message back","command":"/usr/bin/echo","argsTemplate":["{{message}}"],"inputSchema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}}'
$S/af-mcp.sh "$P" default tools/list | jq -c '[.result.tools[].name]'
$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"hello fabric"}}' | jq -c .result.content
$S/af-cli.sh "$P" status
node $S/af-browser.mjs "$P" 'click:tab:Sources & Pool' 'expect-text:Verify Echo' 'snap:sources'
```

Expected: `tools/list` returns `fabric_search`, `fabric_inspect`, `fabric_call`, `fabric_propose_capability`, `verify_echo`. The call returns `[{"type":"text","text":"hello fabric\n"}]`. The CLI prints `Gateway healthy · mode local · v0.1.0`. The screenshot shows `Verify Echo` as `healthy` in the Sources table.

Playwright is not a repo dependency. `af-browser.mjs` loads it from `PLAYWRIGHT_MODULE`, then `require('playwright')`, then the install behind `mise which playwright` or `command -v playwright`. Browsers must be installed (`playwright install chromium`). If none resolves, report the browser journey as blocked with that reason. Do not substitute curl for a UI claim.

## Evidence

Everything lands in the proof dir and survives Cleanup:

- `launch.txt` (redacted banner, URL, PID, home, git SHA), `session.env`
- `transcript/NNN-<api|mcp|cli|db>-<label>.txt`: the request (method, URL, JSON body), the status, MCP response headers, and the response, written by every helper call. Operator tokens (`afop_…`) and client tokens (`af_tok_…`) are masked, and so are `value` fields sent to `/api/secrets/*`.
- `browser/<name>.png` + `browser/<name>.aria.txt` (URL, page title, full ARIA tree), `browser/console.txt` (console errors, failed requests, HTTP ≥ 400), `browser/failure.png` on a failed step
- `gateway.log` (redacted server log including the shutdown line), `home-listing.txt` (state files present at teardown), `cleanup.txt`
- Anything you write yourself, such as an exported bundle: put it under `$P/`.

Proof standards:

- Drive the real user path: MCP through `/mcp/<profile>` with a minted client token, operator actions through the console or `/api`, terminal actions through `agentfabric`. Never call runtime internals, `src/testing/mock-runtime.ts`, or the vitest suite and call it verification.
- Capture the action **and** the resulting state from a second view. Examples: approve in the browser, then show the blocked MCP call returned and `approvals` reads `approved` in `state.db`. Import with the CLI, then list sources over `/api`.
- Verify side effects: rows via `af-db.sh`, traces via `/api/telemetry/*` or `af-db.sh traces`, files such as an export bundle on disk, event occurrences via `events/poll` or `agentfabric events list`.
- Prove negative paths with their exact codes: 401 + `WWW-Authenticate` without a token, 403 `FORBIDDEN` for a token on another profile, JSON-RPC `-32602` for unexpected arguments, `-32024` `CAPABILITY_DENIED`, `-32601` for unknown methods.
- No mocks. Upstream fixtures are real local executables (`/usr/bin/echo`, `/usr/bin/date`, `/usr/bin/uname`) or in-gateway skill sources. Only mock what a production boundary already isolates, and say so.
- LLM drafting (`/api/policies/draft`, overlay drafts) uses `AGENTFABRIC_LLM_*`, which launch strips. With no LLM configured, drafts come from the deterministic heuristic (`draftedBy: "heuristic"`; policy drafts arrive `enabled: false`). Report LLM-backed drafting as not covered unless you launched with a real provider on purpose.

Report each journey as: feature ID, entry point used, commands, observed result, artifact paths. Report a journey you could not run with the command attempted and the unmet precondition. Never report a skipped entry point as verified through a different one.

## Cleanup

```sh
$S/af-cleanup.sh "$P"           # exit 0 = everything torn down, proof kept
```

It copies the redacted `gateway.log` and a `home-listing.txt` into the proof dir. It then sends SIGTERM to `AF_PID` only if `/proc/<pid>/cmdline` is still our `dist/cli/index.js start … --home <home>`, waits up to 15 s for the graceful `Received SIGTERM, shutting down…`, and escalates to SIGKILL only for that PID. It confirms the PID is gone and the port is free, and deletes the home only if the path matches `${TMPDIR:-/tmp}/agentfabric-verify-home-*`. It confirms the proof dir still exists and writes `cleanup.txt`. It never kills by process name and never deletes the proof dir. It is idempotent: run it after every failed launch or drive too.

Background calls you started (for example a blocked `tools/call` waiting on an approval) end when the gateway stops. Delete the proof dir yourself only when nobody needs the evidence.

## Helpers

All scripts are executable. Paths are relative to the repo root.

```sh
.claude/skills/verify/scripts/af-launch.sh [RUN_ID]                      # → prints proof dir
.claude/skills/verify/scripts/af-doctor.sh <proof>
.claude/skills/verify/scripts/af-api.sh <proof> GET /api/capabilities?profileId=default
.claude/skills/verify/scripts/af-mcp.sh <proof> default tools/call '{"name":"fabric_search","arguments":{"query":"echo"}}'
.claude/skills/verify/scripts/af-cli.sh <proof> export --out <proof>/export.json
node .claude/skills/verify/scripts/af-browser.mjs <proof> 'goto:#/auth' 'expect:heading:Auth & Secrets' 'snap:auth'
.claude/skills/verify/scripts/af-db.sh <proof> traces "select status, count(*) from traces group by status"
.claude/skills/verify/scripts/af-cleanup.sh <proof>
```

`lib.sh` is sourced by the shell helpers (session loading, token redaction, transcript numbering, PID ownership check). Do not run it directly. Requirements: `bash`, `curl`, `jq`, `ss`, `sqlite3` (for `af-db.sh state`), Node.js 26+, and Playwright with Chromium for browser steps.

Two instances side by side are supported. Each launch gets its own RUN_ID, home, port, and proof dir. The portability journey uses that.

To keep the map honest as the app changes, run `/maintain-verification-skill`.
