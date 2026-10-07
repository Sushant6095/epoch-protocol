import { Logger } from '@epoch/logger';

import {
  FakePublisherChain,
  feeIndex,
  indexBallot,
  indexOperators,
  key,
  MemoryIndexStore,
  REGISTRY,
} from '../__fixtures__/fakes';
import { type EpochOffset } from '../Index/EpochMapping';
import { IndexPublisher } from './IndexPublisher';

/** post_index data: discriminator, u64 epoch, u64 value, [u8;32] inputs_hash. */
function decodePostIndex(data: Buffer) {
  return {
    epoch: data.readBigUInt64LE(8),
    value: data.readBigUInt64LE(16),
    inputsHash: new Uint8Array(data.subarray(24, 56)),
  };
}

/** A FeeIndex whose last final value is mainnet epoch `m`'s row (posted as program epoch `p`). */
async function finalAt(store: MemoryIndexStore, m: number, p: bigint, value: bigint) {
  return feeIndex({ epoch: p, value, finalizedSlot: 5n, inputsHash: (await store.inputsHash(m)).hash });
}

describe('IndexPublisher', () => {
  let chain: FakePublisherChain;
  let store: MemoryIndexStore;
  let errors: jest.SpyInstance;
  const publisher = (offset: EpochOffset = 0) => new IndexPublisher(chain, store, { offset });
  const stops = () => errors.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('STOPPED'));

  beforeEach(() => {
    chain = new FakePublisherChain();
    store = new MemoryIndexStore();
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('first post: the newest finished epoch whose program epoch has started, then records the signature', async () => {
    store.add(97, 1_000).add(98, 1_010).add(99, 1_020).add(100, 1_030);
    chain.epoch = 99n; // mainnet 100 maps to program epoch 100, not started yet
    await publisher().tick();
    expect(chain.calls.map((c) => c.name)).toEqual(['post_index']);
    const posted = decodePostIndex(chain.calls[0].instruction.data);
    expect(posted).toEqual({ epoch: 99n, value: 1_020n, inputsHash: (await store.inputsHash(99)).hash });
    expect(chain.calls[0].role).toBe('publisher');
    expect(store.rows.get(99)?.postedSignature).toBe('sig:post_index 99 (mainnet 99)');
    expect(store.rows.get(97)?.postedSignature).toBeNull(); // history is not replayed
  });

  it('then posts the next mainnet epoch in order once the previous one is final', async () => {
    store.add(99, 1_000, 'sig99').add(100, 1_100).add(101, 1_150);
    chain.epoch = 102n;
    chain.feeIndexAccount = await finalAt(store, 99, 99n, 1_000n);
    await publisher().tick();
    expect(decodePostIndex(chain.calls[0].instruction.data)).toMatchObject({ epoch: 100n, value: 1_100n });
    expect(store.rows.get(100)?.postedSignature).toBe('sig:post_index 100 (mainnet 100)');
  });

  it('applies the epoch offset, and never posts a program epoch that has not started', async () => {
    store.add(1_046, 1_000, 'sig').add(1_047, 1_050);
    chain.feeIndexAccount = await finalAt(store, 1_046, 1_171n, 1_000n);
    chain.epoch = 1_171n; // mainnet 1047 + 125 = program 1172: not started
    await publisher(125).tick();
    expect(chain.calls).toEqual([]);
    chain.epoch = 1_172n;
    await publisher(125).tick();
    expect(decodePostIndex(chain.calls[0].instruction.data)).toMatchObject({ epoch: 1_172n, value: 1_050n });
  });

  it('auto mode posts the newest finished epoch under the program cluster epoch − 1, once per program epoch', async () => {
    store.add(1_045, 990, 'sig').add(1_046, 1_000).add(1_047, 1_010);
    chain.feeIndexAccount = await finalAt(store, 1_045, 1_172n, 990n);
    chain.epoch = 1_173n; // program 1172 already final
    await publisher('auto').tick();
    expect(chain.calls).toEqual([]);
    chain.epoch = 1_174n;
    await publisher('auto').tick();
    expect(decodePostIndex(chain.calls[0].instruction.data)).toMatchObject({ epoch: 1_173n, value: 1_010n });
    expect(store.rows.get(1_047)?.postedSignature).not.toBeNull();
    expect(store.rows.get(1_046)?.postedSignature).toBeNull(); // skipped: older than the newest
  });

  it('waits while a proposal is pending', async () => {
    store.add(99, 1_000, 'sig99').add(100, 1_100);
    chain.feeIndexAccount = {
      ...(await finalAt(store, 99, 99n, 1_000n)),
      hasProposal: true,
      proposedEpoch: 100n,
      proposedInputsHash: new Uint8Array(32).fill(1), // not ours
    };
    chain.epoch = 101n;
    await publisher().tick();
    expect(chain.calls).toEqual([]);
  });

  it('stops when the move from the last final value is beyond max_move_bps', async () => {
    store.add(99, 1_000, 'sig99').add(100, 1_201);
    chain.feeIndexAccount = await finalAt(store, 99, 99n, 1_000n); // 2,000 bps of 1,000 = 200
    chain.epoch = 101n;
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('IndexMoveTooLarge')]);

    store.rows.get(100)!.value = 1_200; // exactly at the bound: allowed
    await publisher().tick();
    expect(chain.calls.map((c) => c.name)).toEqual(['post_index']);
  });

  it('stops when its latest post is not the last final value (vetoed)', async () => {
    store.add(98, 1_000, 'sig98').add(99, 1_010, 'sig99').add(100, 1_020);
    chain.feeIndexAccount = await finalAt(store, 98, 98n, 1_000n); // 99 never became final
    chain.epoch = 101n;
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('vetoed')]);
  });

  it('records a post that landed without being recorded instead of posting it twice', async () => {
    store.add(99, 1_000, 'sig99').add(100, 1_100);
    const hash100 = (await store.inputsHash(100)).hash;
    chain.proposalSignatures.set(Buffer.from(hash100).toString('hex'), 'sigLanded');
    // Pending:
    chain.feeIndexAccount = {
      ...(await finalAt(store, 99, 99n, 1_000n)),
      hasProposal: true,
      proposedEpoch: 100n,
      proposedInputsHash: hash100,
    };
    chain.epoch = 101n;
    await publisher('auto').tick();
    expect(chain.calls).toEqual([]);
    expect(store.rows.get(100)?.postedSignature).toBe('sigLanded');

    // Already final (restart after the dispute window), auto mode one program epoch later: still no second post.
    store.rows.get(100)!.postedSignature = null;
    chain.feeIndexAccount = await finalAt(store, 100, 100n, 1_100n);
    chain.epoch = 102n;
    await publisher('auto').tick();
    expect(chain.calls).toEqual([]);
    expect(store.rows.get(100)?.postedSignature).toBe('sigLanded');
  });

  it('stops rather than double-posting when a landed post cannot be traced to its transaction', async () => {
    store.add(99, 1_000, 'sig99').add(100, 1_100);
    chain.feeIndexAccount = await finalAt(store, 100, 100n, 1_100n);
    chain.epoch = 102n;
    await publisher('auto').tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('posted_signature for that row by hand')]);
  });

  it('refuses an epoch without slot_fees rows, and a key that is not the FeeIndex publisher', async () => {
    store.add(99, 1_000, null, []);
    chain.epoch = 100n;
    await publisher().tick();
    expect(stops()).toEqual([expect.stringContaining('no slot_fees rows')]);

    chain.publisher = key(77);
    await publisher().tick();
    expect(stops()[1]).toContain('is not the FeeIndex publisher');
    expect(chain.calls).toEqual([]);
  });

  it('under DRY_RUN simulates and writes nothing', async () => {
    store.add(99, 1_000);
    chain.epoch = 100n;
    chain.dryRun = true;
    await publisher().tick();
    expect(chain.calls.map((c) => c.name)).toEqual(['post_index']);
    expect(store.rows.get(99)?.postedSignature).toBeNull();
  });

  it('does nothing without a publisher key or a FeeIndex', async () => {
    store.add(99, 1_000);
    chain.feeIndexAccount = null;
    await publisher().tick();
    chain.publisher = undefined;
    await publisher().tick();
    expect(chain.calls).toEqual([]);
  });
});

