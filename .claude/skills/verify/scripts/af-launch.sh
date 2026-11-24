#!/usr/bin/env bash
# Launch an isolated AgentFabric gateway for verification.
# Usage: af-launch.sh [RUN_ID]
# Prints the proof directory on the last stdout line. Every other helper takes it as $1.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

run_id=${1:-$(date +%Y%m%d-%H%M%S)-$$}
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || die "RUN_ID may only contain letters, digits, . _ -"
proof="$AF_TMP/agentfabric-verify-proof-$run_id"
home="$AF_TMP/agentfabric-verify-home-$run_id"
[[ -e "$proof" || -e "$home" ]] && die "run id '$run_id' already used ($proof or $home exists)"
case "$proof/" in "$AF_REPO"/*) die "TMPDIR points inside the repository; set TMPDIR=/tmp" ;; esac
[[ "$home" != "$HOME/.agentfabric" ]] || die "refusing to use the operator's real home"

cd "$AF_REPO"
command -v node >/dev/null || die "node is not on PATH (Node.js 26+ required)"
[[ -d node_modules ]] || die "node_modules missing; run 'npm ci' in $AF_REPO first"

# Rebuild when dist is missing or older than its sources (dist/ is gitignored).
stale=0
[[ -f dist/cli/index.js && -f dist/web/index.html ]] || stale=1
if [[ $stale == 0 ]]; then
  [[ -z "$(find src -newer dist/cli/index.js -type f -print -quit)" ]] || stale=1
  [[ -z "$(find web -newer dist/web/index.html -type f -print -quit)" ]] || stale=1
fi
if [[ $stale == 1 ]]; then
  echo "verify: dist is missing or stale, running npm run build" >&2
  npm run build >&2
fi

mkdir -p "$proof"
mkdir -m 700 "$home"
log="$home/gateway.log"
port_arg=${AF_PORT:-0}   # 0 = OS-assigned free port, never the default 7432.

(
  exec env "${AF_SCRUB[@]}" AGENTFABRIC_HOME="$home" \
    nohup node dist/cli/index.js start --host 127.0.0.1 --port "$port_arg" --home "$home"
) >"$log" 2>&1 </dev/null &
pid=$!

url=""
for _ in $(seq 1 120); do
  if ! kill -0 "$pid" 2>/dev/null; then
    af_redact <"$log" >&2
    die "gateway exited during startup; run af-cleanup.sh $proof after reading the log above"
  fi
  url=$(sed -nE 's#^ Web UI +(http://[^ ]+)/$#\1#p' "$log" | head -1)
  [[ -n "$url" ]] && break
  sleep 0.5
done
[[ -n "$url" ]] || die "no banner after 60s; see $log, then run af-cleanup.sh $proof"
port=${url##*:}

cat >"$proof/session.env" <<EOF
AF_RUN_ID='$run_id'
AF_PROOF='$proof'
AF_HOME='$home'
AF_URL='$url'
AF_PORT='$port'
AF_PID='$pid'
AF_REPO='$AF_REPO'
EOF

# Ready means usable: health, operator auth, our home, and the seeded default profile.
token=$(tr -d '\n' <"$home/operator-token")
ready=0
for _ in $(seq 1 40); do
  if curl -fsS "$url/healthz" | grep -q '"ok":true' &&
    curl -fsS -H "authorization: Bearer $token" "$url/api/status" | grep -qF "\"homeDir\":\"$home\"" &&
    curl -fsS -o /dev/null -H "authorization: Bearer $token" "$url/api/profiles/default"; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ $ready == 1 ]] || die "gateway at $url never became usable; run af-cleanup.sh $proof"

{
  echo "run_id   $run_id"
  echo "url      $url"
  echo "mcp      $url/mcp/default"
  echo "home     $home"
  echo "pid      $pid"
  echo "git      $(git -C "$AF_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "launched $(date -Is)"
  echo
  af_redact <"$log"
} >"$proof/launch.txt"

echo "AgentFabric verify instance ready: $url (pid $pid, home $home)" >&2
echo "$proof"
