import {
  type Connection,
  Connection as Web3Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { BEAM_MIN_TIP_LAMPORTS, beamLanding, beamRoute, BeamTipAccounts, beamTipInstruction } from './Beam';
import { type ConnectionManager } from './ConnectionManager';
import { TransactionSender } from './TransactionSender';

const TIPS = [
  '15qWd4huAkoxvhDsHMfpUn27TW1YBYMMJJ2jkAkbeam',
  '9XuGciSwr5wb7dLTQm91JhuBTvj3GG8WjuRDc3obeam',
  '6993ZufwyEDNdB94kciDTGB17ANXguiNH22VmMQU1ami',
];

const jsonResponse = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe('BeamTipAccounts', () => {
  it('reads the current tip addresses, caches them, and keeps the last list when a refresh fails', async () => {
    let now = 0;
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, TIPS))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }));
    const tips = new BeamTipAccounts('https://api.solami.dev/onchain/tip-addresses', fetchFn, 1_000, () => now);
    expect((await tips.list()).map((k) => k.toBase58())).toEqual(TIPS);
    expect((await tips.pick(() => 0.99)).toBase58()).toBe(TIPS[2]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 2_000;
    expect((await tips.list()).map((k) => k.toBase58())).toEqual(TIPS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refuses to guess when there is no list at all', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, [])));
    await expect(tips.pick()).rejects.toThrow('Beam tip addresses unavailable');
  });
});

describe('beamTipInstruction / beamRoute', () => {
  it('builds a system transfer of at least the 100,000 lamport floor', () => {
    const payer = Keypair.generate().publicKey;
    const tip = new PublicKey(TIPS[0]);
    const ix = beamTipInstruction(payer, tip, BEAM_MIN_TIP_LAMPORTS);
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([payer.toBase58(), TIPS[0]]);
    expect(ix.data.readUInt32LE(0)).toBe(2);
    expect(ix.data.readBigUInt64LE(4)).toBe(100_000n);
    expect(() => beamTipInstruction(payer, tip, 99_999)).toThrow(RangeError);
  });

  it('is off without a URL or off mainnet', () => {
    expect(beamRoute({ cluster: 'mainnet' })).toBeUndefined();
    expect(beamRoute({ url: 'https://rpc.solami.dev/sol?api_key=k', cluster: 'devnet' })).toBeUndefined();
    expect(
      beamRoute({ url: 'https://rpc.solami.dev/sol?api_key=k', cluster: 'mainnet', tipLamports: 5 }),
    ).toMatchObject({ tipLamports: 100_000 });
  });
});

describe('beamLanding', () => {
  it('maps the public lookup and treats 404 as never seen', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { is_landed: true, landed_via_jito: false, region: 'NYC', tip_lamports: 100_000 }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { message: 'not found!' }));
    expect(await beamLanding('sig', fetchFn)).toEqual({
      signature: 'sig',
      isLanded: true,
      landedViaJito: false,
      region: 'NYC',
      tipLamports: 100_000,
    });
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.solami.dev/swqos/tx/sig');
    expect(await beamLanding('other', fetchFn)).toBeNull();
  });
});

describe('TransactionSender through Beam', () => {
  const payer = Keypair.generate();
  const programId = new PublicKey(new Uint8Array(32).fill(42));
  const ix = new TransactionInstruction({ programId, keys: [], data: Buffer.from([1, 2, 3]) });
  const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
  let sendRaw: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    sendRaw = jest.spyOn(Web3Connection.prototype, 'sendRawTransaction').mockResolvedValue('beamSig');
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  });
  afterEach(() => {
    sendRaw.mockRestore();
    fetchSpy.mockRestore();
  });

  function sender(tipAccounts: BeamTipAccounts, confirmErr: unknown = null) {
    const confirmTransaction = jest.fn(async () => ({ context: { slot: 1 }, value: { err: confirmErr } }));
    const connection = {
      getLatestBlockhash: jest.fn(async () => ({ blockhash, lastValidBlockHeight: 100 })),
      confirmTransaction,
    } as unknown as Connection;
    const connections = {
      withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection),
    } as unknown as ConnectionManager;
    const route = { url: 'https://rpc.solami.dev/sol?api_key=k', tipLamports: 150_000, tipAccounts };
    return { sender: new TransactionSender(connections, payer, { beam: route }), confirmTransaction };
  }

  it('appends a tip to a current tip address, submits to the Beam URL with preflight, and confirms normally', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const { sender: s, confirmTransaction } = sender(tips);
    expect(s.usesBeam).toBe(true);
    await expect(s.send([ix], [], { computeUnitPriceMicroLamports: 77 })).resolves.toBe('beamSig');

    const [raw, options] = sendRaw.mock.calls[0] as [Buffer, object];
    expect(options).toEqual({ skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
    const tx = Transaction.from(raw);
    expect(tx.feePayer?.equals(payer.publicKey)).toBe(true);
    expect(tx.recentBlockhash).toBe(blockhash);
    const programs = tx.instructions.map((i) => i.programId.toBase58());
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      programId.toBase58(),
      '11111111111111111111111111111111',
    ]);
    const tipIx = tx.instructions[2];
    expect(TIPS).toContain(tipIx.keys[1].pubkey.toBase58());
    expect(tipIx.data.readBigUInt64LE(4)).toBe(150_000n);
    expect(confirmTransaction).toHaveBeenCalledWith(
      { signature: 'beamSig', blockhash, lastValidBlockHeight: 100 },
      'confirmed',
    );
  });

  it('reports an on-chain failure with its error, so the caller can tell it from a network problem', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const err = { InstructionError: [1, { Custom: 6036 }] };
    const { sender: s } = sender(tips, err);
    await expect(s.send([ix], [], { retries: 0 })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      details: { error: expect.stringContaining('6036') },
    });
  });
});
