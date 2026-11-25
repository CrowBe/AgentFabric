# Credential and call lifecycle hardening

The gateway rechecks a held tool call right before it runs, so access revoked or configuration changed while the call waited stops the call. Credentials die with what they belong to. Deleting a profile, or dropping it in a replace import, revokes its bearer tokens and its OAuth refresh tokens, and recreating a profile with the same name revives neither. Single-use links and codes fail closed. An auth-handoff ticket dies when its source changes and survives a rejected submission. A gateway OAuth authorization code survives a failed redemption and dies on success. Retargeting a source drops the capabilities it discovered at the old target.

## Sub-features

- `recheck-revoked` fails an approved call with `-32024` `Client access was revoked` (`FORBIDDEN`) when its client token was revoked while the call waited.
- `recheck-changed` fails an approved call with `-32024` `Capability or policy changed before execution` (`CAPABILITY_DENIED`) when its source changed while the call waited.
- `ticket-binding` expires an auth-handoff ticket (`Link expired`, `403`) as soon as its source is edited.
- `ticket-input-limits` rejects an empty or oversized (over 16 KiB) credential on `/auth/connect/<sourceId>` with `400` and keeps the ticket usable.
- `gateway-oauth-code` keeps an authorization code redeemable after a wrong `code_verifier`, and makes it single-use after the correct one.
- `profile-delete-revokes` revokes a deleted profile's client tokens and OAuth refresh tokens.
- `replace-import-revokes` revokes the tokens of profiles that `import --replace` drops.
- `retarget-clears` drops a source's discovered capabilities when its target (URL, command, arguments, repo ref, or folder root) changes.
- `on-connect-scope` refreshes `on_connect` sources only for profiles that can reach them (covered by `tests/core/runtime.test.ts`; nothing user-visible to drive).

## How to get to it (user POV)

- Harness: a gated `tools/call` (see [safety-approvals-and-proposals.md](./safety-approvals-and-proposals.md)), and the gateway OAuth flow at `/oauth/register`, `/oauth/authorize`, and `/oauth/token`.
- Operator: `DELETE /api/tokens/<id>`, `PATCH /api/sources/<id>`, `DELETE /api/profiles/<id>`, `agentfabric import <bundle> --replace`, and the console equivalents.
- Browser: the `/auth/connect/<sourceId>?ticket=af_ticket_…` link from a harness `AUTH_REQUIRED` error or `POST /api/sources/<id>/test`.

## Driving it with af-api.sh, af-mcp.sh, af-cli.sh, and curl

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- The **Echo tool** fixture from `README.md` is seeded, plus the gate `$S/af-api.sh "$P" POST /api/policies '{"name":"Gate verify echo","capabilityPattern":"verify_echo","action":"require_approval","reason":"verification gate"}'`.
- `. "$P/session.env"` for `$AF_URL` and `$AF_HOME`. Raw tokens, tickets, and codes go into files under `$P` and are deleted after use.

