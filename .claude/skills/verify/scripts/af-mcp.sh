#!/usr/bin/env bash
# Send one MCP JSON-RPC request to /mcp/<profile> as a harness would, with a redacted transcript.
# Usage: af-mcp.sh <proof-dir> <profile-id> <method> [params-json]
#        af-mcp.sh <proof-dir> <profile-id> --respond '{"id":"<elicitation id>","result":{...}}'
#   --respond sends a JSON-RPC response (answering a server request such as elicitation/create) with the
#   given id and result or error; pair it with AF_MCP_SESSION set to the session that received the request.
#   First use per profile mints a bearer token via POST /api/tokens and caches it in
#   <home>/mcp-token-<profile> (removed with the home on cleanup).
#   AF_MCP_TOKEN=<token>|none   use this bearer instead (none = no Authorization header)
#   AF_MCP_VERSION=<version>    MCP-Protocol-Version header (default 2026-07-28)
#   AF_MCP_SESSION=<id>         send Mcp-Session-Id
#   AF_MAX_TIME=<seconds>       curl timeout (default 30); SSE methods stream until it expires
#   AF_MCP_STREAM=<file>        also write the response body to <file> as it arrives (read an in-flight SSE
#                               stream, e.g. an elicitation/create request, while the call is still open)
# Stdout: response body (JSON, or SSE lines). Stderr: "HTTP <code>". Exit 0 for 2xx.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"
profile=${2:?profile id required (e.g. default)}
method=${3:?JSON-RPC method required}
params=${4:-}

if [[ -n "${AF_MCP_TOKEN:-}" ]]; then
  bearer=$AF_MCP_TOKEN
else
  cache="$AF_HOME/mcp-token-$profile"
  if [[ ! -s "$cache" ]]; then
    minted=$("$AF_SCRIPTS/af-api.sh" "$AF_PROOF" POST /api/tokens \
      "{\"label\":\"verify-$profile\",\"profileId\":\"$profile\"}" 2>/dev/null) ||
      die "could not mint an MCP token for profile '$profile': $minted"
    (umask 077 && jq -r .token <<<"$minted" >"$cache")
  fi
  bearer=$(<"$cache")
fi

id="af-$(date +%s%N)"   # string id: nanosecond integers exceed JSON-RPC safe-integer ids
if [[ "$method" == --respond ]]; then
  [[ -n "$params" ]] || die "--respond needs a JSON object with id and result or error"
  body=$(jq -c '{jsonrpc:"2.0"} + .' <<<"$params") || die "--respond body is not JSON"
elif [[ -n "$params" ]]; then
  body=$(jq -cn --arg m "$method" --arg id "$id" --argjson p "$params" '{jsonrpc:"2.0",id:$id,method:$m,params:$p}')
else
  body=$(jq -cn --arg m "$method" --arg id "$id" '{jsonrpc:"2.0",id:$id,method:$m}')
fi

body_file=${AF_MCP_STREAM:-$AF_HOME/.af-mcp-body-$id}
args=(-sS -N --max-time "${AF_MAX_TIME:-30}" -D "$AF_HOME/.af-mcp-headers-$id" -o "$body_file" -w '%{http_code}'
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream'
  -H "mcp-protocol-version: ${AF_MCP_VERSION:-2026-07-28}" --data-binary "$body")
[[ "$bearer" == none ]] || args+=(-H "authorization: Bearer $bearer")
[[ -z "${AF_MCP_SESSION:-}" ]] || args+=(-H "mcp-session-id: $AF_MCP_SESSION")

code=$(curl "${args[@]}" "$AF_URL/mcp/$profile") || true   # curl exits 28 when an SSE stream hits AF_MAX_TIME
code=${code:-000}
resp=$(cat "$body_file" 2>/dev/null || true)
headers=$(tr -d '\r' <"$AF_HOME/.af-mcp-headers-$id" 2>/dev/null | grep -iE '^(mcp-|www-authenticate|content-type)' || true)
rm -f "$AF_HOME/.af-mcp-body-$id" "$AF_HOME/.af-mcp-headers-$id"
if [[ -n "${AF_MCP_STREAM:-}" && -f "$body_file" ]]; then
  af_redact <"$body_file" >"$body_file.redacted" && mv -f "$body_file.redacted" "$body_file"
fi

out=$(af_transcript_path mcp "$profile-$method")
{
  echo "> POST $AF_URL/mcp/$profile  (bearer: $([[ "$bearer" == none ]] && echo none || echo present))"
  echo "> $body"
  echo "< HTTP $code"
  [[ -n "$headers" ]] && sed 's/^/< /' <<<"$headers"
  echo "< $resp"
} | af_redact >"$out"

printf '%s\n' "$resp"
echo "HTTP $code" >&2
[[ "$code" == 2* ]]
