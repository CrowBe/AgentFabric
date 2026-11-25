# MCP elicitation pass-through

When a pooled remote MCP server asks its caller a question (`elicitation/create` in `form` or `url` mode), the gateway relays it to the harness that made the `tools/call`. The plain JSON reply upgrades to an SSE stream only when the first elicitation arrives. The harness answers with a JSON-RPC response on the same session. The gateway validates accepted `form` content against the `requestedSchema` before the upstream sees it, relays `notifications/elicitation/complete` for `url` mode, declines unsafe URLs and callers that cannot answer, and binds every pending elicitation to the session and principal that owns it.

## Sub-features

- `elicit-form` relays a `form` elicitation over a lazily upgraded SSE stream and returns the caller's `accept`, `decline`, or `cancel` to the upstream.
- `elicit-schema` rejects accepted content that does not match `requestedSchema` with `400` and JSON-RPC `-32602`, and keeps the elicitation open for a corrected answer.
- `elicit-url` relays a `url` elicitation and then `notifications/elicitation/complete` to a caller that declared `elicitation.url`.
- `elicit-unsafe-url` declines `javascript:`, `file:`, `data:`, and credential-bearing URLs before they reach the caller.
- `elicit-decline` declines for callers with no session, no `elicitation` capability, a `form`-only capability on a `url` request, or the stateless `2026-07-28` protocol, and keeps their replies plain JSON.
- `elicit-binding` answers `404` `Unknown elicitation request` to another session of the same principal, a request without the session, and a replay. Another principal presenting the owner's session gets `404` `Unknown MCP session`.
- `elicit-cancel` turns a JSON-RPC error answer, `notifications/cancelled`, or a caller disconnect into `cancel` for the upstream.

## How to get to it (user POV)

- Harness: `initialize` with `protocolVersion` `2025-11-25` and `capabilities.elicitation` (`{}` means form only, `{"form":{},"url":{}}` means both). Then call a pooled tool with `Accept: application/json, text/event-stream` and the `Mcp-Session-Id` from `initialize`. Answer each `elicitation/create` by POSTing `{"jsonrpc":"2.0","id":"<elicitation id>","result":{"action":…}}` to `/mcp/<profile>` with the same session.
- Operator: add the remote MCP server as an `mcp_http` source (console `Add source` or `POST /api/sources`).

## Driving it with af-elicit-upstream.mjs and af-mcp.sh

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- `node $S/af-elicit-upstream.mjs "$P"` starts. It is a loopback stand-in for the external MCP server only, built on the repository's `@modelcontextprotocol/server` SDK (needs `npm ci`). The gateway's MCP client, SSE upgrade, session binding, and validation are the real code.
- Every `af-mcp.sh` call in this journey runs with `AF_MCP_VERSION=2025-11-25`. The default `2026-07-28` is stateless and always declines.

- **Start the upstream.** Run `E=$(node $S/af-elicit-upstream.mjs "$P"); echo "$E"`. It prints `http://127.0.0.1:<port>/mcp` and writes `$P/elicit-upstream.env`. Read it back in later calls with `. "$P/elicit-upstream.env"; E=$ELICIT_UPSTREAM_URL/mcp`.
- **Pool it.** Run `$S/af-api.sh "$P" POST /api/sources "{\"id\":\"verify-elicit\",\"name\":\"Verify Elicit\",\"kind\":\"mcp_http\",\"config\":{\"kind\":\"mcp_http\",\"url\":\"$E\"}}" | jq -c '.source|{id,health}'`. The result is `{"id":"verify-elicit","health":"healthy"}`, and `tools/list` adds `ask` and `plain`.
- **Open an elicitation-capable session.** Run `export AF_MCP_VERSION=2025-11-25`, then `$S/af-mcp.sh "$P" default initialize '{"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"verify-elicit","version":"1"}}'`. Save the session: `grep -i '^< mcp-session-id' "$(ls -t "$P"/transcript/*initialize* | head -1)" | awk '{print $3}' >"$P/.elicit-session"`.
- **Form elicitation.** Start the call in the background with a live stream file: `(AF_MCP_SESSION=$(cat "$P/.elicit-session") AF_MAX_TIME=60 AF_MCP_STREAM="$P/elicit-form.sse" $S/af-mcp.sh "$P" default tools/call '{"name":"ask","arguments":{"mode":"form","message":"Name?"}}' >"$P/elicit-form.out" 2>&1 &)`. After about 1.5 s, `$P/elicit-form.sse` holds one `data:` line with `"method":"elicitation/create"`, an id `elicitation-<uuid>`, `"mode":"form"`, and the `requestedSchema` `{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}`. Take the id: `EID=$(sed -n 's/^data: //p' "$P/elicit-form.sse" | jq -r 'select(.method=="elicitation/create")|.id')`.
- **Schema mismatch keeps it open.** Run `AF_MCP_SESSION=$(cat "$P/.elicit-session") $S/af-mcp.sh "$P" default --respond "{\"id\":\"$EID\",\"result\":{\"action\":\"accept\",\"content\":{\"name\":42}}}"`. The result is `HTTP 400` with `-32602` `Elicitation content does not match the requested schema`. `{"name":"Ada","role":"admin"}` gets the same answer. `curl -s "$ELICIT_UPSTREAM_URL/control/answers"` still prints `{"answers":[]}`.
- **Foreign answers are refused.** With the same `$EID`:
  - No `AF_MCP_SESSION` returns `HTTP 404` `-32023` `Unknown elicitation request`.
  - A second session of the same token (another `initialize`, then `AF_MCP_SESSION=<that id>`) returns the same `404`.
  - Another principal on the owner's session (`AF_MCP_TOKEN=<token minted with POST /api/tokens> AF_MCP_SESSION=$(cat "$P/.elicit-session")`) returns `HTTP 404` `Unknown MCP session`.

  `control/answers` is still empty.
