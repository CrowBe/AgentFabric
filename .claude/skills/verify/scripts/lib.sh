# Shared helpers for the AgentFabric verify scripts. Source it; do not run it.
# shellcheck shell=bash

AF_SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AF_REPO=$(cd "$AF_SCRIPTS/../../../.." && pwd)
AF_TMP=${TMPDIR:-/tmp}
AF_TMP=${AF_TMP%/}

die() { echo "verify: $*" >&2; exit 1; }

# Environment the gateway and CLI must never inherit from the operator's shell.
AF_SCRUB=(-u AGENTFABRIC_OPERATOR_TOKEN -u AGENTFABRIC_URL -u AGENTFABRIC_PORT -u AGENTFABRIC_HOST
  -u AGENTFABRIC_PUBLIC_URL -u AGENTFABRIC_MODE -u AGENTFABRIC_LLM_API_URL -u AGENTFABRIC_LLM_API_KEY_SECRET
  -u AGENTFABRIC_LLM_MODEL -u AGENTFABRIC_LLM_PROVIDER)

# Load <proof>/session.env written by af-launch.sh.
af_load() {
  local proof=${1:-}
  [[ -n "$proof" ]] || die "pass the proof directory printed by af-launch.sh"
  proof=${proof%/}
  [[ -f "$proof/session.env" ]] || die "no session.env in $proof (did af-launch.sh run?)"
  # shellcheck disable=SC1091
  source "$proof/session.env"
  [[ "$AF_PROOF" == "$proof" ]] || die "session.env belongs to $AF_PROOF, not $proof"
}

af_token() {
  [[ -f "$AF_HOME/operator-token" ]] || die "operator token missing at $AF_HOME/operator-token (instance cleaned up?)"
  tr -d '\n' <"$AF_HOME/operator-token"
}

# Mask operator and client bearer tokens, OAuth states, auth tickets, gateway OAuth codes and
# refresh tokens, and any provider authorization code in a URL query, so transcripts are safe to keep.
af_redact() {
  sed -E 's/afop_[A-Za-z0-9_-]+/afop_[REDACTED]/g; s/af_tok_[A-Za-z0-9._~+\/-]+=*/af_tok_[REDACTED]/g;
    s/af_(oauth_state|ticket|code|refresh)_[A-Za-z0-9._~-]+/af_\1_[REDACTED]/g;
    s/([?&]code=)[^&#[:space:]"'"'"'<>]+/\1[REDACTED]/g'
}

# Next transcript path: <proof>/transcript/NNN-<kind>-<slug>.txt
af_transcript_path() {
  local kind=$1 label=$2 dir="$AF_PROOF/transcript" n slug
  mkdir -p "$dir"
  n=$(find "$dir" -maxdepth 1 -type f | wc -l)
  slug=$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-60)
  printf '%s/%03d-%s-%s.txt' "$dir" "$((n + 1))" "$kind" "$slug"
}

# True when $AF_PID is the gateway this run launched (node running dist/cli/index.js on $AF_HOME).
af_pid_is_ours() {
  [[ -r "/proc/$AF_PID/cmdline" ]] || return 1
  local cmd
  cmd=$(tr '\0' ' ' <"/proc/$AF_PID/cmdline")
  [[ "$cmd" == *"dist/cli/index.js start"* && "$cmd" == *"--home $AF_HOME"* ]]
}
