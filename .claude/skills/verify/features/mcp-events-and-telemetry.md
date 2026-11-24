# MCP events and telemetry

Harnesses discover and consume gateway events over the `io.modelcontextprotocol/events` extension: list, cursor-based poll, and SSE push. The operator watches and test-emits events in the console and CLI. Every MCP call is recorded as a deterministic trace (status, latency, profile, source, capability) in DuckDB. The operator reads traces as summaries, recent traces, and curation hints.

## Sub-features

- `events-list` advertises the five gateway event types over `events/list`.
- `events-poll` returns occurrences after a cursor over `events/poll`.
- `events-push` streams `notifications/events/event` over SSE from `events/stream`.
- `events-emit` lets the operator emit a known event type (CLI, API, or the console `Test emit` card).
- `events-log` lists occurrences in the CLI and in the console `Occurrence log`.
- `telemetry-traces` records each MCP call with a status such as `ok` or `validation_error`.
- `telemetry-summary` reports totals, error rate, and per-capability breakdowns in `/api/telemetry/summary` and the console.

## How to get to it (user POV)

- Harness: JSON-RPC `events/list`, `events/poll`, `events/stream`, and `events/subscribe` on `/mcp/<profile>`.
- Console: **Events** (`#/events`) with cards `Event types`, `Active subscriptions`, `Occurrence log`, and `Test emit`. **Telemetry & Portability** (`#/telemetry`) with cards `Deterministic telemetry`, `Curation hints`, and `Recent traces`.
- CLI: `agentfabric events list [--name N] [--after CURSOR] [--limit N]` and `agentfabric events emit NAME --data JSON [--source ID]`.
- API: `GET /api/events/types|subscriptions|occurrences`, `POST /api/events/emit`, `GET /api/telemetry/summary|events|hints`.

## Driving it with af-mcp.sh and af-cli.sh

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- The **Echo tool** fixture from `README.md` is seeded.

- **List types.** Run `$S/af-mcp.sh "$P" default events/list | jq -c '[.result.events[].name]'`. Output is `["fabric.approval.decided","fabric.approval.requested","fabric.catalog.changed","fabric.proposal.created","fabric.source.health_changed"]`.
- **Take a cursor.** Run `C=$($S/af-mcp.sh "$P" default events/poll '{"name":"fabric.approval.requested"}' 2>/dev/null | jq -r .result.cursor)`. A first poll without a cursor returns no events and the current head cursor.
- **Push stream.** Open a stream in the background. Run `(AF_MAX_TIME=8 $S/af-mcp.sh "$P" default events/stream '{"name":"fabric.approval.requested"}' >"$P/stream.sse" 2>/dev/null &)` and wait about 1.5 s. Then emit. Run `$S/af-cli.sh "$P" events emit fabric.approval.requested --data '{"id":"manual","status":"pending"}'`. The CLI prints `Emitted fabric.approval.requested (event <uuid>, cursor <n>)`. After the stream ends, `$P/stream.sse` holds `notifications/events/active`, then `notifications/events/event` with `"data":{"id":"manual","status":"pending"}`.
- **Poll after the cursor.** Run `$S/af-mcp.sh "$P" default events/poll "{\"name\":\"fabric.approval.requested\",\"cursor\":\"$C\"}" | jq -c '.result|{n:(.events|length),cursor,nextPollMs}'`. `n` is at least 1, and the new cursor is higher than `$C`.
- **Event log.** Run `$S/af-cli.sh "$P" events list --name fabric.approval.requested`. The table shows the occurrence with source `gateway`. Console second view: `node $S/af-browser.mjs "$P" 'goto:#/events' 'expect:heading:Events' 'expect-text:fabric.approval.requested' 'snap:events'`.
- **Unknown type is refused.** Run `$S/af-cli.sh "$P" events emit verify.ping --data '{}'`. Exit `1` with `404 NOT_FOUND: Unknown event type`.
- **Generate traces.** Make one good and one invalid call: `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"trace me"}}'` and `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"x","extra":1}}'`.
- **Read telemetry.** Run `$S/af-api.sh "$P" GET /api/telemetry/summary | jq -c '{totalCalls,errorCount,errorRate}'` (`errorCount` ≥ 1) and `$S/af-api.sh "$P" GET '/api/telemetry/events?limit=5' | jq -c '.events[]|{toolName,status}'` (shows `verify_echo` with `ok` and `validation_error`).
- **Trace durability.** Run `$S/af-db.sh "$P" traces "select status, count(*) as n from traces group by status order by status"`. It shows `ok` and `validation_error` counts that match the summary.
- **Proof.** Run `node $S/af-browser.mjs "$P" 'goto:#/telemetry' 'expect:heading:Telemetry & Portability' 'expect:region:Recent traces' 'snap:telemetry'`. Keep it with `stream.sse` and the transcripts.

## Gotchas

- Only the five `fabric.*` types (plus upstream-advertised ones) can be emitted. Arbitrary names return `404 Unknown event type`.
- A poll with no cursor starts at the head and returns nothing old. Take the cursor before the action you want to observe, or pass `maxAgeMs`.
- `events/stream` never ends by itself. `af-mcp.sh` ends it at `AF_MAX_TIME`, and curl prints `Operation timed out` (exit 28). That is expected, and the helper still reports `HTTP 200`.
- `events/subscribe` defaults to webhook delivery and needs a reachable callback URL. The seed journey does not cover webhooks.
- `af-db.sh traces` reads a copy because the live gateway holds the DuckDB lock. If DuckDB fails to open at launch, the gateway logs `DuckDB trace store unavailable` and falls back to in-memory traces. Check `gateway.log` before you trust trace durability.
- Telemetry summaries count `fabric_*` built-in calls too, so totals are higher than the number of upstream calls you made.
- Trace statuses are normalized codes. Besides `ok` and `validation_error`, expect `approval_denied`, `approval_timeout`, `forbidden` (a capability hidden by a profile), `not_found`, and `auth_required` after the other journeys. Assert that the `af-db.sh traces` counts sum to `/api/telemetry/summary` `totalCalls`.