describe('IndexPublisher in consensus mode (the FeeIndex publisher is the operator registry)', () => {
  let chain: FakePublisherChain;
  let store: MemoryIndexStore;
  let errors: jest.SpyInstance;
  const publisher = () => new IndexPublisher(chain, store, { offset: 0 });
  const stops = () => errors.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('STOPPED'));
  const votes = () =>
    chain.calls.map((c) => ({ name: c.name, by: String(c.role), ...decodePostIndex(c.instruction.data) }));
  const hash = async (m: number) => (await store.inputsHash(m)).hash;

  beforeEach(async () => {
    chain = new FakePublisherChain();
    store = new MemoryIndexStore().add(98, 1_000, 'sig98').add(99, 1_004);
    chain.publisher = undefined;
    chain.operators = [key(60), key(61), key(99)]; // key(99) is not registered
    chain.registryAccount = indexOperators([1, 1, 1]);
    chain.feeIndexAccount = { ...(await finalAt(store, 98, 98n, 1_000n)), publisher: REGISTRY };
    chain.epoch = 100n;
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('every registered operator key votes the same value and hash; the first vote is recorded', async () => {
    await publisher().tick();
    const h = await hash(99);
    expect(votes()).toEqual([
      { name: 'cast_index_vote', by: key(60).toBase58(), epoch: 99n, value: 1_004n, inputsHash: h },
      { name: 'cast_index_vote', by: key(61).toBase58(), epoch: 99n, value: 1_004n, inputsHash: h },
    ]);
    expect(store.rows.get(99)?.postedSignature).toBe(`sig:cast_index_vote 99 (mainnet 99) by ${key(60).toBase58()}`);
    expect(stops()).toEqual([]);
  });

  it('waits while its ballot is voting, queued or proposed; nobody votes twice', async () => {
    store.rows.get(99)!.postedSignature = 'sigVote';
    const h = await hash(99);
    const voted = { voted: true, value: 1_004n, inputsHash: h };
    chain.ballotAccounts = [indexBallot(99n, chain.registryAccount!, {}, { 0: voted, 1: voted })];
    await publisher().tick();
    chain.ballotAccounts = [indexBallot(99n, chain.registryAccount!, { consensusSlot: 9n }, { 0: voted, 1: voted })];
    await publisher().tick();
    const proposed = { consensusSlot: 9n, proposedSlot: 9n };
    chain.ballotAccounts = [indexBallot(99n, chain.registryAccount!, proposed, { 0: voted, 1: voted })];
    chain.feeIndexAccount = { ...chain.feeIndexAccount!, hasProposal: true, proposedEpoch: 99n, proposedSlot: 9n };
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([]);
  });

  it('a key that missed its ballot (a crash between two votes) votes the same value and hash', async () => {
    store.rows.get(99)!.postedSignature = 'sigVote';
    const h = await hash(99);
    chain.ballotAccounts = [
      indexBallot(99n, chain.registryAccount!, {}, { 0: { voted: true, value: 1_004n, inputsHash: h } }),
    ];
    await publisher().tick();
    expect(votes()).toEqual([
      { name: 'cast_index_vote', by: key(61).toBase58(), epoch: 99n, value: 1_004n, inputsHash: h },
    ]);
    expect(store.rows.get(99)?.postedSignature).toBe('sigVote');
  });

  it('records a vote that landed without being recorded instead of voting twice, or stops if it cannot trace it', async () => {
    const h = await hash(99);
    chain.ballotAccounts = [
      indexBallot(99n, chain.registryAccount!, {}, { 0: { voted: true, value: 1_004n, inputsHash: h } }),
    ];
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('posted_signature for that row by hand')]);

    chain.voteSignatures.set(`${key(60).toBase58()}:${Buffer.from(h).toString('hex')}`, 'sigLanded');
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(store.rows.get(99)?.postedSignature).toBe('sigLanded');
  });

  it('stops at a vetoed proposal; once the admin re-opens the row, every key votes again (a new round)', async () => {
    store.rows.get(99)!.postedSignature = 'sigVote';
    const h = await hash(99);
    const voted = { voted: true, value: 1_004n, inputsHash: h };
    const vetoed = { consensusSlot: 9n, proposedSlot: 9n, consensusValue: 1_004n };
    chain.ballotAccounts = [indexBallot(99n, chain.registryAccount!, vetoed, { 0: voted, 1: voted })];
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('was vetoed')]);

    store.rows.get(99)!.postedSignature = null;
    await publisher().tick();
    expect(votes().map((v) => [v.by, v.epoch])).toEqual([
      [key(60).toBase58(), 99n],
      [key(61).toBase58(), 99n],
    ]);
  });

  it('a key registered after the round opened cannot vote in it: stops and points at reset_index_ballot', async () => {
    chain.operators = [key(62)];
    chain.ballotAccounts = [indexBallot(99n, indexOperators([1, 1]))];
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([expect.stringContaining('reset_index_ballot')]);
  });

  it('stops without operator keys, without registered keys, or without the legacy publisher key', async () => {
    chain.operators = [];
    chain.publisher = key(5);
    await publisher().tick();
    chain.publisher = undefined;
    chain.operators = [key(99)];
    await publisher().tick();
    chain.feeIndexAccount = { ...chain.feeIndexAccount!, publisher: key(5) };
    await publisher().tick();
    expect(chain.calls).toEqual([]);
    expect(stops()).toEqual([
      expect.stringContaining('INDEX_OPERATOR_KEYPAIR_PATHS'),
      expect.stringContaining('add_index_operator'),
      expect.stringContaining('operator consensus is off'),
    ]);
  });

  it('applies the same max_move_bps check as post_index, and under DRY_RUN records nothing', async () => {
    store.rows.get(99)!.value = 1_201;
    await publisher().tick();
    expect(stops()).toEqual([expect.stringContaining('max_move_bps')]);
    store.rows.get(99)!.value = 1_004;
    chain.dryRun = true;
    await publisher().tick();
    expect(chain.calls.map((c) => c.name)).toEqual(['cast_index_vote', 'cast_index_vote']);
    expect(store.rows.get(99)?.postedSignature).toBeNull();
  });
});
