#!/usr/bin/env bash
# Read-only SQL against a COPY of a verify instance's stores (the live files stay untouched).
# Usage: af-db.sh <proof-dir> state  "<sqlite SQL>"    # <home>/state.db (+ WAL), via sqlite3
#        af-db.sh <proof-dir> traces "<duckdb SQL>"    # <home>/traces.duckdb (+ WAL), via @duckdb/node-api
# state.db tables hold JSON in a `payload` column, e.g.
#   af-db.sh "$P" state "select id, status from approvals"
#   af-db.sh "$P" traces "select status, count(*) from traces group by status"
set -euo pipefail
source "$(dirname "$0")/lib.sh"
af_load "${1:-}"
store=${2:?store required: state or traces}
sql=${3:?SQL required}

copy=$(mktemp -d "$AF_TMP/agentfabric-verify-db.XXXXXX")
trap 'rm -rf -- "$copy"' EXIT
case "$store" in
  state)
    cp "$AF_HOME/state.db" "$copy/"
    [[ -f "$AF_HOME/state.db-wal" ]] && cp "$AF_HOME/state.db-wal" "$copy/"
    result=$(sqlite3 -readonly -header "$copy/state.db" "$sql") ;;
  traces)
    cp "$AF_HOME/traces.duckdb" "$copy/"
    [[ -f "$AF_HOME/traces.duckdb.wal" ]] && cp "$AF_HOME/traces.duckdb.wal" "$copy/"
    result=$(cd "$AF_REPO" && node --input-type=module -e '
      import { DuckDBInstance } from "@duckdb/node-api";
      const db = await (await DuckDBInstance.create(process.argv[1])).connect();
      const reader = await db.runAndReadAll(process.argv[2]);
      console.log(reader.columnNames().join("|"));
      for (const row of reader.getRowsJS()) console.log(row.map(String).join("|"));
    ' "$copy/traces.duckdb" "$sql") ;;
  *) die "store must be 'state' or 'traces'" ;;
esac

out=$(af_transcript_path db "$store-$sql")
{ echo "> $store: $sql"; echo "$result"; } | af_redact >"$out"
printf '%s\n' "$result"
