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

State lives outside the repository in `$AGENTFABRIC_HOME` (default `~/.agentfabric`), including the generated `operator-token` file (mode `0600`). Registries, credentials, profiles, and telemetry never belong in git.

## Connect any harness in one step

Open **Overview & Connect**, pick a profile, mint a token, and copy the snippet for your harness:

| Harness | Auth | Where you paste it |
| --- | --- | --- |
| Claude on the web | OAuth 2.1 + PKCE (dynamic client registration, approved on the gateway consent page) | Settings → Connectors → Add custom connector |
| Claude Code | Bearer token | `claude mcp add --transport http …` |
| Codex | Bearer token from an environment variable | `~/.codex/config.toml` |
| Cursor | Bearer token from an environment variable | `mcp.json` |
| Generic MCP 2026-07-28 + Events | Bearer token | any client |

One endpoint (`/mcp/<profile>`) serves tools, prompts, resources, skills (`skill://` over `io.modelcontextprotocol/skills`), and events (`io.modelcontextprotocol/events`). AgentFabric never writes files or symlinks into harness-specific folders; you paste the snippet yourself.

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
- **`src/cli`**: `agentfabric start | status | token create | export | import | approvals … | recipes list | events …`.
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
| **Cloudflare Workers** | `npm run build`, `wrangler secret put AGENTFABRIC_OPERATOR_TOKEN`, `wrangler deploy`. Runs in `remote` mode: local CLI wrappers and stdio processes are refused, and the gateway never tunnels back into your machine. Serve the UI with a Workers static assets binding named `ASSETS` pointing at `dist/web`, and bind a Cloudflare D1 database as `DB` (or set `AGENTFABRIC_ALLOW_EPHEMERAL=1` for ephemeral testing). |

Environment variables: `AGENTFABRIC_HOME`, `AGENTFABRIC_PORT`, `AGENTFABRIC_HOST`, `AGENTFABRIC_PUBLIC_URL`, `AGENTFABRIC_MODE`, `AGENTFABRIC_OPERATOR_TOKEN`, and `AGENTFABRIC_LLM_API_URL`, `AGENTFABRIC_LLM_API_KEY_SECRET`, `AGENTFABRIC_LLM_MODEL`, `AGENTFABRIC_LLM_PROVIDER` for LLM-assisted drafting.

## Development

```sh
npm run typecheck      # server and web
npm run build:web
npm run test:server    # HTTP, API, auth pages, CLI, deploy adapters (mock runtime)
npm test               # everything
```

Contracts are held to behavioral tests covering invalid inputs, broken upstreams, and fail-closed boundaries. `src/testing/mock-runtime.ts` lets the server layer be tested independently of the core engine.
