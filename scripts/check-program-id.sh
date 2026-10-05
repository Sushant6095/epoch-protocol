#!/usr/bin/env bash
# Fails when a copy of the Epoch program id disagrees with `declare_id!` in programs/epoch/src/lib.rs:
#   Anchor.toml [programs.*] epoch, programs/epoch/idl/epoch.json "address",
#   packages/epoch-sdk/src/__fixtures__/rust-vectors.json "declaredProgramId",
#   .env.example EPOCH_PROGRAM_ID (may stay empty while the id is the placeholder).
# Usage: scripts/check-program-id.sh [expected-id]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLACEHOLDER=11111111111111111111111111111111
declared=$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");.*/\1/p' "$ROOT/programs/epoch/src/lib.rs")
[ -n "$declared" ] || { echo "no declare_id! in programs/epoch/src/lib.rs"; exit 1; }
expected=${1:-$declared}
fail=0
check() { # label value
  if [ "$2" != "$expected" ]; then echo "MISMATCH $1: '$2' (expected $expected)"; fail=1; else echo "ok       $1"; fi
}
check 'declare_id! (programs/epoch/src/lib.rs)' "$declared"
anchor_ids=$(awk '/^\[programs\./{p=1; next} /^\[/{p=0} p && /^epoch *=/{gsub(/[" ]/,"",$0); sub(/^epoch=/,"",$0); print}' "$ROOT/Anchor.toml")
[ -n "$anchor_ids" ] || { echo "MISMATCH Anchor.toml: no [programs.*] epoch entry"; fail=1; }
for id in $anchor_ids; do check 'Anchor.toml [programs.*] epoch' "$id"; done
idl=$(sed -n 's/^  "address": "\([^"]*\)",$/\1/p' "$ROOT/programs/epoch/idl/epoch.json" | head -1)
check 'programs/epoch/idl/epoch.json address' "$idl"
vectors=$(sed -n 's/^  "declaredProgramId": "\([^"]*\)",$/\1/p' "$ROOT/packages/epoch-sdk/src/__fixtures__/rust-vectors.json" | head -1)
check 'packages/epoch-sdk/src/__fixtures__/rust-vectors.json declaredProgramId' "$vectors"
env_id=$(sed -n 's/^EPOCH_PROGRAM_ID=\(.*\)$/\1/p' "$ROOT/.env.example" | head -1)
if [ -z "$env_id" ] && [ "$expected" = "$PLACEHOLDER" ]; then
  echo "ok       .env.example EPOCH_PROGRAM_ID (empty: no program deployed yet)"
else
  check '.env.example EPOCH_PROGRAM_ID' "$env_id"
fi
if [ "$expected" = "$PLACEHOLDER" ]; then echo "note: the program id is still the placeholder (the System Program's id)"; fi
exit $fail
