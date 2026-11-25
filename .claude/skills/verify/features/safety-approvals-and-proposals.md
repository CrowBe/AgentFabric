# Safety, approvals, and proposals

The operator sets safety policies that apply across every harness. A `require_approval` policy holds a harness's tool call open until the operator approves or denies it live, in the console or the CLI. Agent-drafted capabilities submitted with `fabric_propose_capability` (CLI wrappers, composite tools, skills, and GitHub skill repos) stay out of the pool until the operator activates them in the console, the API, or the CLI.

## Sub-features

- `policy-create` saves a `require_approval` policy that marks matching capabilities in the pool.
- `approval-block` holds a matching MCP `tools/call` open and records a `pending` approval.
- `approval-approve-ui` releases the blocked call from the `Safety & Approvals` console view.
- `approval-approve-cli` releases the blocked call with `agentfabric approvals approve`.
- `approval-deny` fails the blocked call with `APPROVAL_DENIED`.
- `approval-deep-link` opens **Safety & Approvals** (not Overview) from the `approvalUrl` `#/safety?approval=<id>` that a blocked or denied call reports.
- `approval-recheck` refuses to run an approved call whose token was revoked or whose source changed while it waited (see [security-lifecycle.md](./security-lifecycle.md)).
- `proposal-submit` records an agent proposal as `pending_review` without adding a tool.
- `proposal-activate` adds the proposed tool to the pool only after operator activation (console or API).
- `proposal-reject` closes a proposal without adding a tool.
- `proposal-skill-repo` records a `skill_repo` (or `skill`) proposal as `pending_review` after validating its GitHub URL, and returns a `reviewUrl` to `#/safety`. The skills appear in `skills/list` only after activation.
- `proposal-cli` lists, activates, and rejects proposals with `agentfabric proposals list|activate|reject`.

## How to get to it (user POV)

