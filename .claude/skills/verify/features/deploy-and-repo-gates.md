# Cloudflare Workers deploy, static UI hardening, and repository gates

The same gateway ships as a Cloudflare Worker (`wrangler.jsonc`, `dist/deploy/cloudflare.js`). The Worker refuses to start without its operator token, a durable D1 binding (unless explicitly ephemeral), and, once D1 is bound, an `AGENTFABRIC_MASTER_KEY` that encrypts the D1 secret vault. It answers `503` before booting instead of storing secrets in plaintext or in memory. `run_worker_first` routes every request through the Worker, so console assets carry a strict CSP. The Node server serves the console with the same CSP and never serves files outside its static root. The repository gates keep `src/`, `web/src/`, and `tests/` comment-free and keep documentation to the root files.

## Sub-features

- `worker-fail-closed` answers `503` `INTERNAL_ERROR` before boot without `AGENTFABRIC_OPERATOR_TOKEN`, without `DB` (unless `AGENTFABRIC_ALLOW_EPHEMERAL=1`), and with `DB` but an empty or blank `AGENTFABRIC_MASTER_KEY`.
- `worker-run-first` keeps `"run_worker_first": true` on the `ASSETS` binding, and the Worker adds `content-security-policy` and `x-frame-options: DENY` to console assets and the SPA fallback.
- `d1-secrets` stores each secret as versioned, name-bound AES-GCM ciphertext in D1 and fails closed on a wrong key or tampered rows (covered by `tests/core/d1-secrets.test.ts`).
- `ui-csp` serves `/`, `/index.html`, and client routes such as `/sources` with `content-security-policy`, `referrer-policy: no-referrer`, and `x-content-type-options: nosniff`.
- `static-confined` answers traversal attempts with the console shell or `404`, never with a file outside the static root. Symlinks that escape the root are refused (covered by `tests/server/app.test.ts`).
- `github-sparse` falls back to a sparse Git Trees fetch at the configured commit, branch, or tag `ref` when a repository archive is too large. It fails closed on `truncated: true` and skips symlinks and non-UTF-8 files (covered by `tests/core/github-skills.test.ts`).
- `repo-hygiene` fails when any `.ts`, `.tsx`, `.mjs`, `.js`, `.cjs`, or `.css` file under `src/`, `web/src/`, or `tests/` has a comment, or when any `.md` or `.txt` file exists outside `README.md`, `STRATEGY.md`, `AGENTS.md`, and `.claude/skills/**` (`tests/core/repo-hygiene.test.ts`).

## How to get to it (user POV)

- Operator deploying to Cloudflare: `wrangler.jsonc`, the secrets `AGENTFABRIC_OPERATOR_TOKEN` and `AGENTFABRIC_MASTER_KEY`, and a D1 binding named `DB` (see `README.md`).
- Operator on Node: the console at `/` on any `af-launch.sh` instance.
- Contributor: `npx vitest run tests/core/repo-hygiene.test.ts` before committing.

## Driving it with curl, node, and vitest

Preconditions:

- `$S/af-doctor.sh "$P"` reports `doctor: healthy`, and `dist/deploy/cloudflare.js` exists (`af-launch.sh` builds it with the rest of `dist/`).
- `wrangler` is not a repository dependency. Without it, the Worker checks call the built Worker's `fetch` directly from Node, which is the same entry point Cloudflare calls. The only stand-in is the platform's `ASSETS` binding: a two-line object that serves `/index.html` and 404s the rest. Report `wrangler dev` / deployed-Worker behavior as not covered unless you ran it.

