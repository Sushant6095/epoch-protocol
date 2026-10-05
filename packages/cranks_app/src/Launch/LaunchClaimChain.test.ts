import { BeamTipAccounts, type ConnectionManager } from '@epoch/solana';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import { RpcLaunchClaimChain } from './LaunchClaimChain';

const TIP = '15qWd4huAkoxvhDsHMfpUn27TW1YBYMMJJ2jkAkbeam';
const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

function connections() {
  const connection = {
    getLatestBlockhash: jest.fn(async () => ({ blockhash, lastValidBlockHeight: 100 })),
    simulateTransaction: jest.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } })),
    confirmTransaction: jest.fn(async () => ({ context: { slot: 1 }, value: { err: null } })),
    sendTransaction: jest.fn(async () => 'directSig'),
  };
  const manager = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
  return { connection, manager };
}

describe('RpcLaunchClaimChain sends', () => {
  const cranker = Keypair.generate();
  const ix = new TransactionInstruction({
    programId: new PublicKey(new Uint8Array(32).fill(42)),
    keys: [],
    data: Buffer.from([7]),
  });
  let sendRaw: jest.SpyInstance;

  beforeEach(() => {
    sendRaw = jest.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue('beamSig');
  });
  afterEach(() => sendRaw.mockRestore());

  it('sends a treasury claim through Solami Beam on mainnet: tipped, simulated first, confirmed normally', async () => {
    const { connection, manager } = connections();
    const tipAccounts = new BeamTipAccounts(
      'https://api.solami.dev/onchain/tip-addresses',
      jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [TIP] }),
    );
    const beam = { url: 'https://rpc.solami.dev/sol?api_key=not-a-real-key', tipLamports: 100_000, tipAccounts };
    const chain = new RpcLaunchClaimChain(manager, 5_000, beam);
    await expect(chain.sendProgramClaim([ix], cranker, 200_000)).resolves.toBe('beamSig');
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendTransaction).not.toHaveBeenCalled();
    const tx = Transaction.from(sendRaw.mock.calls[0][0] as Buffer);
    const programs = tx.instructions.map((i) => i.programId.toBase58());
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      ix.programId.toBase58(),
      '11111111111111111111111111111111',
    ]);
    expect(tx.instructions[3].keys[1].pubkey.toBase58()).toBe(TIP);
    expect(tx.feePayer?.equals(cranker.publicKey)).toBe(true);
  });

  it('sends the normal way without a Beam route (devnet, or SOLAMI_BEAM_URL unset)', async () => {
    const { connection, manager } = connections();
    const chain = new RpcLaunchClaimChain(manager, 5_000);
    await expect(chain.sendProgramClaim([ix], cranker, 200_000)).resolves.toBe('directSig');
    expect(sendRaw).not.toHaveBeenCalled();
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
