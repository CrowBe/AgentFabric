# Safety, approvals, and proposals

The operator sets safety policies that apply across every harness. A `require_approval` policy holds a harness's tool call open until the operator approves or denies it live, in the console or the CLI. Agent-drafted capabilities submitted with `fabric_propose_capability` stay out of the pool until the operator activates them.

## Sub-features

- `policy-create` saves a `require_approval` policy that marks matching capabilities in the pool.
- `approval-block` holds a matching MCP `tools/call` open and records a `pending` approval.
- `approval-approve-ui` releases the blocked call from the `Safety & Approvals` console view.
- `approval-approve-cli` releases the blocked call with `agentfabric approvals approve`.
- `approval-deny` fails the blocked call with `APPROVAL_DENIED`.
- `proposal-submit` records an agent proposal as `pending_review` without adding a tool.
- `proposal-activate` adds the proposed tool to the pool only after operator activation (console or API).
- `proposal-reject` closes a proposal without adding a tool.

## How to get to it (user POV)

- Console: **Safety & Approvals** (`#/safety`). Its cards are `Pending approvals`, `Capability proposals`, `Safety policies`, and `Approval history`. The top bar shows `N pending approval(s)` while calls are blocked.
- CLI: `agentfabric approvals list --status pending`, `agentfabric approvals approve <id> [--note TEXT]`, `agentfabric approvals deny <id>`.
- API: `POST /api/policies`, `GET /api/approvals?status=pending`, `POST /api/approvals/<id>/decide`, `GET /api/proposals?status=pending_review`, `POST /api/proposals/<id>/activate|reject`.
- Harness: any `tools/call` that a policy matches. Proposals come from `tools/call fabric_propose_capability`.

## Driving it with af-mcp.sh, af-cli.sh, and af-browser.mjs

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- The **Echo tool** fixture from `README.md` is seeded.
- No other policy matches `verify_echo`.

- **Create the gate.** Run `$S/af-api.sh "$P" POST /api/policies '{"name":"Gate verify echo","capabilityPattern":"verify_echo","action":"require_approval","reason":"verification gate"}'`. The result is `HTTP 201` with `"action":"require_approval","enabled":true`. Second view: `$S/af-api.sh "$P" GET '/api/capabilities?profileId=default' | jq -c '.capabilities[]|select(.exposedName=="verify_echo")|.permission'` prints `"require_approval"`.
- **Block a harness call.** Start the call in the background. Run `(AF_MAX_TIME=90 $S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"approved in browser"}}' >"$P/blocked-call.out" 2>&1 &)`, then wait about 1 s. `$S/af-cli.sh "$P" approvals list --status pending` shows one row with `pending  default  verify_echo  Operator approval is required by profile policy`. `$P/blocked-call.out` is still empty.
- **Approve in the console.** Run `node $S/af-browser.mjs "$P" 'goto:#/safety' 'expect:heading:Safety & Approvals' 'expect:article:Approval for verify_echo' 'snap:approval-pending' 'click:button:Approve verify_echo' 'expect-text:Nothing is waiting for approval.' 'snap:approval-cleared'`. Within a second, `$P/blocked-call.out` holds `"text":"approved in browser\n"` and `HTTP 200`.
- **Approve from the CLI.** Block another call (same command, output to `$P/blocked-call-2.out`). Run `ID=$($S/af-api.sh "$P" GET '/api/approvals?status=pending' 2>/dev/null | jq -r '.approvals[0].id')` and `$S/af-cli.sh "$P" approvals approve "$ID" --note verified`. The CLI prints `Approval <id> is now approved`, and `$P/blocked-call-2.out` holds the echo result.
- **Deny.** Block a third call (`$P/blocked-call-3.out`), then run `$S/af-cli.sh "$P" approvals deny "$ID"` with the new id. The blocked call returns JSON-RPC error `data.code: APPROVAL_DENIED` with `approval.status: "denied"` and an `approvalUrl` ending in `#/safety?approval=<id>`.
- **Approval durability.** Run `$S/af-db.sh "$P" state "select id, status from approvals"`. It shows two `approved` rows and one `denied` row.
- **Submit a proposal.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_propose_capability","arguments":{"name":"verify_uname","description":"Print kernel name","definition":{"kind":"cli_wrapper","toolName":"verify_uname","description":"Print the kernel name","command":"/usr/bin/uname","argsTemplate":["-s"],"inputSchema":{"type":"object","properties":{}}}}}' | jq -c '.result.structuredContent|{status,kind}'`. Output is `{"status":"pending_review","kind":"cli_wrapper"}`. `tools/list` still lacks `verify_uname`.
- **Activate in the console.** Run `node $S/af-browser.mjs "$P" 'goto:#/safety' 'click:button:Inspect verify_uname' 'click:button:Activate…' 'click:button:Activate' 'expect-text:Activated verify_uname' 'snap:proposal-activated'`. Then `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_uname","arguments":{}}' | jq -c .result.content` returns `[{"type":"text","text":"Linux\n"}]`, and `tools/list` now includes `verify_uname`.
- **Reject.** Submit a second proposal named `verify_date` (`/usr/bin/date`, `argsTemplate` `["-u"]`). Run `PID=$($S/af-api.sh "$P" GET '/api/proposals?status=pending_review' 2>/dev/null | jq -r '.proposals[0].id')` and `$S/af-api.sh "$P" POST "/api/proposals/$PID/reject" '{"note":"not needed"}'`. The proposal status is `rejected`, and `tools/list` never shows `verify_date`.
- **Proof.** Keep `approval-pending.png` (shows `Approval for verify_echo` with redacted arguments), `approval-cleared.png`, `proposal-activated.png`, the `blocked-call*.out` files, and the transcripts.

## Gotchas

- A gated `tools/call` blocks the HTTP request until a decision or the approval timeout (120 s by default, which then fails as `APPROVAL_TIMEOUT`). Always background it with `AF_MAX_TIME` above the time you need, or the helper's curl gives up first and the approval expires as "Caller disconnected".
- Wait for the `pending` row before deciding. Deciding an already-decided approval returns `409 CONFLICT`.
- Policy patterns match the capability id, original name, or exposed name with `*` and `?` globs. `verify_echo` matches exactly. `*echo*` also gates every echo-like tool.
- The `Approve` and `Deny` buttons have accessible names `Approve <tool>` and `Deny <tool>`, not the visible text alone.
- Proposal activation in the console asks twice: `Activate…` in the inspect dialog, then `Activate` in the confirm dialog.
- An activated proposal becomes a source with id `proposal-<proposal id>`. Delete that source to undo it. Re-activating the same proposal returns `409`.
- Proposals that embed a stored secret value are refused (`ensureSecretFree`), and more than 50 pending proposals return `409`.
