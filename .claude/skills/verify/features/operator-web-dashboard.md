# Operator web dashboard and REST API

The operator signs in to the console at `/` with the operator token. The console then manages sources and the capability pool, profiles, client tokens, OAuth clients, and the write-only secret vault. Every console action goes through the operator REST API `/api/*`, which fails closed without the operator token.

## Sub-features

- `ui-token-gate` blocks the console behind the "Operator sign-in" dialog and rejects a wrong token.
- `ui-overview` shows gateway status, source health, and harness connect snippets per profile.
- `ui-sources-pool` lists sources with health and the capability pool with exposure, permission, and status.
- `ui-profiles` lists profiles and creates one through the `New profile` dialog.
- `ui-tokens` mints a scoped bearer token that is shown once.
- `ui-secrets` stores a secret whose value is never readable again.
- `api-fail-closed` returns 401 for `/api/*` without the operator token and rejects unknown fields with 400 `INVALID_INPUT`.

## How to get to it (user POV)

- Open the `Web UI` URL from the startup banner and paste the operator token from `<home>/operator-token`.
- Use the vertical tab list `Gateway sections`: `Overview & Connect`, `Sources & Pool`, `Skills & Folders`, `Profiles & Discovery`, `Safety & Approvals`, `Events`, `Auth & Secrets`, `Telemetry & Portability`. Hash routes are `#/overview`, `#/sources`, `#/skills`, `#/profiles`, `#/safety`, `#/events`, `#/auth`, `#/telemetry`.
- Call `/api/*` with `Authorization: Bearer <operator token>` (or `x-operator-token`).

## Driving it with af-browser.mjs

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`.
- The **Echo tool** fixture from `README.md` is seeded.
- Playwright and Chromium resolve (see `../SKILL.md` Drive).

- **Wrong token.** Submit a bad token. Run `node $S/af-browser.mjs "$P" --no-signin 'expect:dialog:Operator sign-in' 'fill:Operator token=afop_wrong' 'click:button:Sign in' 'expect-text:That operator token was not accepted.' 'snap:gate-rejected'`. The dialog stays open with the error notice.
- **Sign in and overview.** Sign in with the real token. Run `node $S/af-browser.mjs "$P" 'expect:heading:Overview' 'expect:region:Connect a harness' 'snap:overview'`. The tablist `Gateway sections` appears, the banner shows `local mode`, and the page title is `Overview & Connect · AgentFabric`.
- **Sources and pool.** Open the tab. Run `node $S/af-browser.mjs "$P" 'click:tab:Sources & Pool' 'expect:heading:Sources & Pool' 'expect-text:Verify Echo' 'snap:sources'`. The `Configured sources` table shows `Verify Echo` as `CLI wrapper` and `healthy`. `Capability pool` shows `verify_echo` as `direct` and `allow`.
- **Create a profile.** Run `node $S/af-browser.mjs "$P" 'goto:#/profiles' 'click:button:New profile' 'fill:Name (required)=verify-ui' 'click:button:Create profile' 'expect-text:verify-ui' 'snap:profiles'`. The profile list shows `verify-ui`. Second view: run `$S/af-api.sh "$P" GET /api/profiles | jq -r '.profiles[].name'`, which lists `verify-ui`.
- **Mint a token.** Run `node $S/af-browser.mjs "$P" 'goto:#/auth' 'expect:heading:Auth & Secrets' 'fill:Label (required)=verify ui token' 'click:button:Mint token' 'expect-text:Copy this token now. It is never shown again.' 'snap:token-minted'`. Second view: run `$S/af-api.sh "$P" GET /api/tokens | jq -c '[.tokens[]|{label,profileId}]'`, which includes `verify ui token`.
- **Store a secret.** Run `node $S/af-browser.mjs "$P" 'goto:#/auth' 'fill:Secret name (required)=verify_api_key' 'fill:Value (required)=sk-verify-SECRET-123' 'click:button:Store secret' 'expect-text:verify_api_key' 'snap:secret-stored'`. Second view: run `$S/af-api.sh "$P" GET /api/secrets`, which lists `verify_api_key` with no `value` field. `grep -r sk-verify-SECRET-123 "$P"` finds nothing.
- **API fails closed.** Run `AF_NOAUTH=1 $S/af-api.sh "$P" GET /api/status` (`HTTP 401`, `UNAUTHORIZED`). Then run `$S/af-api.sh "$P" POST /api/profiles '{"name":"x","bogus":true}'` (`HTTP 400`, `INVALID_INPUT` naming the unrecognized key).
- **Proof.** Keep `$P/browser/*.png`, `*.aria.txt`, `console.txt`, and the `/api` transcripts. `console.txt` should hold only the expected `401` from the wrong-token step.

## Gotchas

- The operator token field is a password input, so it has no `textbox` role. Use `fill:Operator token=…` (label), not a role.
- The token lives in `sessionStorage`. Each `af-browser.mjs` run is a fresh tab and signs in again. Pass `--no-signin` only to test the gate.
- Tab names and h1 headings differ for two views: tab `Overview & Connect` has h1 `Overview`, and tab `Skills & Folders` has h1 `Skills & Shared Folders`.
- The `Profile` select in `Scoped bearer tokens` defaults to the first listed profile, which is the newest one, not `default`. The helper has no select step, so assert the minted token's `profileId` through `GET /api/tokens` instead of assuming `default`.
- Secret values are write-only. Never assert a value round-trip. Assert the name and the absence of the value everywhere, including exports.
- Minted token values appear once in the UI and in `POST /api/tokens`. Transcripts mask `af_tok_…`, but screenshots do not. Treat `token-minted.png` as sensitive, even though the instance is disposable.
- Lists refresh on intervals (approvals SSE, 20–30 s polls elsewhere). After an API-side mutation, reload with `goto:` before asserting in the UI.