- **Worker config.** Run `sed 's#//.*##' wrangler.jsonc | jq -c .assets`. The output is `{"directory":"dist/web","binding":"ASSETS","run_worker_first":true}`.
- **Worker fails closed.** Run this from the repo root:

  ```sh
  node --input-type=module -e '
  const { createWorker } = await import(process.argv[1]);
  const w = createWorker();
  for (const [label, env] of [["no-token", {}], ["no-db", { AGENTFABRIC_OPERATOR_TOKEN: "t" }],
    ["db-no-key", { AGENTFABRIC_OPERATOR_TOKEN: "t", DB: {} }], ["db-blank-key", { AGENTFABRIC_OPERATOR_TOKEN: "t", DB: {}, AGENTFABRIC_MASTER_KEY: "  " }]]) {
    const r = await w.fetch(new Request("https://worker.example/api/status"), env);
    console.log(label, r.status, await r.text());
  }' "$PWD/dist/deploy/cloudflare.js" | tee "$P/worker-fail-closed.txt"
  ```

  Every line is `503` with `INTERNAL_ERROR`. The messages are `Gateway is not configured: set the AGENTFABRIC_OPERATOR_TOKEN secret`, `Durable Cloudflare D1 binding DB is not configured (set DB or AGENTFABRIC_ALLOW_EPHEMERAL=1)`, and, for both key cases, `Gateway is not configured: set the AGENTFABRIC_MASTER_KEY secret to encrypt secrets stored in D1`. The empty `DB: {}` is never touched, which proves the refusal happens before boot.
- **Worker CSP on the SPA fallback.** Call the same Worker with `{ AGENTFABRIC_OPERATOR_TOKEN: "t", AGENTFABRIC_ALLOW_EPHEMERAL: "1", ASSETS }`, where `ASSETS.fetch` returns an HTML response for `/index.html` and `404` otherwise, on `https://worker.example/sources`. The result is `200` with a `content-security-policy` that starts `default-src 'self'; script-src 'self'` and contains `frame-ancestors 'none'`, plus `x-frame-options: DENY`.
- **Node console CSP.** Run `. "$P/session.env"; for p in / /index.html /sources; do curl -sSI "$AF_URL$p" | grep -iE '^HTTP|content-security-policy|referrer-policy|x-content-type'; done`. Each path is `200` with `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`, `referrer-policy: no-referrer`, and `x-content-type-options: nosniff`.
- **Static root is confined.** `curl -s --path-as-is "$AF_URL/../../etc/passwd"` returns the console shell (`<title>AgentFabric Gateway</title>`, no `root:` line). `curl -s -o /dev/null -w '%{http_code}' "$AF_URL/%2e%2e/%2e%2e/etc/passwd.js"` prints `404`. An unknown `/api/*` path returns JSON `404` `NOT_FOUND`, never the shell.
- **Repository gates.** Run `npx vitest run tests/core/repo-hygiene.test.ts tests/core/d1-secrets.test.ts tests/core/github-skills.test.ts 2>&1 | tail -5 | tee "$P/repo-gates.txt"`. All files pass. These are static and unit gates, not drives of the running app. Report them under their own IDs and never as proof of runtime behavior.
- **Proof.** Keep `worker-fail-closed.txt`, `repo-gates.txt`, and the curl output.

## Gotchas

- `wrangler.jsonc` holds `//` comments, so strip them before `jq`.
- `needsMasterKey` applies only when `DB` is bound and no secret store is injected. With `AGENTFABRIC_ALLOW_EPHEMERAL=1` and no `DB`, the Worker uses an in-memory vault and boots without a key. Never treat that as durable.
- With secrets already in D1, a wrong master key fails the vault open, so boot fails and the Worker answers `503` `Gateway failed to start`. The error carries no plaintext or key material (`tests/core/d1-secrets.test.ts`). Changing the key without re-entering secrets locks the Worker out of its own vault.
- The Worker CSP (`base-uri 'self'`, no `form-action`) differs slightly from the Node CSP (`base-uri 'none'`, `form-action 'self'`). Assert each against its own source.
- Never plant a symlink in `dist/web` to test escapes. Another gateway on this machine, such as the live one on port 7432, may serve the same `dist/`. Leave symlink escapes to `tests/server/app.test.ts`.
- The repo-hygiene gate scans the working tree, so untracked scratch files under `src/`, `web/src/`, or `tests/`, or stray `.md`/`.txt` files anywhere, fail it. Keep proof files under `$P`.
