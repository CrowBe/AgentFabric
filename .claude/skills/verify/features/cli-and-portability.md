# CLI and portability

The `agentfabric` CLI lets the operator check gateway health, mint harness tokens, handle approvals, proposals, and events, list starter recipes, import and list skills, and move configuration between machines. Exports contain sources, profiles, overlays, and policies but never secret values. An import on another gateway recreates the pool, and executable sources stay disabled until the operator re-enables them.

## Sub-features

- `cli-status` prints health, mode, version, public URL, and counts.
- `cli-token` mints a profile-scoped bearer token that works on `/mcp/<profile>`.
- `cli-recipes` lists all eight generic starter recipes without contacting a gateway.
- `cli-skills` imports skills from a GitHub URL (`skills add`) and lists pooled skills (`skills list`).
- `cli-proposals` lists, activates, and rejects agent capability proposals.
- `cli-auth-errors` fails with a clear message and exit `1` for a wrong token or an unreachable gateway.
- `export-secret-free` writes a bundle with no secret values or operator tokens.
- `import-merge` loads the bundle into a second, empty gateway.
- `import-executables-disabled` imports CLI wrapper sources disabled by default.
- `import-invalid` rejects a malformed bundle with `400 INVALID_INPUT`.
- `import-replace-revokes` revokes client tokens and OAuth refresh tokens of profiles that `import --replace` drops (see [security-lifecycle.md](./security-lifecycle.md)).

## How to get to it (user POV)

- Terminal: `agentfabric <command> [--url URL] [--token TOKEN] [--home DIR] [--json]`. The token falls back to `$AGENTFABRIC_OPERATOR_TOKEN`, then `<home>/operator-token`. The URL falls back to `$AGENTFABRIC_URL`, then `http://127.0.0.1:$AGENTFABRIC_PORT` (default 7432).
- Console: **Telemetry & Portability** → `Portability` card (`Export configuration`, `Import configuration`, `Merge with existing configuration` switch, `Import`).
- API: `GET /api/config/export`, `POST /api/config/import {"bundle":…,"merge":true,"enableExecutables":false}`.