- **Revoked while waiting.** Mint a token: `$S/af-api.sh "$P" POST /api/tokens '{"label":"verify-revoke","profileId":"default"}' 2>/dev/null >"$P/.rt.json"`. The token id is `.record.id`. Start a gated call with it in the background: `(AF_MCP_TOKEN=$(jq -r .token "$P/.rt.json") AF_MAX_TIME=60 $S/af-mcp.sh "$P" default tools/call '{"name":"verify_echo","arguments":{"message":"after revoke"}}' >"$P/blocked-revoked.out" 2>&1 &)`. After the approval is `pending`, run `$S/af-api.sh "$P" DELETE "/api/tokens/$(jq -r .record.id "$P/.rt.json")"` (`HTTP 200`), then `$S/af-cli.sh "$P" approvals approve <id>`. The CLI prints `Approval <id> is now approved`, but `$P/blocked-revoked.out` holds `-32024` `Client access was revoked` with `data.code: FORBIDDEN`, and no echo output. Delete `$P/.rt.json`.
- **Changed while waiting.** Block another gated call with the cached default token (`$P/blocked-edited.out`). While it is pending, run `$S/af-api.sh "$P" PATCH /api/sources/verify-echo '{"name":"Verify Echo Edited"}'`, then approve. The call fails with `-32024` `Capability or policy changed before execution` (`CAPABILITY_DENIED`). A call made after the edit runs normally.
- **Ticket rejects bad input and survives.** Seed a secret-gated source: `$S/af-api.sh "$P" POST /api/sources '{"id":"verify-locked","name":"Verify Locked","kind":"mcp_http","config":{"kind":"mcp_http","url":"http://127.0.0.1:9/mcp"},"authConfig":{"kind":"bearer_secret","secretName":"verify_locked_key"},"refreshPolicy":{"mode":"manual"}}'` (`auth_required`). Take a link: `$S/af-api.sh "$P" POST /api/sources/verify-locked/test 2>/dev/null | jq -r .authHandoff.authUrl >"$P/.connect-url"` and `TICKET=$(sed 's/.*ticket=//' "$P/.connect-url")`. The page (`curl -s "$(cat "$P/.connect-url")"`) shows `<h1>Connect Verify Locked` with a field `secret_0` labeled `verify_locked_key`. Then post bad values:
  - `curl -s -w '%{http_code}' --data-urlencode "ticket=$TICKET" --data-urlencode "secret_0=" "$AF_URL/auth/connect/verify-locked"` returns `400` with `A value for verify_locked_key is required.`
  - A 16385-byte value (`head -c 16385 /dev/zero | tr '\0' x >"$P/.big"`, then `--data-urlencode "secret_0@$P/.big"`) returns `400` with `The value for verify_locked_key is too long.`

  The link still answers `200` afterwards.
- **Ticket dies with a source edit.** Run `$S/af-api.sh "$P" PATCH /api/sources/verify-locked '{"name":"Verify Locked Renamed"}'`. The same link now returns `403` `<h1>Link expired`, and posting a valid value with that ticket also returns `403` `Link expired`. `$S/af-api.sh "$P" GET /api/secrets` stays `{"secrets":[]}`. Delete `$P/.connect-url` and `$P/.big`.
- **Gateway OAuth code survives a wrong verifier.** Create `$S/af-api.sh "$P" POST /api/profiles '{"name":"verify-oauth-profile"}'`. Register a client: `CID=$(curl -s -X POST -H 'content-type: application/json' -d '{"client_name":"verify-harness","redirect_uris":["http://127.0.0.1:8976/callback"]}' "$AF_URL/oauth/register" | jq -r .client_id)`. Make a PKCE pair: `V=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64)` and `CH=$(printf '%s' "$V" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')`. Then set `Q="response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&code_challenge=$CH&code_challenge_method=S256&scope=mcp&state=verify-state&resource=$(jq -rn --arg u "$AF_URL/mcp/verify-oauth-profile" '$u|@uri')"`.
  - `curl -s "$AF_URL/oauth/authorize?$Q"` shows `<h1>Authorize connection`.
  - Approve as the operator: `curl -s -o /dev/null -w '%{redirect_url}' --data-urlencode decision=approve --data-urlencode "operator_token=$(cat "$AF_HOME/operator-token")" "$AF_URL/oauth/authorize?$Q" >"$P/.redirect"`. The answer is a `303` to `http://127.0.0.1:8976/callback?code=af_code_…&iss=…&state=verify-state`.
  - Redeem with `curl -s --data-urlencode grant_type=authorization_code --data-urlencode "client_id=$CID" --data-urlencode redirect_uri=http://127.0.0.1:8976/callback --data-urlencode "code=<code from .redirect>" --data-urlencode code_verifier=<verifier> "$AF_URL/oauth/token"`. A wrong 50-character verifier returns `400` `invalid_grant` `The credential is invalid, expired, or already used`. The correct `$V` then still returns `200` with `access_token`, `refresh_token`, `token_type: "Bearer"`, `expires_in: 3600`, and `scope: "mcp"`. Replaying the correct verifier returns `400` `invalid_grant`.

  Save the response to `$P/.tok.json`. Its `access_token` works: `AF_MCP_TOKEN=<access_token> $S/af-mcp.sh "$P" verify-oauth-profile tools/list` returns `HTTP 200`.
