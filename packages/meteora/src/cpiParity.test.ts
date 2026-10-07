/**
 * The program's hand-encoded Meteora CPIs (`programs/epoch/src/cpi/meteora.rs`, no Meteora crate) against the IDLs the
 * pinned SDKs bundle: discriminator, arguments, slot order, writable and signer flags, and the fixed addresses. The Rust
 * tests pin the same lists to real mainnet instructions; this test pins them to Meteora's IDLs, so an SDK bump that
 * changes an account list fails here, before a buyback or a treasury claim fails on chain.
 *
 * What mainnet runs (programdata deploy slots, read 7 Oct 2026): dynamic_bonding_curve 0.2.1 (slot 445,503,633, 9 Sep
 * 2026 03:02 UTC) and cp_amm 0.2.4 (slot 445,230,614, 8 Sep 2026 03:00 UTC), the latest releases in Meteora's changelogs
 * (docs.meteora.ag/developer-guides/dbc/changelog, .../damm-v2/changelog). cp-amm SDK 1.5.1 bundles the cp_amm 0.2.5
 * IDL; it differs from 0.2.4's (cp-amm SDK 1.4.10) only in the version string, so every list below holds on mainnet.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CpAmmIdl,
  derivePoolAuthority as deriveDammPoolAuthority,
  derivePositionNftAccount,
  SwapMode as DammSwapMode,
} from '@meteora-ag/cp-amm-sdk';
import {
  deriveDammV2EventAuthority,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
  DynamicBondingCurveIdl,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';

const PROGRAM_SRC = join(__dirname, '../../../programs/epoch/src');
const cpiSource = readFileSync(join(PROGRAM_SRC, 'cpi/meteora.rs'), 'utf8');
const constantsSource = readFileSync(join(PROGRAM_SRC, 'constants.rs'), 'utf8');

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
}
interface MeteoraIdl {
  address: string;
  metadata: { name: string; version: string };
  instructions: IdlInstruction[];
  types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[] } }[];
}

const dbcIdl = DynamicBondingCurveIdl as unknown as MeteoraIdl;
const cpAmmIdl = CpAmmIdl as unknown as MeteoraIdl;

/** `pub const NAME: [u8; 8] = [..];` from meteora.rs. */
function rustDiscriminators(src: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const m of src.matchAll(/pub const (\w+): \[u8; 8\] =\s*\[([\d,\s]+)\];/g)) {
    out[m[1]] = m[2].split(',').map((s) => Number(s.trim()));
  }
  return out;
}

/** `pub const NAME: Pubkey = pubkey!("..");` from constants.rs. */
function rustAddresses(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/pub const (\w+): Pubkey =\s*pubkey!\("(\w+)"\);/g)) out[m[1]] = m[2];
  return out;
}

/** `pub const NAME: u8 = N;` from meteora.rs. */
function rustU8(src: string, name: string): number {
  const m = new RegExp(`pub const ${name}: u8 = (\\d+);`).exec(src);
  if (!m) throw new Error(`${name} not found in meteora.rs`);
  return Number(m[1]);
}

interface RustSlot {
  expr: string;
  writable: boolean;
  signer: boolean;
}

/** The `AccountMeta` slots of the first `vec![..]` inside `fn <name>`, in order. */
function rustSlots(src: string, fnName: string): RustSlot[] {
  const start = src.indexOf(`fn ${fnName}(`);
  if (start < 0) throw new Error(`fn ${fnName} not found in meteora.rs`);
  const open = src.indexOf('vec![', start);
  let depth = 0;
  let end = open + 'vec!'.length;
  for (; end < src.length; end += 1) {
    if (src[end] === '[') depth += 1;
    if (src[end] === ']' && --depth === 0) break;
  }
  const body = src.slice(open, end);
  return [...body.matchAll(/AccountMeta::(new|new_readonly)\(\s*([^,]+?),\s*(true|false)\s*\)/g)].map((m) => ({
    expr: m[2].trim(),
    writable: m[1] === 'new',
    signer: m[3] === 'true',
  }));
}