## Driving it with af-cli.sh

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy` for instance A.
- The **Echo tool** and **Release skill** fixtures from `README.md` are seeded on A.
- A secret is stored on A: `$S/af-api.sh "$P" PUT /api/secrets/verify_api_key '{"value":"sk-verify-SECRET-123"}'`.

- **Status.** Run `$S/af-cli.sh "$P" status`. Exit `0`. Output starts with `Gateway healthy · mode local · v0.1.0` and lists `sources 2`.
- **Recipes.** Run `$S/af-cli.sh "$P" recipes list`. The table has columns `ID KIND LOCAL ONLY TITLE` and exactly eight rows: `mcp-stdio-generic` (`mcp_stdio`, yes), `mcp-http-remote` (`mcp_http`), `mcp-http-oauth` (`mcp_http`, `Remote MCP server (OAuth 2.0 / 2.1)`), `openconnector-http` (`mcp_http`), `cli-wrapper-readonly` (`cli_wrapper`, yes, title `CLI wrapper`), `shared-workspace-folder` (`shared_folder`), `agent-skill` (`skill`), and `github-skill-repo` (`skill_repo`, `Skills from GitHub repository`). `$S/af-cli.sh "$P" recipes list --json | jq -c '[.recipes[].id]'` gives the same ids in order.
- **Skills list.** Run `$S/af-cli.sh "$P" skills list`. The table has columns `SLUG SOURCE URI AVAILABLE`, with `release-checklist  Verify Skill  skill://release-checklist  yes`. On an instance with no skills it prints `No skills in the pool.`
- **Skills add (needs GitHub HTTPS).** Run `$S/af-cli.sh "$P" skills add https://github.com/anthropics/skills --name "Verify GitHub Skills" --include pdf --include skill-creator --tag verify`. It prints `Imported 2 skill(s) from Verify GitHub Skills (<uuid>, health: healthy)`, and `skills list` adds `pdf` and `skill-creator` from `Verify GitHub Skills`. Offline negatives: `$S/af-cli.sh "$P" skills add https://gitlab.com/example/skills` exits `1` with `400 INVALID_INPUT: Unsupported host 'gitlab.com': only github.com and raw.githubusercontent.com are allowed`, and `$S/af-cli.sh "$P" skills add` exits `1` with the usage line.
- **Proposals.** `$S/af-cli.sh "$P" proposals list` prints `No proposals.` on a fresh instance. For submit, activate, and reject, see [safety-approvals-and-proposals.md](./safety-approvals-and-proposals.md).
- **Mint a harness token.** Run `$S/af-cli.sh "$P" token create --profile default --label verify-cli --json | jq -r .token >"$P/.cli-token"`, then `AF_MCP_TOKEN=$(cat "$P/.cli-token") $S/af-mcp.sh "$P" default tools/list`. `HTTP 200` lists `verify_echo`. Delete `$P/.cli-token` afterwards.
- **Wrong token.** Run `$S/af-cli.sh "$P" status --token afop_wrong`. Exit `1` with `Operator authentication failed. Pass --token, set AGENTFABRIC_OPERATOR_TOKEN, or check <home>/operator-token.`
- **Export.** Run `$S/af-cli.sh "$P" export --out "$P/export.json"`. It prints `Exported secret-free configuration to …`. `jq -c '{v:.schemaVersion,sources:[.sources[].id]}' "$P/export.json"` shows `schemaVersion 1` with `verify-echo` and `verify-skill`. `grep -cE 'sk-verify-SECRET-123|afop_|af_tok_' "$P/export.json"` prints `0`.
- **Second instance.** Launch B. Run `P2=$($S/af-launch.sh)` and `$S/af-doctor.sh "$P2"`. B has a different port, home, and operator token.
- **Import.** Run `$S/af-cli.sh "$P2" import "$P/export.json"`. It prints `Imported <n> sources, <n> profiles, <n> overlays, <n> policies`. With only this file's preconditions that is `2 sources, 1 profiles, 0 overlays, 0 policies`. The counts follow what A held.
- **Imported state.** Run `$S/af-api.sh "$P2" GET /api/sources | jq -c '[.sources[]|{id,enabled,health}]'`. `verify-skill` is `enabled:true`/`healthy`, and `verify-echo` is `enabled:false`/`disabled`. `$S/af-api.sh "$P2" GET /api/secrets` returns `{"secrets":[]}`. `$S/af-mcp.sh "$P2" default skills/list` lists `release-checklist`.
- **Re-enable an executable.** Run `$S/af-api.sh "$P2" PATCH /api/sources/verify-echo '{"enabled":true}'` (it reports `enabled:true`/`healthy`), then `$S/af-mcp.sh "$P2" default tools/call '{"name":"verify_echo","arguments":{"message":"after import"}}'`. The call returns `after import`.
- **Policies travel.** If A held the `Gate verify echo` policy from the safety journey, B enforces it too. `$S/af-api.sh "$P2" GET /api/policies` lists it, and the call above blocks. Run the call in the background (`AF_MAX_TIME=60 … >"$P2/after-import-call.out" 2>&1 &`), then run `$S/af-cli.sh "$P2" approvals approve <id>`. The output file then holds `after import`.
- **Invalid bundle.** Run `echo '{"schemaVersion":2}' >"$P/bad-bundle.json"` and `$S/af-cli.sh "$P2" import "$P/bad-bundle.json"`. Exit `1` with `400 INVALID_INPUT: Invalid request`.
- **Proof.** Keep `export.json`, both proof dirs' transcripts, and a second view of B: `node $S/af-browser.mjs "$P2" 'click:tab:Sources & Pool' 'expect-text:Verify Skill' 'snap:imported-sources'`. Run `$S/af-cleanup.sh "$P2"` and then `$S/af-cleanup.sh "$P"`.

## Gotchas

- `af-cli.sh` appends `--url` and `--home` itself, so do not pass them again. `parseArgs` is strict, and unknown flags exit `1`.
- `--json` is the stable output for assertions. The default output is an aligned table.
- `import` merges by default. `--replace` replaces existing sources, overlays, profiles, and policies on the target, and revokes the bearer and OAuth refresh tokens of every profile it drops. Recreating a dropped profile by name does not revive them.
- The CLI cannot set `enableExecutables`. Imported `cli_wrapper`, `mcp_stdio`, and similar sources arrive disabled, which is the intended fail-safe. Re-enable them explicitly through the API or the console `Enable <name>` switch.
- Secrets never travel. On the target, calls into a source whose `authConfig` names a secret fail with `AUTH_REQUIRED` ("Required upstream credentials are missing") until the operator re-enters the value. The seed fixtures need no secret, so this path is not part of the journey above.
- The `export` without `--out` prints the bundle to stdout, and that lands in the transcript, which is fine because it is secret-free.
- Imported policies are enabled and enforced immediately. A foreground call to a gated tool on B blocks until `AF_MAX_TIME` (curl exit 28, `HTTP 000`), and its approval then shows `expired`. That is a gate working, not a broken import.
- Import counts include everything A held at export time: proposal-activated sources (`proposal-<id>`), every profile, and every policy. Assert the ids you seeded, not exact totals.
- Each instance needs its own cleanup. Cleaning up A does not stop B.
- `skills add` takes repeatable `--include` and `--tag` flags. `--secret NAME` names a vault secret for private repos and never takes a token value.
- `skills list` shows every skill capability, including in-gateway `skill` sources, not only GitHub imports.
- An exported `skill_repo` source carries only its URL, ref, path, and filters. After import the target fetches the repository again, which needs GitHub reachability.
