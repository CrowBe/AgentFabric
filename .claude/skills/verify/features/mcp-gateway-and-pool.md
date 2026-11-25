# MCP gateway and unified pool

A harness points at one endpoint, `/mcp/<profile>`, with a bearer token. It then sees the pooled tools, prompts, resources, and agent skills for that profile, plus the built-in discovery tools `fabric_search`, `fabric_inspect`, `fabric_call`, and `fabric_propose_capability`. Skills can come from in-gateway sources or from GitHub skill repositories, which the gateway serves as multi-file `skill://` resources. Unauthenticated, foreign-profile, and malformed requests fail closed with truthful codes.

## Sub-features

- `mcp-auth` rejects missing bearer tokens (401 + `WWW-Authenticate`) and tokens minted for another profile (403 `FORBIDDEN`).
- `mcp-oauth-discovery` publishes protected-resource metadata that points harnesses at the gateway's OAuth server.
- `mcp-initialize` negotiates protocol `2026-07-28` and advertises tools, prompts, resources, events, and the skills extension.
- `mcp-tools` lists built-ins plus direct pool tools and calls an upstream tool.
- `mcp-strict-args` rejects unexpected tool arguments with JSON-RPC `-32602`.
- `cli-optional-args` appends a CLI wrapper's `optionalArgs` only when the caller supplies them: `value` (`--flag <v>`), `flag` (`--flag` when `true`), and `repeat` (`--flag <v>` per array item).
- `mcp-discovery` finds, inspects, and calls capabilities through `fabric_search`, `fabric_inspect`, and `fabric_call`.
- `mcp-prompts` lists and renders a skill-backed prompt.
- `mcp-resources-skills` lists resources, reads `skill://` content, and lists skills over `skills/list`.
- `skill-repo` imports skills from a GitHub repository (`skill_repo` source) and serves each skill's `SKILL.md` and attached files as `skill://<slug>/<path>`.
- `skill-content-preview` returns a skill's markdown (and a repo skill's attached files) to the operator over `GET /api/capabilities/<id>/content`.
- `mcp-profile-scope` hides capabilities a profile's rules hide, and denies calling them.
- `mcp-unknown-method` answers `-32601 Method not found`.

## How to get to it (user POV)

- Mint a token in the console (**Overview & Connect** → `Mint token`, or **Auth & Secrets** → `Scoped bearer tokens`), then paste the snippet into a harness.
- Run `agentfabric token create --profile <name>` and configure the harness with `<url>/mcp/<name>`.
- Remote harnesses (Claude on the web) discover OAuth via `/.well-known/oauth-protected-resource/mcp/<profile>`.
- Operators add GitHub skills with `agentfabric skills add <github-url>`, the `github-skill-repo` recipe, or **Skills & Folders** → `Import from GitHub URL`. Agents can propose one with `fabric_propose_capability` (`kind: skill_repo`).

## Driving it with af-mcp.sh

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- The **Echo tool** and **Release skill** fixtures from `README.md` are seeded.