function ix(idl: MeteoraIdl, name: string): IdlInstruction {
  const found = idl.instructions.find((i) => i.name === name);
  if (!found) throw new Error(`${idl.metadata.name} has no instruction ${name}`);
  return found;
}

const discriminators = rustDiscriminators(cpiSource);
const addresses = rustAddresses(constantsSource);

/**
 * Each hand-encoded CPI: the IDL instruction, the Rust builder, the discriminator constant, and which Rust expression
 * fills each IDL slot. An optional account the program leaves out is the callee's program id (Anchor's `None`).
 */
const CASES: {
  label: string;
  idl: MeteoraIdl;
  instruction: string;
  rustFn: string;
  discriminator: string;
  args: string[];
  slots: Record<string, string>;
}[] = [
  {
    label: 'DBC swap2 (buyback on the curve)',
    idl: dbcIdl,
    instruction: 'swap2',
    rustFn: 'dbc_swap2_ix',
    discriminator: 'SWAP2_DISCRIMINATOR',
    args: ['params'],
    slots: {
      pool_authority: 'DBC_POOL_AUTHORITY',
      config: 'k.config',
      pool: 'k.pool',
      input_token_account: 'k.input_token_account',
      output_token_account: 'k.output_token_account',
      base_vault: 'k.token_vault',
      quote_vault: 'k.quote_vault',
      base_mint: 'k.token_mint',
      quote_mint: 'NATIVE_MINT',
      payer: 'k.payer',
      token_base_program: 'TOKEN_PROGRAM_ID',
      token_quote_program: 'TOKEN_PROGRAM_ID',
      referral_token_account: 'DBC_PROGRAM_ID',
      event_authority: 'DBC_EVENT_AUTHORITY',
      program: 'DBC_PROGRAM_ID',
    },
  },
  {
    label: 'DAMM v2 swap2 (buyback after graduation)',
    idl: cpAmmIdl,
    instruction: 'swap2',
    rustFn: 'damm_swap2_ix',
    discriminator: 'SWAP2_DISCRIMINATOR',
    args: ['_params'],
    slots: {
      pool_authority: 'CP_AMM_POOL_AUTHORITY',
      pool: 'k.pool',
      input_token_account: 'k.input_token_account',
      output_token_account: 'k.output_token_account',
      token_a_vault: 'k.token_vault',
      token_b_vault: 'k.quote_vault',
      token_a_mint: 'k.token_mint',
      token_b_mint: 'NATIVE_MINT',
      payer: 'k.payer',
      token_a_program: 'TOKEN_PROGRAM_ID',
      token_b_program: 'TOKEN_PROGRAM_ID',
      referral_token_account: 'CP_AMM_PROGRAM_ID',
      event_authority: 'CP_AMM_EVENT_AUTHORITY',
      program: 'CP_AMM_PROGRAM_ID',
    },
  },
  {
    label: 'DBC claim_trading_fee (partner)',
    idl: dbcIdl,
    instruction: 'claim_trading_fee',
    rustFn: 'dbc_claim_trading_fee_ix',
    discriminator: 'DBC_CLAIM_TRADING_FEE_DISCRIMINATOR',
    args: ['max_amount_a', 'max_amount_b'],
    slots: {
      pool_authority: 'DBC_POOL_AUTHORITY',
      config: 'k.config',
      pool: 'k.pool',
      token_a_account: 'k.base_account',
      token_b_account: 'k.quote_account',
      base_vault: 'k.base_vault',
      quote_vault: 'k.quote_vault',
      base_mint: 'k.base_mint',
      quote_mint: 'NATIVE_MINT',
      fee_claimer: 'k.treasury',
      token_base_program: 'TOKEN_PROGRAM_ID',
      token_quote_program: 'TOKEN_PROGRAM_ID',
      event_authority: 'DBC_EVENT_AUTHORITY',
      program: 'DBC_PROGRAM_ID',
    },
  },
  ...(['partner_withdraw_surplus', 'withdraw_migration_fee'] as const).map((instruction) => ({
    label: `DBC ${instruction}`,
    idl: dbcIdl,
    instruction,
    rustFn: 'dbc_quote_claim_accounts',
    discriminator:
      instruction === 'partner_withdraw_surplus'
        ? 'DBC_PARTNER_WITHDRAW_SURPLUS_DISCRIMINATOR'
        : 'DBC_WITHDRAW_MIGRATION_FEE_DISCRIMINATOR',
    args: instruction === 'withdraw_migration_fee' ? ['flag'] : [],
    slots: {
      pool_authority: 'DBC_POOL_AUTHORITY',
      config: 'k.config',
      virtual_pool: 'k.pool',
      token_quote_account: 'k.quote_account',
      quote_vault: 'k.quote_vault',
      quote_mint: 'NATIVE_MINT',
      [instruction === 'partner_withdraw_surplus' ? 'fee_claimer' : 'sender']: 'k.treasury',
      token_quote_program: 'TOKEN_PROGRAM_ID',
      event_authority: 'DBC_EVENT_AUTHORITY',
      program: 'DBC_PROGRAM_ID',
    },
  })),
  {
    label: 'DBC withdraw_leftover',
    idl: dbcIdl,
    instruction: 'withdraw_leftover',
    rustFn: 'dbc_withdraw_leftover_ix',
    discriminator: 'DBC_WITHDRAW_LEFTOVER_DISCRIMINATOR',
    args: [],
    slots: {
      pool_authority: 'DBC_POOL_AUTHORITY',
      config: 'k.config',
      virtual_pool: 'k.pool',
      token_base_account: 'k.base_account',
      base_vault: 'k.base_vault',
      base_mint: 'k.base_mint',
      leftover_receiver: 'k.treasury',
      token_base_program: 'TOKEN_PROGRAM_ID',
      event_authority: 'DBC_EVENT_AUTHORITY',
      program: 'DBC_PROGRAM_ID',
    },
  },
  {
    label: 'DAMM v2 claim_position_fee (treasury LP)',
    idl: cpAmmIdl,
    instruction: 'claim_position_fee',
    rustFn: 'damm_claim_position_fee_ix',
    discriminator: 'CP_AMM_CLAIM_POSITION_FEE_DISCRIMINATOR',
    args: [],
    slots: {
      pool_authority: 'CP_AMM_POOL_AUTHORITY',
      pool: 'k.pool',
      position: 'k.position',
      token_a_account: 'k.token_a_account',
      token_b_account: 'k.token_b_account',
      token_a_vault: 'k.token_a_vault',
      token_b_vault: 'k.token_b_vault',
      token_a_mint: 'k.token_a_mint',
      token_b_mint: 'NATIVE_MINT',
      position_nft_account: 'k.position_nft_account',
      signer: 'k.owner',
      token_a_program: 'TOKEN_PROGRAM_ID',
      token_b_program: 'TOKEN_PROGRAM_ID',
      event_authority: 'CP_AMM_EVENT_AUTHORITY',
      program: 'CP_AMM_PROGRAM_ID',
    },
  },
];

