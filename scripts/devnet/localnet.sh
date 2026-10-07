#!/usr/bin/env bash
# A fresh local validator for rehearsing the devnet kit, shaped like devnet where it matters:
#   - nothing preloaded: the program goes on through `pnpm devnet deploy`, as on devnet;
#   - the vote features devnet does not have yet are deactivated (SIMD-0464 VoteInitV2 and the deprecation of the
#     legacy vote instructions), so vote accounts are created and changed the way devnet does it today;
#   - short epochs (64 slots by default) so the seed's multi-epoch flows finish in minutes;
#   - with --meteora <dir>: Meteora's devnet builds of DBC, DAMM v2 and Metaplex token metadata and the DAMM v2
#     migration configs, as `dump-meteora` saved them, and DBC's pool authority funded (it holds 99 SOL on devnet), so
#     the seed launches its revenue token on the same programs devnet runs.
#
#   scripts/devnet/localnet.sh start --ledger <dir> [--rpc-port 8899] [--faucet-port 9900] [--gossip-port 8000]
#                                   [--dynamic-port-range 8001-8100] [--slots-per-epoch 64] [--limit-ledger-size 50000]
#                                   [--meteora <dir>]
#   scripts/devnet/localnet.sh stop  --ledger <dir> [--delete]     # --delete removes the ledger afterwards
#   scripts/devnet/localnet.sh dump-meteora --out <dir> [--url devnet]   # read-only: programs and configs to <dir>
#
# The websocket is on the RPC port + 1. The ledger directory must not be inside the repository.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# Features active in solana-test-validator's genesis but not on devnet (checked 7 Oct 2026, `solana feature status -ud`).
DEVNET_INACTIVE_FEATURES=(
  VoteAccount1nitia1izeV211111111111111111111 # SIMD-0464: Vote Account Initialize V2
  depVvnQ2UysGrhwdiwU42tCadZL8GcBb1i2GYhMopQv # Deprecate legacy vote instructions
  B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g # SIMD-0500: Disable deployment of SBPF v0-v2 (inactive on devnet, 7 Oct)
)

# Meteora (the same ids on devnet and mainnet) and the DAMM v2 configs DBC graduates into (DAMM_V2_MIGRATION_FEE_ADDRESS
# in @meteora-ag/dynamic-bonding-curve-sdk 1.5.13, one per migration fee option).
DBC=dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
DAMM_V2=cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
METAPLEX=metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
DBC_POOL_AUTHORITY=FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM
DAMM_V2_MIGRATION_CONFIGS=(
  7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd 2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k
  Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp 2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq
  AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u
  A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck
)

# An absolute, normalised path that may not exist yet (`realpath -m`; macOS's realpath has no -m).
abspath() {
  if realpath -m / >/dev/null 2>&1; then realpath -m "$1"; else python3 -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$1"; fi
}