- Console: **Safety & Approvals** (`#/safety`). Its cards are `Pending approvals`, `Capability proposals`, `Safety policies`, and `Approval history`. The top bar shows `N pending approval(s)` while calls are blocked.
- CLI: `agentfabric approvals list --status pending`, `agentfabric approvals approve <id> [--note TEXT]`, `agentfabric approvals deny <id>`, `agentfabric proposals list [--status pending_review|activated|rejected]`, `agentfabric proposals activate <id> [--note TEXT]`, `agentfabric proposals reject <id> [--note TEXT]`.
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
- **Deep link from the approval URL.** Block another call (`$P/blocked-deeplink.out`) and take its id with `AID=$($S/af-api.sh "$P" GET '/api/approvals?status=pending' 2>/dev/null | jq -r '.approvals[0].id')`. Run `node $S/af-browser.mjs "$P" "goto:#/safety?approval=$AID" 'expect:heading:Safety & Approvals' 'expect:article:Approval for verify_echo' 'snap:safety-deeplink' 'click:button:Approve verify_echo' 'expect-text:Nothing is waiting for approval.'`. `safety-deeplink.aria.txt` starts with `# <AF_URL>/#/safety?approval=<id>` and `# title: Safety & Approvals · AgentFabric`. The blocked call then returns `deep link`.
- **Approve from the CLI.** Block another call (same command, output to `$P/blocked-call-2.out`). Run `ID=$($S/af-api.sh "$P" GET '/api/approvals?status=pending' 2>/dev/null | jq -r '.approvals[0].id')` and `$S/af-cli.sh "$P" approvals approve "$ID" --note verified`. The CLI prints `Approval <id> is now approved`, and `$P/blocked-call-2.out` holds the echo result.
- **Deny.** Block a third call (`$P/blocked-call-3.out`), then run `$S/af-cli.sh "$P" approvals deny "$ID"` with the new id. The blocked call returns JSON-RPC error `data.code: APPROVAL_DENIED` with `approval.status: "denied"` and an `approvalUrl` ending in `#/safety?approval=<id>`.
- **Approval durability.** Run `$S/af-db.sh "$P" state "select id, status from approvals"`. It shows two `approved` rows and one `denied` row.
- **Submit a proposal.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_propose_capability","arguments":{"name":"verify_uname","description":"Print kernel name","definition":{"kind":"cli_wrapper","toolName":"verify_uname","description":"Print the kernel name","command":"/usr/bin/uname","argsTemplate":["-s"],"inputSchema":{"type":"object","properties":{}}}}}' | jq -c '.result.structuredContent|{status,kind}'`. Output is `{"status":"pending_review","kind":"cli_wrapper"}`. `tools/list` still lacks `verify_uname`.
- **Activate in the console.** Run `node $S/af-browser.mjs "$P" 'goto:#/safety' 'click:button:Inspect verify_uname' 'click:button:Activate…' 'click:button:Activate' 'expect-text:Activated verify_uname' 'snap:proposal-activated'`. Then `$S/af-mcp.sh "$P" default tools/call '{"name":"verify_uname","arguments":{}}' | jq -c .result.content` returns `[{"type":"text","text":"Linux\n"}]`, and `tools/list` now includes `verify_uname`.
- **Reject.** Submit a second proposal named `verify_date` (`/usr/bin/date`, `argsTemplate` `["-u"]`). Run `PID=$($S/af-api.sh "$P" GET '/api/proposals?status=pending_review' 2>/dev/null | jq -r '.proposals[0].id')` and `$S/af-api.sh "$P" POST "/api/proposals/$PID/reject" '{"note":"not needed"}'`. The proposal status is `rejected`, and `tools/list` never shows `verify_date`.
- **Propose a GitHub skill repo.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_propose_capability","arguments":{"kind":"skill_repo","name":"verify-xlsx-skill","description":"Spreadsheet skill from a public repo","definition":{"kind":"skill_repo","url":"https://github.com/anthropics/skills","includeSkills":["xlsx"]}}}' | jq -c '.result.structuredContent|{status,kind,reviewUrl}'`. The output is `{"status":"pending_review","kind":"skill_repo","reviewUrl":"<AF_URL>/#/safety"}`. Submitting only checks the URL, so this step works offline. `skills/list` does not yet include `skill://xlsx`.
- **Propose an in-gateway skill.** Run `$S/af-mcp.sh "$P" default tools/call '{"name":"fabric_propose_capability","arguments":{"kind":"skill","name":"verify-notes-skill","description":"Draft skill","definition":{"kind":"skill","slug":"verify-notes","title":"Verify notes","description":"Notes skill","content":"# Notes"}}}' | jq -c '.result.structuredContent|{status,kind}'`. The output is `{"status":"pending_review","kind":"skill"}`.
- **Bad repo proposals are refused.** Propose `"definition":{"kind":"skill_repo","url":"https://gitlab.com/a/b"}`. The call fails with `-32602` `Unsupported host 'gitlab.com': only github.com and raw.githubusercontent.com are allowed`, and nothing is recorded.
- **Review queue in the console.** Run `node $S/af-browser.mjs "$P" 'goto:#/safety' 'expect-text:Agents can propose CLI wrappers, composite tools, skills, or GitHub skill repos.' 'expect:button:Inspect verify-xlsx-skill' 'expect:button:Inspect verify-notes-skill' 'snap:proposals-pending'`.
- **List from the CLI.** Run `$S/af-cli.sh "$P" proposals list --status pending_review`. The table has columns `ID KIND NAME STATUS PROFILE` with rows `skill_repo verify-xlsx-skill pending_review default` and `skill verify-notes-skill pending_review default`. `--json` gives `{"proposals":[…]}`.
- **Activate from the CLI (repo activation needs GitHub HTTPS).** Run `PID=$($S/af-cli.sh "$P" proposals list --status pending_review --json | jq -r '.proposals[]|select(.name=="verify-xlsx-skill")|.id')` and `$S/af-cli.sh "$P" proposals activate "$PID" --note verified`. It prints `Proposal <id> is now activated (source proposal-<id>)`. `$S/af-mcp.sh "$P" default skills/list | jq -c '[.result.skills[].uri]'` now includes `skill://xlsx`. Offline, activate a `cli_wrapper` proposal (for example `verify_uname` above) the same way instead.
- **Reject from the CLI.** Run `PID=$($S/af-cli.sh "$P" proposals list --status pending_review --json | jq -r '.proposals[]|select(.name=="verify-notes-skill")|.id')` and `$S/af-cli.sh "$P" proposals reject "$PID" --note "not needed"` (`Proposal <id> is now rejected`). Rejecting it again exits `1` with `409 CONFLICT: Proposal has already been reviewed`. `$S/af-cli.sh "$P" proposals activate` with no id exits `1` with `Usage: agentfabric proposals activate ID [--note TEXT]`. Second view: `$S/af-db.sh "$P" state "select json_extract(payload,'\$.name'), json_extract(payload,'\$.status') from proposals"` shows each `activated` or `rejected` status.
- **Proof.** Keep `approval-pending.png` (shows `Approval for verify_echo` with redacted arguments), `approval-cleared.png`, `proposal-activated.png`, the `blocked-call*.out` files, and the transcripts.

## Gotchas

- A gated `tools/call` blocks the HTTP request until a decision or the approval timeout (120 s by default, which then fails as `APPROVAL_TIMEOUT`). Always background it with `AF_MAX_TIME` above the time you need, or the helper's curl gives up first and the approval expires as "Caller disconnected".
- Wait for the `pending` row before deciding. Deciding an already-decided approval returns `409 CONFLICT`.
- Policy patterns match the capability id, original name, or exposed name with `*` and `?` globs. `verify_echo` matches exactly. `*echo*` also gates every echo-like tool.
- The `Approve` and `Deny` buttons have accessible names `Approve <tool>` and `Deny <tool>`, not the visible text alone.
- The console routes on the hash path before `?`, so `#/safety?approval=<id>` and `#/safety` open the same view. An unknown hash path falls back to Overview.
- Proposal activation in the console asks twice: `Activate…` in the inspect dialog, then `Activate` in the confirm dialog.
- An activated proposal becomes a source with id `proposal-<proposal id>`. Delete that source to undo it. Re-activating the same proposal returns `409`.
- Proposals that embed a stored secret value are refused, and more than 50 pending proposals return `409`.
- Pick proposal ids from `proposals list --json` by `name`. The table order is not a contract.
- Activating a `skill_repo` proposal fetches the repository right away, so activation needs GitHub reachability. Submitting only checks the URL.