- **Profile delete revokes both kinds of token.** Run `$S/af-api.sh "$P" DELETE "/api/profiles/<verify-oauth-profile id>"`. Then `$S/af-db.sh "$P" state "select json_extract(payload,'\$.revokedAt') is not null as revoked from oauth_refresh_tokens where json_extract(payload,'\$.profileId')='<id>'"` prints `1`, and the same query on `client_tokens` (label `verify-harness`) prints `1`. Recreate the profile with the same name, then:
  - The refresh grant (`grant_type=refresh_token`, `client_id`, `refresh_token`) returns `400` `invalid_grant`.
  - The old access token gets `HTTP 401` `A valid bearer token is required` on `/mcp/verify-oauth-profile`.

  Delete `$P/.redirect` and `$P/.tok.json`.
- **Replace import revokes dropped profiles.** Run `$S/af-cli.sh "$P" export --out "$P/before-doomed.json"`. Create `{"name":"verify-doomed"}`, mint a token for it into `$P/.doomed-token`, and confirm `tools/list` on `/mcp/verify-doomed` returns `200`. Then run `$S/af-cli.sh "$P" import "$P/before-doomed.json" --replace` (`Imported <n> sources, <n> profiles, …`). `GET /api/tokens` shows `verify-doomed-token` with `revokedAt` set. The token gets `HTTP 401` before and after you recreate `verify-doomed`. Delete `$P/.doomed-token`.
- **Retarget drops stale capabilities.** On a connected OAuth source, or any `mcp_http` source with discovered tools, change only the URL path or query: `$S/af-api.sh "$P" PATCH /api/sources/<id> '{"config":{"kind":"mcp_http","url":"<same origin>/mcp?tenant=b"}}'`. `GET '/api/capabilities?profileId=default'` no longer lists that source's tools until the new target is discovered. For OAuth sources the connection resets too (see [upstream-oauth.md](./upstream-oauth.md)).
- **Proof.** Keep `blocked-revoked.out`, `blocked-edited.out`, the `af-db` transcripts, and the `/api/tokens` transcripts. Run `grep -rlE 'af_(ticket|code|refresh)_[A-Za-z0-9]{6}|af_tok_[A-Za-z0-9]{6}' "$P"`, which must print nothing.

## Gotchas

- `POST /api/tokens` and `agentfabric token create --json` return `{token, record:{id,…}}`. The id to revoke is `.record.id`, not `.id`.
- An approval-gated call records its approval as `approved` even when the recheck then refuses to run it. Assert on the call's result, not on the approval row.
- Any edit bumps the source revision, including a rename. A ticket handed out before the edit is spent, so take a fresh one with `POST /api/sources/<id>/test`.
- `/oauth/authorize` needs `scope=mcp`, `code_challenge_method=S256`, a 43-character challenge, and a redirect URI registered for the client. Loopback `http://127.0.0.1:<any port>` redirects match regardless of port.
- The token endpoint accepts only `application/x-www-form-urlencoded`, and duplicate parameters return `invalid_request`.
- The consent page answers `401` with `That operator token was not accepted.` for a wrong operator token, and `decision=deny` redirects with `error=access_denied`.
- `import --replace` also re-imports executable sources disabled, so `verify_echo` answers `-32023` `Capability is unavailable to this profile` afterwards. Run `$S/af-api.sh "$P" PATCH /api/sources/verify-echo '{"enabled":true}'` before any later journey that calls it.
- Deleting the `default` profile is refused. Use a throwaway profile for revocation checks.
- The rechecks that run inside the upstream concurrency queue, and `on_connect` scoping, are covered by `tests/core/runtime.test.ts` (`queued upstream calls`, `refreshes on_connect sources only for profiles that can reach them…`). The approval gate above is the user-reachable way to hold a call.