cmd=${1:-}
shift || true
LEDGER="" RPC_PORT=8899 FAUCET_PORT=9900 GOSSIP_PORT=8000 DYNAMIC="8001-8100" SLOTS=64 LIMIT=50000 DELETE=0
METEORA="" OUT="" URL=devnet
while [ $# -gt 0 ]; do
  case "$1" in
    --ledger) LEDGER=$2; shift 2 ;;
    --rpc-port) RPC_PORT=$2; shift 2 ;;
    --faucet-port) FAUCET_PORT=$2; shift 2 ;;
    --gossip-port) GOSSIP_PORT=$2; shift 2 ;;
    --dynamic-port-range) DYNAMIC=$2; shift 2 ;;
    --slots-per-epoch) SLOTS=$2; shift 2 ;;
    --limit-ledger-size) LIMIT=$2; shift 2 ;;
    --delete) DELETE=1; shift ;;
    --meteora) METEORA=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --url) URL=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [ "$cmd" = dump-meteora ]; then
  [ -n "$OUT" ] || { echo "usage: $0 dump-meteora --out <dir> [--url devnet]" >&2; exit 2; }
  OUT=$(abspath "$OUT")
  case "$OUT/" in "$ROOT"/*) echo "--out must be outside the repository" >&2; exit 2 ;; esac
  mkdir -p "$OUT"
  solana program dump -u "$URL" "$DBC" "$OUT/dbc.so"
  solana program dump -u "$URL" "$DAMM_V2" "$OUT/damm-v2.so"
  solana program dump -u "$URL" "$METAPLEX" "$OUT/metaplex.so"
  for c in "${DAMM_V2_MIGRATION_CONFIGS[@]}"; do
    solana account -u "$URL" "$c" --output json > "$OUT/damm-config-$c.json"
  done
  echo "saved DBC, DAMM v2, Metaplex and ${#DAMM_V2_MIGRATION_CONFIGS[@]} DAMM v2 configs from $URL to $OUT"
  exit 0
fi
[ -n "$LEDGER" ] || { echo "usage: $0 start|stop --ledger <dir> [options]" >&2; exit 2; }
LEDGER=$(abspath "$LEDGER")
case "$LEDGER/" in "$ROOT"/*) echo "the ledger must be outside the repository" >&2; exit 2 ;; esac
PID_FILE="$LEDGER.pid"
LOG="$LEDGER.log"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "$cmd" in
  start)
    if running; then echo "already running (pid $(cat "$PID_FILE")) on http://127.0.0.1:$RPC_PORT"; exit 0; fi
    [ -e "$LEDGER" ] && { echo "$LEDGER exists; stop --delete it first for a fresh genesis" >&2; exit 1; }
    deactivate=()
    for f in "${DEVNET_INACTIVE_FEATURES[@]}"; do deactivate+=(--deactivate-feature "$f"); done
    meteora=()
    if [ -n "$METEORA" ]; then
      for f in dbc.so damm-v2.so metaplex.so; do
        [ -f "$METEORA/$f" ] || { echo "$METEORA/$f is missing: run dump-meteora --out $METEORA" >&2; exit 1; }
      done
      meteora+=(--bpf-program "$DBC" "$METEORA/dbc.so" --bpf-program "$DAMM_V2" "$METEORA/damm-v2.so"
        --bpf-program "$METAPLEX" "$METEORA/metaplex.so")
      for c in "${DAMM_V2_MIGRATION_CONFIGS[@]}"; do meteora+=(--account "$c" "$METEORA/damm-config-$c.json"); done
    fi
    nohup solana-test-validator \
      --ledger "$LEDGER" \
      --bind-address 127.0.0.1 \
      --rpc-port "$RPC_PORT" \
      --faucet-port "$FAUCET_PORT" \
      --gossip-port "$GOSSIP_PORT" \
      --dynamic-port-range "$DYNAMIC" \
      --slots-per-epoch "$SLOTS" \
      --limit-ledger-size "$LIMIT" \
      "${deactivate[@]}" \
      "${meteora[@]}" \
      --log > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    for _ in $(seq 1 90); do
      if curl -s -m 2 -X POST -H 'content-type: application/json' \
           -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$RPC_PORT" | grep -q '"ok"'; then
        echo "up: rpc http://127.0.0.1:$RPC_PORT, websocket ws://127.0.0.1:$((RPC_PORT + 1)), faucet 127.0.0.1:$FAUCET_PORT"
        if [ -n "$METEORA" ]; then
          # DBC's pool authority fronts the DAMM v2 pool's rent at graduation; the launch pre-flight checks it holds SOL.
          solana -u "http://127.0.0.1:$RPC_PORT" airdrop 5 "$DBC_POOL_AUTHORITY" --commitment confirmed > /dev/null
          echo "Meteora loaded from $METEORA (DBC, DAMM v2, Metaplex, ${#DAMM_V2_MIGRATION_CONFIGS[@]} DAMM v2 configs)"
        fi
        echo "pid $(cat "$PID_FILE"), ledger $LEDGER, log $LOG"
        exit 0
      fi
      running || { echo "validator exited; last log lines:" >&2; tail -n 30 "$LOG" >&2; exit 1; }
      sleep 1
    done
    echo "timed out waiting for the validator; see $LOG" >&2
    exit 1
    ;;
  stop)
    if running; then
      kill "$(cat "$PID_FILE")"
      for _ in $(seq 1 30); do running || break; sleep 1; done
      running && kill -9 "$(cat "$PID_FILE")"
      echo "stopped"
    else
      echo "not running"
    fi
    rm -f "$PID_FILE"
    if [ "$DELETE" = 1 ]; then rm -rf "$LEDGER" "$LOG"; echo "deleted $LEDGER"; fi
    ;;
  *) echo "usage: $0 start|stop|dump-meteora [options]" >&2; exit 2 ;;
esac
