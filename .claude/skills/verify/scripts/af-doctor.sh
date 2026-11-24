#!/usr/bin/env bash
# Read-only check: is this verify instance worth driving?
# Usage: af-doctor.sh <proof-dir>
set -uo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"

fail=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }

if af_pid_is_ours; then ok "pid $AF_PID runs dist/cli/index.js on $AF_HOME"; else bad "pid $AF_PID is not our gateway (exited or reused)"; fi

if ss -ltnpH "sport = :$AF_PORT" 2>/dev/null | grep -q "pid=$AF_PID,"; then
  ok "port $AF_PORT is owned by pid $AF_PID"
else
  bad "port $AF_PORT is not held by pid $AF_PID"
fi

health=$(curl -sS --max-time 5 "$AF_URL/healthz" 2>/dev/null)
if [[ "$health" == *'"ok":true'* ]]; then ok "healthz $health"; else bad "healthz returned '$health'"; fi

code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$AF_URL/api/status")
if [[ "$code" == 401 ]]; then ok "unauthenticated /api/status fails closed (401)"; else bad "unauthenticated /api/status returned $code, expected 401"; fi

token=$(af_token)
status=$(curl -sS --max-time 5 -H "authorization: Bearer $token" "$AF_URL/api/status")
if [[ "$(jq -r .homeDir <<<"$status" 2>/dev/null)" == "$AF_HOME" ]]; then
  ok "operator token valid; status homeDir is $AF_HOME; mode $(jq -r .mode <<<"$status"); counts $(jq -c .counts <<<"$status")"
else
  bad "operator /api/status did not report homeDir $AF_HOME: ${status:0:300}"
fi

if curl -sS --max-time 5 "$AF_URL/" | grep -q '<title>AgentFabric Gateway</title>'; then
  ok "web UI shell served at $AF_URL/"
else
  bad "web UI shell missing at $AF_URL/ (dist/web not built?)"
fi

[[ "$AF_HOME" != "$HOME/.agentfabric" ]] && ok "isolated home (not ~/.agentfabric)" || bad "instance uses ~/.agentfabric"

if [[ $fail == 0 ]]; then echo "doctor: healthy"; else echo "doctor: NOT healthy"; fi
exit $fail