- **Reject anonymous.** Call without a token. Run `AF_MCP_TOKEN=none $S/af-mcp.sh "$P" default tools/list`. The result is `HTTP 401` with error `A valid bearer token is required` (`data.code: UNAUTHORIZED`). The transcript shows a `www-authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp/default"` header.
- **OAuth discovery.** Run `curl -s "$(. "$P/session.env"; echo "$AF_URL")/.well-known/oauth-protected-resource/mcp/default"`. The JSON has `resource` ending in `/mcp/default`, `authorization_servers` = the gateway URL, and `scopes_supported: ["mcp"]`.
- **Initialize.** Run `$S/af-mcp.sh "$P" default initialize '{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"verify-harness","version":"1"}}'`. `result.protocolVersion` is `2026-07-28`, `serverInfo.name` is `AgentFabric`, and the capabilities include `tools prompts resources events extensions`. The transcript shows an `mcp-session-id` header.
- **List tools.** Run `$S/af-mcp.sh "$P" default tools/list | jq -c '[.result.tools[].name]'`. Output is `["fabric_search","fabric_inspect","fabric_call","fabric_propose_capability","verify_echo"]`.
- **Call a pooled tool.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"hello fabric"}}' | jq -c .result.content`. Output is `[{"type":"text","text":"hello fabric\n"}]`.
- **Strict arguments.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"x","extra":1}}'`. The error code is `-32602` with `additionalProperty: "extra"` and `data.code: INVALID_INPUT`.
- **Search.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_search","arguments":{"query":"release"}}' | jq -c '[.result.structuredContent.capabilities[].exposedName]'`. Output is `["release-checklist","skill:release-checklist"]`.
- **Inspect.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_inspect","arguments":{"capability":"verify_echo"}}' | jq -c '.result.structuredContent|{exposedName,available,permission}'`. Output is `{"exposedName":"verify_echo","available":true,"permission":"allow"}`.
- **Indirect call.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_call","arguments":{"capability":"verify_echo","arguments":{"message":"via fabric_call"}}}' | jq -c .result.content`. Output is `[{"type":"text","text":"via fabric_call\n"}]`.
- **Prompts.** Run `$S/af-mcp.sh "$P" default prompts/list` and `$S/af-mcp.sh "$P" default prompts/get '{"name":"skill:release-checklist"}'`. The list has `skill:release-checklist`, and the get returns one user message whose text starts with `# Release checklist`.
- **Resources and skills.** Run `$S/af-mcp.sh "$P" default resources/list`, `$S/af-mcp.sh "$P" default resources/read '{"uri":"skill://release-checklist"}'`, and `$S/af-mcp.sh "$P" default skills/list`. The resource `skill://release-checklist` has `mimeType` `text/markdown`. The read returns the markdown. `skills/list` returns `frontmatter.name: release-checklist` with a `sha256:` digest.
- **Profile scope.** Create a narrow profile. Run `$S/af-api.sh "$P" POST /api/profiles '{"name":"verify-narrow","defaultExposure":"searchable","directToolBudget":0,"rules":[{"id":"hide-echo","capabilityPattern":"verify_echo","exposure":"hidden"}]}'`. Then run `$S/af-mcp.sh "$P" verify-narrow tools/list`. Only the four `fabric_*` tools appear. Next run `$S/af-mcp.sh "$P" verify-narrow tools/call '{"name":"fabric_call","arguments":{"capability":"verify_echo","arguments":{"message":"x"}}}'`. It fails with `-32024` `Capability is denied by profile policy`.
- **Foreign profile token.** Reuse the default token on the narrow profile. Run `AF_MCP_TOKEN=$(cat "$(. "$P/session.env"; echo "$AF_HOME")/mcp-token-default") $S/af-mcp.sh "$P" verify-narrow tools/list`. The result is `HTTP 403` with `This token cannot access the requested MCP profile`.
- **Unknown method.** Run `$S/af-mcp.sh "$P" default nope/nope`. The error code is `-32601` `Method not found`.
- **Optional CLI arguments.** Seed a wrapper with all three modes. Run `$S/af-api.sh "$P" POST /api/sources '{"id":"verify-echo-opts","name":"Verify Echo Options","kind":"cli_wrapper","config":{"kind":"cli_wrapper","toolName":"verify_echo_opts","description":"Echo with optional flags","command":"/usr/bin/echo","argsTemplate":["{{message}}"],"optionalArgs":[{"key":"prefix","flag":"--prefix"},{"key":"loud","flag":"--loud","mode":"flag"},{"key":"tag","flag":"--tag","mode":"repeat"}],"inputSchema":{"type":"object","properties":{"message":{"type":"string"},"prefix":{"type":"string"},"loud":{"type":"boolean"},"tag":{"type":"array","items":{"type":"string"}}},"required":["message"]}}}'` (`HTTP 201`, `healthy`). Then call it three ways with `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo_opts","arguments":<ARGS>}' | jq -c .result.content`:
  - `{"message":"plain"}` prints `[{"type":"text","text":"plain\n"}]`, so omitted options add nothing.
  - `{"message":"full","prefix":"P","loud":true,"tag":["a","b"]}` prints `"full --prefix P --loud --tag a --tag b\n"`.
  - `{"message":"quiet","loud":false,"tag":[]}` prints `"quiet\n"`, so `false` and an empty array add nothing.

  `{"message":"x","bogus":1}` fails with `-32602`, `additionalProperty: "bogus"`, and `data.code: INVALID_INPUT`. An invalid mode is refused at creation: `"optionalArgs":[{"key":"a","flag":"--a","mode":"sometimes"}]` returns `HTTP 400` `INVALID_INPUT` at `config.optionalArgs.0.mode`.
