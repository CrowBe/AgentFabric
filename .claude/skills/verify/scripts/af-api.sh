#!/usr/bin/env bash
# Call the operator REST API (/api/*) of a verify instance and record a redacted transcript.
# Usage: af-api.sh <proof-dir> METHOD PATH [JSON-BODY | @file]
#   AF_NOAUTH=1   send no operator token (fail-closed checks)
# Stdout: raw response body. Stderr: "HTTP <code>". Exit 0 only for 2xx.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"
method=${2:?METHOD required}
path=${3:?PATH required}
body=${4:-}

args=(-sS --max-time "${AF_MAX_TIME:-30}" -X "$method" -o "$AF_HOME/.af-api-body" -w '%{http_code}')
[[ "${AF_NOAUTH:-0}" == 1 ]] || args+=(-H "authorization: Bearer $(af_token)")
if [[ -n "$body" ]]; then
  [[ "$body" == @* ]] && body=$(cat "${body#@}")
  args+=(-H 'content-type: application/json' --data-binary "$body")
fi

code=$(curl "${args[@]}" "$AF_URL$path") || code=000
resp=$(cat "$AF_HOME/.af-api-body" 2>/dev/null || true)
rm -f "$AF_HOME/.af-api-body"

logged_body=$body
# Secret values are write-only in the product; keep them out of the proof too.
if [[ "$path" == /api/secrets/* && -n "$body" ]]; then
  logged_body=$(jq -c '.value = "[REDACTED]"' <<<"$body" 2>/dev/null || echo '[unparseable secret body withheld]')
fi

out=$(af_transcript_path api "$method$path")
{
  echo "> $method $AF_URL$path$([[ "${AF_NOAUTH:-0}" == 1 ]] && echo '  (no operator token)')"
  [[ -n "$logged_body" ]] && echo "> $logged_body"
  echo "< HTTP $code"
  echo "< $resp"
} | af_redact >"$out"

printf '%s\n' "$resp"
echo "HTTP $code" >&2
[[ "$code" == 2* ]]
