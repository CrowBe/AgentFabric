# AgentFabric

A persistent, single-operator MCP capability gateway that pools, normalises, scopes, authenticates, and routes tools, prompts, resources, and agent skills behind one endpoint.

Read [`STRATEGY.md`](STRATEGY.md) before proposing architecture, stack choices, or changes. Its `## Vision` section is the project's acceptance policy.

## Quickstart

Requires Node.js 26 or newer.

```sh
npm ci
npm run build          # server (dist/) and operator web UI (dist/web/)
node dist/cli/index.js start
```

The banner prints everything you need:

```
 Mode           local
 MCP URL        http://127.0.0.1:7432/mcp
 Web UI         http://127.0.0.1:7432/
 Operator token afop_…
```

Open the Web UI, paste the operator token, and add a source from **Sources & Pool**. For development run `npm run dev:server` and `npm run dev:web` (Vite proxies to the gateway on port 7432).

State lives outside the repository in `$AGENTFABRIC_HOME` (default `~/.agentfabric`): the local Turso database `state.db`, DuckDB traces `traces.duckdb`, the encrypted vault `secrets.enc` (keyed by `master.key`, or by `AGENTFABRIC_MASTER_KEY` when set), and the generated `operator-token` file (mode `0600`). Registries, credentials, profiles, and telemetry never belong in git.

## Connect any harness in one step

Open **Overview & Connect**, pick a profile, mint a token, and copy the snippet for your harness:

| Harness | Auth | Where you paste it |
| --- | --- | --- |
| Claude on the web | OAuth 2.1 + PKCE (dynamic client registration, approved on the gateway consent page) | Settings → Connectors → Add custom connector |
| Claude Code | Bearer token | `claude mcp add --transport http …` |
| Codex | Bearer token from an environment variable | `~/.codex/config.toml` |
| Cursor | Bearer token from an environment variable | `mcp.json` |
| Generic MCP 2026-07-28 + Events | Bearer token | any client |

Claude on the web completes OAuth 2.1 + PKCE and the operator approves the client on the consent page. CLI and IDE harnesses use minted bearer tokens scoped to a profile.

Browser requests to `/mcp` are validated by `Origin`: it must match `AGENTFABRIC_PUBLIC_URL` or be a same-port loopback alias, otherwise the gateway answers `403`.

One endpoint (`/mcp/<profile>`) serves tools, prompts, resources, skills (`skill://` over `io.modelcontextprotocol/skills`), and events (`io.modelcontextprotocol/events`). AgentFabric never writes files or symlinks into harness-specific folders; you paste the snippet yourself.

## Gateway and pool model

Sources come in seven kinds: `mcp_stdio`, `mcp_http`, `cli_wrapper`, `composite`, `skill`, `skill_repo`, and `shared_folder`. Their capabilities are pooled, normalised, and scoped per profile.

- Every profile always gets four built-in meta-tools: `fabric_search`, `fabric_inspect`, `fabric_call`, and `fabric_propose_capability`.
- `tools/list` shows built-ins plus up to `directToolBudget` pooled tools (default `24`). Overflow tools become `searchable` and are reached through `fabric_search` and `fabric_call`.
- Policy precedence is `deny > require_approval > allow`. Approval-gated calls wait for an operator decision.

Upstream OAuth 2.0/2.1: for an `mcp_http` source that needs OAuth, register `<publicUrl>/auth/oauth/callback` as the redirect URI. The gateway discovers metadata automatically or accepts manual endpoints, uses dynamic client registration or a pre-registered client, refreshes tokens, and supports disconnect.

## Protocol surface

- MCP `2026-07-28` plus legacy `2025-11-25`, `2025-06-18`, and `2025-03-26`.
- Upstream elicitation passes through lazily over SSE in `form` and `url` modes for elicitation-capable legacy sessions.
- Events (`io.modelcontextprotocol/events`): polling, an SSE stream, and webhooks, plus proxied upstream poll and push.
- Export is a secret-free config bundle. Import `merge` overwrites matching IDs (`--replace` replaces everything), and executable sources (`mcp_stdio`, `cli_wrapper`) import disabled unless you opt in explicitly.

## Architecture

```
harness ──HTTPS──▶ Hono app (src/server) ──▶ GatewayRuntime (src/runtime)
                     │  /mcp, /oauth, /.well-known       │ sources, pool, overlays, profiles,
                     │  /auth/connect (secret handoff)   │ policies, approvals, proposals,
                     │  /api (operator REST, guarded)    │ events, telemetry, secrets
                     └─ web/ (React operator UI)         └─ storage + trace stores
```

