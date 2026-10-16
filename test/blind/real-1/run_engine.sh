#!/bin/sh
# Runs the app's tuner engine on every file of this real-recording blind set, one JSON output per WAV.
# Usage: sh run_engine.sh <app repo folder> <output folder> [set folder]
#   set folder: default = the folder of this script (main set); pass "<this folder>/supplement" for the supplement.
# Per-file engine options (A4, instrument targets, locked string, tolerance) come from commands.tsv of the set folder.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SET="$(cd "${3:-$HERE}" && pwd)"
REPO="$(cd "$1" && pwd)"
mkdir -p "$2"
OUT="$(cd "$2" && pwd)"
TAB="$(printf '\t')"
n=0
fail=0
cd "$REPO"
while IFS="$TAB" read -r f args; do
  # shellcheck disable=SC2086
  if node --import ./scripts/ts-hooks.mjs scripts/tuner-json.mjs $args "$SET/$f" > "$OUT/${f%.wav}.json" 2> "$OUT/${f%.wav}.err"; then
    n=$((n + 1))
  else
    fail=$((fail + 1))
    echo "FAILED: $f (see $OUT/${f%.wav}.err)" >&2
  fi
done < "$SET/commands.tsv"
echo "$n files analysed, $fail failed. Score with: python3 \"$HERE/check.py\" \"$OUT\" --set \"$SET\""
