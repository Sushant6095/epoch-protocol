import {
  type Connection,
  Connection as Web3Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  BEAM_MIN_TIP_LAMPORTS,
  BEAM_PINNED_TIP_ACCOUNTS,
  beamLanding,
  beamRoute,
  BeamTipAccounts,
  beamTipInstruction,
} from './Beam';
import { type ConnectionManager } from './ConnectionManager';
import { SolamiUsage } from './SolamiUsage';
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

  it('falls back to the list pinned from Solami’s SDK, and goes back to the API a minute later', async () => {
    let now = 0;
    const fetchFn = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, TIPS));
    const tips = new BeamTipAccounts('x', fetchFn, 600_000, () => now);
    expect((await tips.list()).map((k) => k.toBase58())).toEqual(BEAM_PINNED_TIP_ACCOUNTS);
    expect(tips.source).toBe('pinned');
    now = 30_000;
    await tips.list();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect((await tips.list()).map((k) => k.toBase58())).toEqual(TIPS);
    expect(tips.source).toBe('api');
  });

  it('pins the ten addresses of the official SDK (solami 0.1.56), all valid keys', () => {
    expect(BEAM_PINNED_TIP_ACCOUNTS).toHaveLength(10);
    for (const address of BEAM_PINNED_TIP_ACCOUNTS) expect(new PublicKey(address).toBase58()).toBe(address);
  });

  it('refuses to guess when there is no list at all', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, [])), 1_000, Date.now, []);
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

  function sender(
    tipAccounts: BeamTipAccounts,
    confirmErr: unknown = null,
    simulation: { err: unknown; logs: string[] } = { err: null, logs: [] },
  ) {
    const confirmTransaction = jest.fn(async () => ({ context: { slot: 1 }, value: { err: confirmErr } }));
    const simulateTransaction = jest.fn(async () => ({ context: { slot: 1 }, value: simulation }));
    const connection = {
      getLatestBlockhash: jest.fn(async () => ({ blockhash, lastValidBlockHeight: 100 })),
      confirmTransaction,
      simulateTransaction,
      // The normal path (web3's sendAndConfirmTransaction).
      sendTransaction: jest.fn(async () => 'directSig'),
    } as unknown as Connection;
    const connections = {
      withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection),
    } as unknown as ConnectionManager;
    const route = { url: 'https://rpc.solami.dev/sol?api_key=k', tipLamports: 150_000, tipAccounts };
    const usage = new SolamiUsage('test');
    return {
      sender: new TransactionSender(connections, payer, { beam: route, usage }),
      confirmTransaction,
      simulateTransaction,
      usage,
    };
  }

  it('appends a tip to a current tip address, simulates, submits to the Beam URL and confirms normally', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const { sender: s, confirmTransaction, simulateTransaction, usage } = sender(tips);
    expect(s.usesBeam).toBe(true);
    await expect(s.send([ix], [], { computeUnitPriceMicroLamports: 77 })).resolves.toBe('beamSig');

    // The signed transaction is simulated on the normal RPC (real blockhash, no signature check) before it is sent.
    expect(simulateTransaction).toHaveBeenCalledWith(expect.anything(), { sigVerify: false, commitment: 'confirmed' });
    const [raw, options] = sendRaw.mock.calls[0] as [Buffer, object];
    expect(options).toEqual({ skipPreflight: true, maxRetries: 0 });
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
    expect(usage.report().beam).toMatchObject({
      sends: 1,
      landed: 1,
      failed: 0,
      tipLamports: 150_000,
      tipsSpentLamports: 150_000,
      tipSource: 'api',
      lastSignature: 'beamSig',
    });
  });

  it('never sends a transaction whose simulation fails (no fee, no tip), and keeps its logs', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const logs = ['Program log: AnchorError occurred. Error Code: StaleIndex. Error Number: 6004.'];
    const { sender: s, usage } = sender(tips, null, { err: { InstructionError: [1, { Custom: 6004 }] }, logs });
    await expect(s.send([ix], [], { retries: 0 })).rejects.toMatchObject({
      details: { logs, error: expect.stringContaining('Simulation failed before Beam') },
    });
    expect(sendRaw).not.toHaveBeenCalled();
    expect(usage.report().beam).toBeNull();
  });

  it('explains a refused send (here: a Beam host that does not resolve) and counts it', async () => {
    sendRaw.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND beam-http.solami.dev') }),
    );
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const { sender: s, usage } = sender(tips);
    await expect(s.send([ix], [], { retries: 0 })).rejects.toMatchObject({
      details: { error: expect.stringContaining('does not resolve') },
    });
    expect(usage.report().beam).toMatchObject({ sends: 0, failed: 1 });
    expect(usage.report().lastError).toMatchObject({ product: 'beam', message: expect.stringContaining('resolve') });
  });

  it('sends the normal way (and counts the fallback) when no tip address can be read at all', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockRejectedValue(new Error('down')), 1_000, Date.now, []);
    const { sender: s, usage } = sender(tips);
    await expect(s.send([ix], [], { retries: 0 })).resolves.toBe('directSig');
    expect(sendRaw).not.toHaveBeenCalled();
    expect(usage.report().beam).toMatchObject({ sends: 0, fallbacks: 1 });
  });

  it('reports an on-chain failure with its error, so the caller can tell it from a network problem', async () => {
    const tips = new BeamTipAccounts('x', jest.fn().mockResolvedValue(jsonResponse(200, TIPS)));
    const err = { InstructionError: [1, { Custom: 6036 }] };
    const { sender: s, usage } = sender(tips, err);
    await expect(s.send([ix], [], { retries: 0 })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      details: { error: expect.stringContaining('6036') },
    });
    expect(usage.report().beam).toMatchObject({ sends: 1, landed: 0, failed: 1, tipsSpentLamports: 0 });
  });
});
