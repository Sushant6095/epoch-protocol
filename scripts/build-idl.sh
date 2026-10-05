#!/usr/bin/env bash
# Regenerate programs/epoch/idl/epoch.json (the Anchor IDL) from the program source.
# With anchor-cli 1.2 on PATH: `anchor idl build`. Without it: the same IdlBuilder anchor-cli uses
# (programs/epoch/idl/gen). Both compile the program's tests with --features idl-build.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/programs/epoch/idl/epoch.json"
if command -v anchor >/dev/null 2>&1 && anchor --version 2>/dev/null | grep -q ' 1\.2\.'; then
  (cd "$ROOT" && anchor idl build -p epoch -o "$OUT")
  # anchor-cli writes no trailing newline; the committed file has one.
  [ -z "$(tail -c1 "$OUT")" ] || echo >> "$OUT"
else
  cargo build --release --manifest-path "$ROOT/programs/epoch/idl/gen/Cargo.toml"
  # IdlBuilder 0.1.4 mishandles RUSTUP_TOOLCHAIN (it passes a literal "+{toolchain}" to cargo).
  env -u RUSTUP_TOOLCHAIN "$ROOT/programs/epoch/idl/gen/target/release/epoch-idl-gen" "$ROOT/programs/epoch" "$OUT"
fi
"$ROOT/scripts/check-program-id.sh"
