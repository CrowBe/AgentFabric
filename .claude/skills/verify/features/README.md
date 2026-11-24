# AgentFabric verification map

This directory is the maintained source for verifying the user-facing behavior of AgentFabric. Read this index before driving the gateway, then use the matching feature file as the recipe. The harness is the `verify` skill helpers in `.claude/skills/verify/scripts/` (see `../SKILL.md`).

## Baseline preconditions

- Run commands from the repository root with `S=.claude/skills/verify/scripts`.
- Launch with `P=$($S/af-launch.sh)`. It uses a disposable `${TMPDIR:-/tmp}/agentfabric-verify-home-<RUN_ID>`, an OS-assigned port on `127.0.0.1`, and scrubbed `AGENTFABRIC_*` variables. It never uses `~/.agentfabric` or port 7432.
- Run `$S/af-doctor.sh "$P"` and require `doctor: healthy`.
- A fresh home has no sources, one `default` profile (`defaultExposure: direct`, `directToolBudget: 24`), and no client tokens. Seed fixtures with the commands in each feature's preconditions.
- Never drive an instance that was not started by this verification run.

## Shared fixtures

Seed these through the operator API when a feature lists them. They use only local executables and in-gateway content, so they need no network or credentials.

- **Echo tool** (`verify-echo` source, `verify_echo` tool):
  `$S/af-api.sh "$P" POST /api/sources '{"id":"verify-echo","name":"Verify Echo","kind":"cli_wrapper","config":{"kind":"cli_wrapper","toolName":"verify_echo","description":"Echo a message back","command":"/usr/bin/echo","argsTemplate":["{{message}}"],"inputSchema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}}'`
- **Release skill** (`verify-skill` source, `skill://release-checklist`, prompt `skill:release-checklist`):
  `$S/af-api.sh "$P" POST /api/sources '{"id":"verify-skill","name":"Verify Skill","kind":"skill","config":{"kind":"skill","slug":"release-checklist","title":"Release checklist","description":"Use before tagging a release","content":"# Release checklist\n\n1. Run tests\n2. Tag","tags":["release"]}}'`

## Driving conventions

- Start every recipe from the baseline state plus the fixtures it lists.
- MCP actions go through `$S/af-mcp.sh "$P" <profile> <method> [params]`, which mints and caches a real client token for that profile.
- Operator actions go through the console (`node $S/af-browser.mjs "$P" …`), the REST API (`$S/af-api.sh`), or the CLI (`$S/af-cli.sh`). Use the entry point the recipe names.
- Browser handles are ARIA roles plus exact accessible names, or field labels. Never use CSS selectors or coordinates.
- Treat every command as literal. Keep quoted names, ids, and flags unchanged.
- Blocking MCP calls (approval gates) run in the background with `AF_MAX_TIME` raised, output redirected to `$P/`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a `snap:` step (screenshot plus ARIA tree) taken after the action, with the app identity visible.
- MCP, API, and CLI proof is the helper transcript in `$P/transcript/` (request, status, response, exit code).
- Mutation proof includes a read-only second view: a list endpoint, `af-db.sh`, or another surface.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [MCP gateway and unified pool](./mcp-gateway-and-pool.md) covers harness auth, tools, prompts, resources, skills, the `fabric_*` discovery tools, profile scoping, and strict argument validation.
- [Operator web dashboard and REST API](./operator-web-dashboard.md) covers the token gate, Sources & Pool, Profiles, Auth & Secrets, and the fail-closed `/api`.
- [Safety, approvals, and proposals](./safety-approvals-and-proposals.md) covers approval policies, live approve and deny of blocked calls, and the proposal activation gate.
- [MCP events and telemetry](./mcp-events-and-telemetry.md) covers `io.modelcontextprotocol/events` list, poll, and push, operator emit, and DuckDB trace telemetry.
- [CLI and portability](./cli-and-portability.md) covers the `agentfabric` CLI and secret-free export and import between two instances.
