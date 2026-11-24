# MCP gateway and unified pool

A harness points at one endpoint, `/mcp/<profile>`, with a bearer token. It then sees the pooled tools, prompts, resources, and agent skills for that profile, plus the built-in discovery tools `fabric_search`, `fabric_inspect`, `fabric_call`, and `fabric_propose_capability`. Unauthenticated, foreign-profile, and malformed requests fail closed with truthful codes.

## Sub-features

- `mcp-auth` rejects missing bearer tokens (401 + `WWW-Authenticate`) and tokens minted for another profile (403 `FORBIDDEN`).
- `mcp-oauth-discovery` publishes protected-resource metadata that points harnesses at the gateway's OAuth server.
- `mcp-initialize` negotiates protocol `2026-07-28` and advertises tools, prompts, resources, events, and the skills extension.
- `mcp-tools` lists built-ins plus direct pool tools and calls an upstream tool.
- `mcp-strict-args` rejects unexpected tool arguments with JSON-RPC `-32602`.
- `mcp-discovery` finds, inspects, and calls capabilities through `fabric_search`, `fabric_inspect`, and `fabric_call`.
- `mcp-prompts` lists and renders a skill-backed prompt.
- `mcp-resources-skills` lists resources, reads `skill://` content, and lists skills over `skills/list`.
- `mcp-profile-scope` hides capabilities a profile's rules hide, and denies calling them.
- `mcp-unknown-method` answers `-32601 Method not found`.

## How to get to it (user POV)

- Mint a token in the console (**Overview & Connect** → `Mint token`, or **Auth & Secrets** → `Scoped bearer tokens`), then paste the snippet into a harness.
- Run `agentfabric token create --profile <name>` and configure the harness with `<url>/mcp/<name>`.
- Remote harnesses (Claude on the web) discover OAuth via `/.well-known/oauth-protected-resource/mcp/<profile>`.

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
