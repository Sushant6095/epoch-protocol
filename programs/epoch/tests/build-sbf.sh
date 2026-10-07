#!/usr/bin/env bash
# Build the SBF program the LiteSVM suite loads: target/litesvm/epoch.so.
#
# Anchor's entrypoint rejects any program id other than `declare_id!`, and the repo declares the
# placeholder 11111111111111111111111111111111 (the System Program's address) until a real id is set
# (scripts/set-program-id.sh). So this script copies the crate into target/litesvm/src, points
# `declare_id!` at the fixed test id below in that copy only (the repo is never modified), and runs
# cargo-build-sbf on the copy with the workspace's Cargo.lock and toolchain. The LiteSVM harness
# (programs/epoch/tests/litesvm/src/pda.rs, TEST_PROGRAM_ID) loads the binary at the same id.
#
# Usage: programs/epoch/tests/build-sbf.sh [extra cargo-build-sbf args]
# Env:   CARGO_TARGET_DIR (default <repo>/target) is shared, so dependencies are built once.
set -euo pipefail

# bytes "epoch-litesvm-test-program-id-v1"; keep in sync with TEST_PROGRAM_ID in programs/epoch/tests/litesvm/src/pda.rs
TEST_PROGRAM_ID=7pyci4ooVzsJH6Q5whahGNFwyjqhRhhm365jQkeWQ6tg

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
TARGET=${CARGO_TARGET_DIR:-$ROOT/target}
OUT="$TARGET/litesvm"
SRC="$OUT/src"

command -v cargo-build-sbf >/dev/null || {
  echo "cargo-build-sbf not found: install the Agave CLI (see tests/README.md) and put its bin/ on PATH" >&2
  exit 1
}

rm -rf "$SRC"
mkdir -p "$SRC/programs"
cp "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" "$ROOT/rust-toolchain.toml" "$SRC/"
# Only the program crate: the workspace globs programs/*, and the tests are not needed for the .so.
mkdir -p "$SRC/programs/epoch"
cp -R "$ROOT/programs/epoch/Cargo.toml" "$ROOT/programs/epoch/src" "$SRC/programs/epoch/"

LIB="$SRC/programs/epoch/src/lib.rs"
sed -i.bak -E "s/^declare_id!\(\"[1-9A-HJ-NP-Za-km-z]+\"\);/declare_id!(\"$TEST_PROGRAM_ID\");/" "$LIB"
rm -f "$LIB.bak"
grep -q "^declare_id!(\"$TEST_PROGRAM_ID\");" "$LIB" || {
  echo "could not set the test program id in $LIB" >&2
  exit 1
}

# Cargo treats the copy as fresh whatever changed in it (its sources live under the target dir), so a program
# change, or a build of another copy with a different id, would leave a stale epoch.so. Forget the epoch crate's
# fingerprint so it always recompiles (about 15 s); its dependencies stay cached.
rm -rf "$TARGET"/sbpf-solana-solana/release/.fingerprint/epoch-*

# Same Cargo.toml and Cargo.lock as the repo, so the dependency graph (and the shared build cache) match.
CARGO_TARGET_DIR="$TARGET" cargo-build-sbf \
  --manifest-path "$SRC/programs/epoch/Cargo.toml" \
  --sbf-out-dir "$OUT" \
  "$@"

# And forget it again, so the next build of programs/epoch itself (deploy) does not take this copy's binary as fresh.
rm -rf "$TARGET"/sbpf-solana-solana/release/.fingerprint/epoch-*

echo "built $OUT/epoch.so (program id $TEST_PROGRAM_ID)"
