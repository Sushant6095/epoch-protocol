#!/usr/bin/env bash
# Point every copy of the Epoch program id at <ID>, the public key of the program keypair you created
# (`solana-keygen new -o <outside the repo>/epoch-program.json`, then `solana-keygen pubkey` on it):
#   declare_id! in programs/epoch/src/lib.rs, Anchor.toml [programs.localnet|devnet|mainnet],
#   .env.example EPOCH_PROGRAM_ID, the IDL's "address", and the SDK's Rust vectors (regenerated).
# Then runs scripts/check-program-id.sh. Never takes or prints a keypair.
# Usage: scripts/set-program-id.sh <ID> [--no-vectors]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID=${1:-}
[ -n "$ID" ] || { echo "usage: $0 <program id> [--no-vectors]"; exit 2; }
# A base58 public key: 32 bytes.
node -e '
  const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const s = process.argv[1];
  let n = 0n;
  for (const c of s) { const i = a.indexOf(c); if (i < 0) process.exit(1); n = n * 58n + BigInt(i); }
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  const zeros = s.length - s.replace(/^1+/, "").length;
  process.exit(bytes + zeros === 32 ? 0 : 1);
' "$ID" || { echo "not a base58 public key: $ID"; exit 2; }

LIB="$ROOT/programs/epoch/src/lib.rs"
sed -i.bak -E "s/^declare_id!\(\"[1-9A-HJ-NP-Za-km-z]+\"\);/declare_id!(\"$ID\");/" "$LIB" && rm -f "$LIB.bak"

TOML="$ROOT/Anchor.toml"
awk -v id="$ID" '
  /^\[programs\./ { p = 1; print; next }
  /^\[/ { p = 0 }
  p && /^epoch *=/ { print "epoch = \"" id "\""; next }
  { print }
' "$TOML" > "$TOML.tmp" && mv "$TOML.tmp" "$TOML"
if ! grep -q '^\[programs.mainnet\]' "$TOML"; then
  awk -v id="$ID" '
    { print }
    /^\[programs\.devnet\]/ { dev = 1; next }
    dev && /^epoch *=/ { print ""; print "[programs.mainnet]"; print "epoch = \"" id "\""; dev = 0 }
  ' "$TOML" > "$TOML.tmp" && mv "$TOML.tmp" "$TOML"
fi

ENV="$ROOT/.env.example"
sed -i.bak -E "s/^EPOCH_PROGRAM_ID=.*/EPOCH_PROGRAM_ID=$ID/" "$ENV" && rm -f "$ENV.bak"

IDL="$ROOT/programs/epoch/idl/epoch.json"
sed -i.bak -E "0,/^  \"address\": \"[^\"]*\",$/s//  \"address\": \"$ID\",/" "$IDL" && rm -f "$IDL.bak"

if [ "${2:-}" != "--no-vectors" ]; then
  # The vectors carry the declared id (Anchor passes it for an absent optional account).
  cargo run --offline --release --quiet --manifest-path "$ROOT/packages/epoch-sdk/vectors/Cargo.toml"
fi
"$ROOT/scripts/check-program-id.sh" "$ID"
echo "Next: rebuild (cargo build-sbf), run cargo test and pnpm test, and set EPOCH_PROGRAM_ID=$ID in each app's .env."
