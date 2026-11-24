#!/usr/bin/env bash
# Tear down a verify instance: stop the gateway this run started, delete its temp home, keep the proof.
# Usage: af-cleanup.sh <proof-dir>
# Safe to run repeatedly and after a failed launch.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"

report="$AF_PROOF/cleanup.txt"
log() { echo "$*" | tee -a "$report"; }
: >"$report"
log "cleanup $(date -Is) run $AF_RUN_ID"

# Keep redacted evidence from the home before it is deleted.
if [[ -d "$AF_HOME" ]]; then
  [[ -f "$AF_HOME/gateway.log" ]] && af_redact <"$AF_HOME/gateway.log" >"$AF_PROOF/gateway.log"
  ls -la "$AF_HOME" | sed -E 's/mcp-token-.*/mcp-token-* (cached client token)/' >"$AF_PROOF/home-listing.txt"
fi

# Stop only the process this run launched.
if kill -0 "$AF_PID" 2>/dev/null; then
  if af_pid_is_ours; then
    kill -TERM "$AF_PID"
    for _ in $(seq 1 30); do kill -0 "$AF_PID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$AF_PID" 2>/dev/null; then
      log "pid $AF_PID ignored SIGTERM for 15s; sending SIGKILL"
      kill -KILL "$AF_PID"
      sleep 0.5
    fi
  else
    log "pid $AF_PID is alive but is not this run's gateway; NOT killing it"
  fi
fi
[[ -f "$AF_HOME/gateway.log" ]] && af_redact <"$AF_HOME/gateway.log" >"$AF_PROOF/gateway.log"

fail=0
if kill -0 "$AF_PID" 2>/dev/null && af_pid_is_ours; then log "FAIL pid $AF_PID still running"; fail=1; else log "ok   pid $AF_PID is gone"; fi
if ss -ltnH "sport = :$AF_PORT" 2>/dev/null | grep -q .; then
  log "WARN port $AF_PORT still has a listener (another process may have taken it)"
else
  log "ok   port $AF_PORT is free"
fi

# Delete only the disposable home this run created.
case "$AF_HOME" in
  "$AF_TMP"/agentfabric-verify-home-*)
    if [[ "$AF_HOME" == "$HOME/.agentfabric" ]]; then log "FAIL refusing to delete $AF_HOME"; fail=1
    else rm -rf -- "$AF_HOME"; fi ;;
  *) log "FAIL home $AF_HOME is not a verify home; not deleting"; fail=1 ;;
esac
if [[ -e "$AF_HOME" ]]; then log "FAIL $AF_HOME still exists"; fail=1; else log "ok   home $AF_HOME removed"; fi

if [[ -d "$AF_PROOF" && -f "$AF_PROOF/session.env" ]]; then
  log "ok   proof kept at $AF_PROOF ($(find "$AF_PROOF" -type f | wc -l) files)"
else
  log "FAIL proof directory $AF_PROOF is gone"; fail=1
fi
exit $fail
