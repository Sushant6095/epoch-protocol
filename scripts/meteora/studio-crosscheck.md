# Studio cross-check: the exact commands

How to re-run [docs/meteora/STUDIO-CROSSCHECK.md](../../docs/meteora/STUDIO-CROSSCHECK.md): Meteora's studio CLI builds
Epoch's launch preset next to our launch CLI, on a local stand-in with Meteora's mainnet programs. Then the configs and
our API are compared with what the studio did. **Localnet only.** The studio wallet is a throwaway key: never point
this at mainnet, never commit `studio/.env` or `studio/keypair.json`.

## 0. Prerequisites

- Node 22.12+ and pnpm 10 (the meteora-invent repo enforces both).
- The local stand-in from [the rehearsal runbook](../../docs/runbooks/meteora-devnet-rehearsal.md#2-the-local-stand-in):
  `solana-test-validator` with Meteora's mainnet DBC (`dbcij3…`), DAMM v2 (`cpamdp…`) and Metaplex binaries, the DAMM v2
  migration configs, and the Epoch program built from this repo. RPC `http://127.0.0.1:38899` below.
- The Epoch Pool initialised and a validator onboarded on it (the rehearsal's `setup.ts`), the API running on the stand-in
  with the launch registry (`LAUNCHES_PATH`), and Epoch's own launch of the same preset done for the comparison.

```bash
git clone https://github.com/MeteoraAg/meteora-invent && cd meteora-invent
git checkout dd77ef3d5aede3f0ff21d566d052097200417f5e   # the commit the skill and this cross-check used
pnpm install
```

## 1. The wallet (throwaway, local)

```bash
solana-keygen new --no-bip39-passphrase -o /tmp/studio-localnet.json      # a scratch dir, never the repo
solana airdrop 20 $(solana-keygen pubkey /tmp/studio-localnet.json) -u http://127.0.0.1:38899
# studio wants PRIVATE_KEY (base58) in studio/.env; write it without printing it
cd studio && node -e "
const fs=require('fs');const b=require('bs58');const enc=(b.default||b).encode;
const sk=Uint8Array.from(JSON.parse(fs.readFileSync('/tmp/studio-localnet.json','utf8')));
fs.writeFileSync('.env','PRIVATE_KEY='+enc(sk)+'\n',{mode:0o600});" && cd ..
pnpm studio generate-keypair            # converts it to studio/keypair.json and prints the public key only
chmod 600 studio/keypair.json
```

## 2. The preset as a studio config

Edit `studio/config/dbc_config.jsonc`: the studio takes no config-file flag. `TREASURY` is the Epoch treasury PDA
`["treasury", pool]`, printed by the launch CLI's dry run (`findPartnerTreasuryPda` in `@epoch/epoch-sdk`). `CREATOR`
is the studio wallet. `leftover` is our plan's unsold supply for the 0.5 SOL raise (the launch report's "leftover"
line).

```jsonc
{
  "rpcUrl": "http://127.0.0.1:38899",
  "dryRun": true,
  "keypairFilePath": "./keypair.json",
  "computeUnitPriceMicroLamports": 100000,
  "quoteMint": "So11111111111111111111111111111111111111112",
  "dbcConfig": {
    "buildCurveMode": 5,
    "prices": [0.000006, 0.0000095],
    "token": { "totalTokenSupply": 1000000, "tokenBaseDecimal": 6, "tokenQuoteDecimal": 9, "tokenType": 0,
               "tokenAuthorityOption": 1, "leftover": 917983 },
    "fee": {
      "baseFeeParams": { "baseFeeMode": 0,
        "feeSchedulerParam": { "startingFeeBps": 100, "endingFeeBps": 100, "numberOfPeriod": 0, "totalDuration": 0 } },
      "dynamicFeeEnabled": false, "collectFeeMode": 0, "creatorTradingFeePercentage": 0, "poolCreationFee": 0,
      "enableFirstSwapWithMinFee": false
    },
    "migration": { "migrationOption": 1, "migrationFeeOption": 2,
                   "migrationFee": { "feePercentage": 70, "creatorFeePercentage": 100 } },
    "liquidityDistribution": { "partnerLiquidityPercentage": 0, "creatorLiquidityPercentage": 0,
                               "partnerPermanentLockedLiquidityPercentage": 100, "creatorPermanentLockedLiquidityPercentage": 0 },
    "lockedVesting": { "totalLockedVestingAmount": 0, "numberOfVestingPeriod": 0, "cliffUnlockAmount": 0,
                       "totalVestingDuration": 0, "cliffDurationFromMigrationTime": 0 },
    "activationType": 1,
    "leftoverReceiver": "TREASURY",
    "feeClaimer": "TREASURY"
  },
  "dbcPool": { "creator": "CREATOR", "name": "Epoch studio cross-check", "symbol": "rSTU",
               "metadata": { "uri": "https://example.invalid/rstu.json" } },
  "dbcSwap": { "amountIn": 0.15, "slippageBps": 100, "swapBaseForQuote": false, "referralTokenAccount": null }
}
```

In `studio/config/damm_v2_config.jsonc`, set `"rpcUrl": "http://127.0.0.1:38899"` (for `damm-v2-get-positions`).

## 3. The studio actions

Each write runs twice: once with `"dryRun": true`, then with `"dryRun": false`.

```bash
pnpm studio dbc-create-config                       # prints the config public key  → CONFIG
pnpm studio dbc-create-pool --config CONFIG         # prints the base mint          → MINT
pnpm studio dbc-get-status --baseMint MINT          # threshold (lamports), reserve, progress, fees
```

Quote with Epoch's API first, then swap with the studio (`dbcSwap.amountIn` 0.15):

```bash
curl -s -X POST -H 'content-type: application/json' -d '{"side":"buy","amount":0.15,"slippageBps":100}' \
  http://127.0.0.1:47110/v1/launches/MINT/quote          # needs MINT in the registry: see section 4
pnpm studio dbc-swap --baseMint MINT
pnpm studio dbc-get-status --baseMint MINT
curl -s http://127.0.0.1:47110/v1/launches/MINT/market ; curl -s http://127.0.0.1:47110/v1/launches/MINT/fees
```

To complete the curve, ask `/quote` for more than is left (`"amount": 0.5`). It answers the capped `amountIn` (swap2
partial fill). Put that exact amount in `dbcSwap.amountIn`: the studio's ExactIn quote refuses anything above it with
`Insufficient Liquidity`.

```bash
pnpm studio dbc-swap --baseMint MINT                # with the exact remainder
pnpm studio dbc-get-status --baseMint MINT          # 100.00%, migrated: no
pnpm studio dbc-migrate-to-damm-v2 --baseMint MINT
pnpm studio damm-v2-get-positions --poolAddress DAMM_POOL   # DAMM_POOL from /market graduation.dammPool
pnpm studio dbc-claim-trading-fee --baseMint MINT   # dry run only: the partner is the treasury PDA
```

## 4. Epoch's side

Add the studio pool to the launch registry the API reads (one entry, `LaunchRegistryEntry`: `mint`, `symbol`, `name`,
`validator`, `shareBps`, `termEpochs`, `startEpoch`, `dbcPool`, `dbcConfig`, `supply`, `decimals`, `cluster`,
`creator`, `feeClaimer`, `leftoverReceiver`). The API re-reads the file when it changes.

Register it with the program. This works once the validator's position has no revenue token, for example after
`close_revenue_token`:

```bash
cd packages/meteora
LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> EPOCH_PROGRAM_ID=<program id> LAUNCHES_PATH=<registry> \
  pnpm register -- --symbol rSTU --rpc http://127.0.0.1:38899 --allow-unknown-genesis            # dry run
# … then add --execute --yes
```

Then the treasury's claims (partner trading fee, leftover burn, LP fee) through the program:

```bash
cd packages/cranks_app && pnpm build
LAUNCH_CLAIMS_ENABLED=true LAUNCHES_PATH=<registry> LAUNCH_CLUSTER=devnet LAUNCH_RPC_URL=http://127.0.0.1:38899 \
EPOCH_RPC_URL=http://127.0.0.1:38899 EPOCH_PROGRAM_ID=<program id> CRANK_KEYPAIR_PATH=<crank keypair> \
  node dist/launch-claims.js --once
```

## 5. Compare the configs field by field

Save as `compare-configs.ts` in a scratch directory. Run it from `packages/meteora`, so that `@epoch/epoch-sdk` and
the DBC SDK resolve: `NODE_PATH=$PWD/node_modules npx tsx /path/to/compare-configs.ts`.

```ts
import { checkLaunchConfig, decodeDbcLaunchConfig } from '@epoch/epoch-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('http://127.0.0.1:38899', 'confirmed');
const [OURS, STUDIO, TREASURY] = process.argv.slice(2).map((key) => new PublicKey(key));

const plain = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === 'object' && 'toArrayLike' in (value as object)) return String(value);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, plain(v)]));
  return value;
};
const flatten = (value: unknown, prefix = ''): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? Object.entries(value as object).reduce((all, [k, v]) => ({ ...all, ...flatten(v, prefix ? `${prefix}.${k}` : k) }), {})
    : { [prefix]: value };

(async () => {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const a = flatten(plain(await client.state.getPoolConfig(OURS)));
  const b = flatten(plain(await client.state.getPoolConfig(STUDIO)));
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => !/padding/i.test(f)).sort();
  const differences = fields.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
  const verdict = async (key: PublicKey) =>
    plain(checkLaunchConfig(decodeDbcLaunchConfig((await connection.getAccountInfo(key))!.data), TREASURY));
  console.log(JSON.stringify({
    compared: fields.length,
    differences: differences.map((f) => ({ field: f, ours: a[f], studio: b[f] })),
    epochCheck: { ours: await verdict(OURS), studio: await verdict(STUDIO) },
  }, null, 2));
})();
```

```bash
npx tsx compare-configs.ts <our config> <studio config> <treasury PDA>
```

Expected (6 Oct 2026): 120 fields; the differences are only `sqrtStartPrice` (+1) and `curve.0.liquidity` (18th
digit); both `epochCheck` verdicts `{ ok: true, feeFloorBps: 100, maxImpactBound: 200 }`.

## 6. Clean up

```bash
rm studio/.env studio/keypair.json            # the throwaway key
git -C meteora-invent checkout studio/config  # the templates
```