describe("the program's Meteora CPIs follow the pinned SDKs' IDLs", () => {
  it('pins the IDL versions the account lists were checked against', () => {
    expect(dbcIdl.metadata).toMatchObject({ name: 'dynamic_bonding_curve', version: '0.2.1' });
    // Mainnet runs cp_amm 0.2.4; its IDL equals 0.2.5's but for the version string (see the header).
    expect(cpAmmIdl.metadata).toMatchObject({ name: 'cp_amm', version: '0.2.5' });
  });

  it('uses the IDLs’ program ids', () => {
    expect(addresses.DBC_PROGRAM_ID).toBe(dbcIdl.address);
    expect(addresses.CP_AMM_PROGRAM_ID).toBe(cpAmmIdl.address);
  });

  it.each(CASES)('$label: discriminator, args, slots and flags', (c) => {
    const want = ix(c.idl, c.instruction);
    expect(discriminators[c.discriminator]).toEqual(want.discriminator);
    expect(want.args.map((a) => a.name)).toEqual(c.args);

    const rust = rustSlots(cpiSource, c.rustFn);
    expect(rust.map((s) => s.expr)).toEqual(want.accounts.map((a) => c.slots[a.name]));
    want.accounts.forEach((account, i) => {
      const slot = rust[i];
      const absent = account.optional === true && slot.expr === `${c.idl === dbcIdl ? 'DBC' : 'CP_AMM'}_PROGRAM_ID`;
      expect({ account: account.name, writable: slot.writable, signer: slot.signer }).toEqual({
        account: account.name,
        // An absent optional account is the read-only program id, as Anchor's clients and mainnet encode `None`.
        writable: absent ? false : account.writable === true,
        signer: account.signer === true,
      });
      if (account.address)
        expect({ account: account.name, address: addresses[slot.expr] }).toEqual({
          account: account.name,
          address: account.address,
        });
    });
  });

  it('encodes SwapParameters2 as the IDLs define it, with the SDKs’ swap modes', () => {
    for (const idl of [dbcIdl, cpAmmIdl]) {
      const params = idl.types.find((t) => t.name === 'SwapParameters2');
      expect(params?.type.fields?.map((f) => [f.name, f.type])).toEqual([
        ['amount_0', 'u64'],
        ['amount_1', 'u64'],
        ['swap_mode', 'u8'],
      ]);
    }
    // swap2_data: discriminator, amount_0 (u64 LE), amount_1 (u64 LE), swap_mode (u8).
    expect(cpiSource).toMatch(
      /extend_from_slice\(&SWAP2_DISCRIMINATOR\);\s*data\.extend_from_slice\(&amount_0\.to_le_bytes\(\)\);\s*data\.extend_from_slice\(&amount_1\.to_le_bytes\(\)\);\s*data\.push\(swap_mode\);/,
    );
    expect(rustU8(cpiSource, 'SWAP_MODE_EXACT_IN')).toBe(SwapMode.ExactIn);
    expect(rustU8(cpiSource, 'SWAP_MODE_PARTIAL_FILL')).toBe(SwapMode.PartialFill);
    expect(rustU8(cpiSource, 'SWAP_MODE_EXACT_IN')).toBe(DammSwapMode.ExactIn);
    expect(rustU8(cpiSource, 'SWAP_MODE_PARTIAL_FILL')).toBe(DammSwapMode.PartialFill);
  });

  it('uses the SDKs’ authority and event-authority PDAs', () => {
    expect(addresses.DBC_POOL_AUTHORITY).toBe(deriveDbcPoolAuthority().toBase58());
    expect(addresses.DBC_EVENT_AUTHORITY).toBe(deriveDbcEventAuthority().toBase58());
    expect(addresses.CP_AMM_POOL_AUTHORITY).toBe(deriveDammPoolAuthority().toBase58());
    expect(addresses.CP_AMM_EVENT_AUTHORITY).toBe(deriveDammV2EventAuthority().toBase58());
  });

  it('derives the position NFT account as cp-amm does', () => {
    const seed = /pub const CP_AMM_POSITION_NFT_ACCOUNT_SEED: &\[u8\] = b"(\w+)";/.exec(constantsSource)?.[1];
    expect(seed).toBe('position_nft_account');
    const nftMint = new PublicKey(new Uint8Array(32).fill(7));
    const [ours] = PublicKey.findProgramAddressSync(
      [Buffer.from(seed as string), nftMint.toBuffer()],
      new PublicKey(addresses.CP_AMM_PROGRAM_ID),
    );
    expect(ours.toBase58()).toBe(derivePositionNftAccount(nftMint).toBase58());
  });
});