- **`src/server`**: transport only. Routes delegate to the `GatewayRuntime` contract in `src/types`. Operator routes (`/api/*`) fail closed with `401` unless `authenticateOperator` passes. Inputs are validated with strict Zod schemas that reject unexpected fields.
- **`src/deploy`**: `node.ts` (persistent launcher), `cloudflare.ts` (Workers adapter, always `remote` mode), `recipes.ts` (generic starter recipes).
- **`src/cli`**: `agentfabric start | status | token create | export | import | approvals list|approve|deny | skills list|add | proposals list|activate|reject | recipes list | events list|emit`. Connection flags: `--url` (`AGENTFABRIC_URL`), `--token` (`AGENTFABRIC_OPERATOR_TOKEN` or `<home>/operator-token`), `--home`, `--json`.
- **`web/`**: the operator console built on `@ui-sdk/react`: onboarding, LLM-drafted overlays, skills and shared folders, profiles and direct-tool budgets, live approvals, events, auth and secrets, telemetry, and secret-free export/import.

Security properties worth knowing:

- Secrets are write-only through the API and UI. Values are never returned.
- The upstream auth handoff page (`/auth/connect/:source?ticket=…`) accepts only secret names the source declares and never echoes values.
- The OAuth consent page requires the operator token before it approves a client.
- Agent-drafted capabilities stay inactive until you activate them in **Safety & Approvals**.

## Deployment

Pick the smallest option that fits. All of them speak standard remote MCP and need no custom relay.

| Where | How |
| --- | --- |
| **Local only** (default) | `agentfabric start`. Binds `127.0.0.1:7432`. Local CLI wrappers and shared folders are available. |
| **Tailscale Funnel** | Run the gateway locally, then `tailscale funnel 7432`. Start with `AGENTFABRIC_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` so OAuth metadata and snippets use the public URL. |
| **Cloudflare Tunnel** | `cloudflared tunnel --url http://127.0.0.1:7432` (or a named tunnel), then set `AGENTFABRIC_PUBLIC_URL` to the tunnel hostname. |
| **Cloudflare Workers** | `npm run build`, `cf workers secrets update AGENTFABRIC_OPERATOR_TOKEN`, `cf workers secrets update AGENTFABRIC_MASTER_KEY`, `cf deploy`. Runs in `remote` mode: local CLI wrappers and stdio processes are refused, and the gateway never tunnels back into your machine. Serve the UI with a Workers static assets binding named `ASSETS` pointing at `dist/web`, and bind a Cloudflare D1 database as `DB` (or set `AGENTFABRIC_ALLOW_EPHEMERAL=1` for ephemeral testing). With `DB` bound, the Worker refuses to start until `AGENTFABRIC_MASTER_KEY` is set; it stores secrets in D1 through `D1SecretStore` (WebCrypto HKDF + AES-256-GCM), so use a high-entropy random value (for example `openssl rand -base64 32`) and keep it stable, because a changed key cannot decrypt existing secrets. |

Workers keep traces in memory. Approval waiters, legacy sessions and elicitation, and background timers and webhooks are isolate-local, so multiple Worker isolates do not share them without Durable Objects.

Environment variables: `AGENTFABRIC_HOME`, `AGENTFABRIC_PORT`, `AGENTFABRIC_HOST`, `AGENTFABRIC_URL` (CLI target), `AGENTFABRIC_PUBLIC_URL`, `AGENTFABRIC_MODE`, `AGENTFABRIC_OPERATOR_TOKEN`, `AGENTFABRIC_MASTER_KEY`, `AGENTFABRIC_ALLOW_EPHEMERAL` (Workers only), and `AGENTFABRIC_LLM_API_URL`, `AGENTFABRIC_LLM_API_KEY_SECRET`, `AGENTFABRIC_LLM_MODEL`, `AGENTFABRIC_LLM_PROVIDER` for LLM-assisted drafting.

## Development

```sh
npm run typecheck      # server and web
npm run build:web
npm run test:server    # HTTP, API, auth pages, CLI, deploy adapters (mock runtime)
npm test               # everything
```

Contracts are held to behavioral tests covering invalid inputs, broken upstreams, and fail-closed boundaries. `src/testing/mock-runtime.ts` lets the server layer be tested independently of the core engine.