- **Skill content preview (offline).** Run `CAP=$($S/af-api.sh "$P" GET '/api/capabilities?kind=skill' 2>/dev/null | jq -r '.capabilities[]|select(.exposedName=="release-checklist")|.id')`, then `$S/af-api.sh "$P" GET "/api/capabilities/$CAP/content" | jq -c .`. The output is `{"uri":"skill://release-checklist","mimeType":"text/markdown","content":"# Release checklist\n\n1. Run tests\n2. Tag"}`. A tool capability id returns `404` `NOT_FOUND` `Capability has no previewable skill content`. An unknown id returns `404` `CAPABILITY_NOT_FOUND`.
- **Skill repo URL validation (offline).** Run `$S/af-api.sh "$P" POST /api/sources '{"id":"verify-bad-repo","name":"Bad repo","kind":"skill_repo","config":{"kind":"skill_repo","url":"https://example.com/x/y"}}'`. The result is `HTTP 400` `INVALID_INPUT` `Unsupported host 'example.com': only github.com and raw.githubusercontent.com are allowed`.
- **Import a GitHub skill repo (needs GitHub HTTPS).** Run `$S/af-cli.sh "$P" skills add https://github.com/anthropics/skills --name "Verify GitHub Skills" --include pdf --tag verify`. It prints `Imported 1 skill(s) from Verify GitHub Skills (<uuid>, health: healthy)`. Then run `$S/af-mcp.sh "$P" default skills/list | jq -c '[.result.skills[]|{uri,files:(.resources|length)}]'`. It includes `{"uri":"skill://pdf","files":<n>}` with `n` > 1 (`SKILL.md` plus attached files).
- **Multi-file skill resources.** Run `CAP=$($S/af-api.sh "$P" GET '/api/capabilities?kind=skill' 2>/dev/null | jq -r '.capabilities[]|select(.exposedName=="pdf")|.id')` and `$S/af-api.sh "$P" GET "/api/capabilities/$CAP/content" | jq -c '{uri,files:(.files|keys)}'`, which lists attached paths such as `FORMS.md` and `scripts/….py`. Then run these reads:
  - `$S/af-mcp.sh "$P" default resources/read '{"uri":"skill://pdf/FORMS.md"}' | jq -c '.result.contents[0]|{uri,mimeType}'` returns `text/markdown`.
  - A `scripts/<name>.py` path returns `text/x-python`.
  - `skill://pdf/SKILL.md` returns the main markdown.
  - `{"uri":"skill://pdf/../../etc/passwd"}` fails with `-32023` `Skill file does not exist` (`CAPABILITY_NOT_FOUND`).
- **Proof.** Keep `$P/transcript/*-mcp-*` and note the profile used for each. For a UI second view, run `node $S/af-browser.mjs "$P" 'click:tab:Sources & Pool' 'expect-text:verify_echo' 'snap:pool'`. The Capability pool shows `verify_echo`, `release-checklist`, and `skill:release-checklist` with exposure `direct`.

## Gotchas

- JSON-RPC ids must be strings or safe integers. A nanosecond timestamp as a numeric id is rejected as `-32600 Invalid JSON-RPC request`. `af-mcp.sh` uses string ids.
- Requests are stateless at `2026-07-28`. `initialize` returns an `mcp-session-id`, but later calls work without it. A stale or foreign `Mcp-Session-Id` gets `404 Unknown MCP session`.
- New profiles get a UUID `id`. `/mcp/<name>` and `POST /api/tokens {"profileId":"<name>"}` both accept the name.
- A skill source yields two capabilities: the `skill` (`release-checklist`) and a prompt (`skill:release-checklist`). Neither appears in `tools/list`.
- `directToolBudget` demotes direct tools beyond the budget to `searchable`, so they disappear from `tools/list` but stay reachable via `fabric_search` and `fabric_call`.
- Hidden capabilities return `CAPABILITY_DENIED` (`-32024`), not "not found". Assert the code, not just an error.
- CLI wrappers run only in `local` mode. A `remote` launch answers `REMOTE_CLI_FORBIDDEN`. The echo fixture needs `/usr/bin/echo`.
- An `Origin` header that is not the gateway's own origin or loopback is refused with 403 `Invalid Origin`.
- `optionalArgs` are appended after `argsTemplate`, in spec order. `/usr/bin/echo` treats them as literal text only because the first argument is the message. A leading `-n` or `-e` would be read as an echo option.
- GitHub steps need outbound HTTPS to `api.github.com`, `codeload.github.com`, and `raw.githubusercontent.com`, and use the unauthenticated 60 requests/hour quota. Check `curl -s -m 5 https://api.github.com/rate_limit | jq .rate` first. Offline, run only the URL-validation and in-gateway preview steps and report the import steps as blocked. Use `--include` to keep imports small.
- A `skill_repo` source is fetched once at creation and on explicit refresh (`refreshPolicy: manual`). At startup it is fetched only when it has no cached capabilities. Upstream repo changes do not appear until you refresh.
- Very large repositories exceed the archive limit. The gateway then fetches a sparse tree at the configured `ref` (commit, branch, or tag), fails closed with `GitHub truncated the repository tree listing; set 'path' to a narrower skills directory` when GitHub truncates the listing, and skips symlinks and files that are not valid UTF-8. Live runs rarely hit this, so it is covered by `tests/core/github-skills.test.ts`. Set `path` or `--include` to stay on the archive path.
- Repo skill slugs share the `skill://` namespace with in-gateway skills. Pick `--include` slugs that no other source in the run already serves.
