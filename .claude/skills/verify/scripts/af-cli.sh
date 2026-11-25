#!/usr/bin/env bash
# Run the real agentfabric CLI against a verify instance and record command, stdout, stderr, exit.
# Usage: af-cli.sh <proof-dir> <agentfabric args...>
#   e.g. af-cli.sh "$P" status --json
# --url and --home are appended for you; the operator token is read from <home>/operator-token.
set -uo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"
shift
[[ $# -gt 0 ]] || die "pass agentfabric arguments, e.g. status"

stdout_f="$AF_HOME/.af-cli-stdout" stderr_f="$AF_HOME/.af-cli-stderr"
(cd "$AF_REPO" && env "${AF_SCRUB[@]}" AGENTFABRIC_HOME="$AF_HOME" \
  node dist/cli/index.js "$@" --url "$AF_URL" --home "$AF_HOME") >"$stdout_f" 2>"$stderr_f"
code=$?

out=$(af_transcript_path cli "$*")
{
  echo "\$ agentfabric $* --url $AF_URL --home $AF_HOME"
  echo "--- exit $code"
  echo "--- stdout"
  cat "$stdout_f"
  echo "--- stderr"
  cat "$stderr_f"
} | af_redact >"$out"

cat "$stdout_f"
cat "$stderr_f" >&2
rm -f "$stdout_f" "$stderr_f"
echo "exit $code" >&2
exit $code