- **Accept.** Run `AF_MCP_SESSION=$(cat "$P/.elicit-session") $S/af-mcp.sh "$P" default --respond "{\"id\":\"$EID\",\"result\":{\"action\":\"accept\",\"content\":{\"name\":\"Ada\"}}}"` (`HTTP 202`, empty body). The stream then ends with the `tools/call` result `{"action":"accept","content":{"name":"Ada"}}`. The call's transcript shows `content-type: text/event-stream`. Replaying the same answer returns `404` `Unknown elicitation request`, and `control/answers` holds exactly one answer.
- **URL elicitation and completion.** Start `ask` with `{"mode":"url","message":"Verify in browser","url":"https://auth.example.com/verify?step=1"}` the same way, with `AF_MCP_STREAM="$P/elicit-url.sse"`. The request carries `"mode":"url"`, `"elicitationId":"verify-url-1"`, and the URL. Answer `{"action":"accept"}`. `$P/elicit-url.sse` then holds `notifications/elicitation/complete` with `{"elicitationId":"verify-url-1"}` before the final result `{"action":"accept"}`.
- **Unsafe URLs are declined.** Call `ask` in `url` mode on the capable session with `javascript:alert(1)`, `file:///etc/passwd`, and `https://user:pass@evil.example`. Each returns plain JSON `HTTP 200` with `{"action":"decline"}`, and nothing reaches the stream.
- **Callers that cannot answer.** These each return plain JSON `{"action":"decline"}` with no stream:
  - A call with no session.
  - A call with `AF_MCP_VERSION=2026-07-28`.
  - A call on a session initialized with `"capabilities":{}`.

  On the capable session, `plain` returns `[{"type":"text","text":"plain"}]` with `content-type: application/json`, so the reply upgrades only when an elicitation actually arrives.
- **Error answer cancels.** Start another `form` call, then answer `--respond "{\"id\":\"$EID\",\"error\":{\"code\":-32603,\"message\":\"UI crashed\"}}"` (`HTTP 202`). The final result is `{"action":"cancel"}`.
- **Proof.** Keep `elicit-*.sse`, `elicit-*.out`, `elicit-upstream.log` (actions only), and the `*-mcp-default---respond*` transcripts. `control/answers` lists the upstream's answers in order. Delete `$P/.elicit-session`.

## Gotchas

- `af-mcp.sh` defaults to `MCP-Protocol-Version: 2026-07-28`, which is stateless, so every elicitation declines. Export `AF_MCP_VERSION=2025-11-25` for the whole journey, including the `--respond` calls.
- The helper's stdout file gets the body only when the call ends. Read a pending `elicitation/create` from the `AF_MCP_STREAM` file, which fills as the stream arrives and is redacted when the call ends.
- `capabilities.elicitation: {}` means form only. A `url` request to that session is declined. Declare `{"form":{},"url":{}}` for both modes.
- Answers go to the same `/mcp/<profile>` with the owning `Mcp-Session-Id` and token. The JSON-RPC `id` is the gateway's `elicitation-<uuid>`, not the upstream's id and not the `tools/call` id.
- A pending elicitation pauses the upstream call deadline and expires after 10 minutes as `cancel`. Background the call with `AF_MAX_TIME` above the time you need. A curl timeout counts as a caller disconnect and cancels it.
- Vault secret values inside an upstream's elicitation message are redacted to `[REDACTED]` before the caller sees them. `tests/core/elicitation.test.ts` covers this, `notifications/cancelled`, disconnects, and the 2026-era `input_required` upstream style.
- One `af-elicit-upstream.mjs` per proof dir. `af-cleanup.sh` stops it, and it exits by itself after `--ttl` (900 s).
