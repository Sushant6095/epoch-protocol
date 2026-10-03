import { JsonRpcClient } from '../../Lib/Http';
import { MainnetSlotSource } from '../../Sources/MainnetSlotSource';
import { EMPTY_NAMES, nameIndex, type NamedValidator, ValidatorNames } from './ValidatorNames';

const ROWS: NamedValidator[] = [
  { name: 'Kestrel Nodes', vote: 'vote-k', identity: 'id-k' },
  { name: 'Lumen Labs', vote: 'vote-l', identity: 'id-l' },
];

describe('ValidatorNames', () => {
  it('indexes names by vote and identity, once per table, and asks the table again only after refreshMs', async () => {
    let now = 0;
    const rows = jest.fn(async () => ROWS);
    const names = new ValidatorNames(rows, 1_500, 300_000, () => now);
    const first = await names.get();
    expect(first.byVote.get('vote-l')).toBe('Lumen Labs');
    expect(first.byIdentity.get('id-k')).toBe('Kestrel Nodes');
    now = 299_999;
    expect(await names.get()).toBe(first);
    expect(rows).toHaveBeenCalledTimes(1);
    now = 300_000;
    expect(await names.get()).toBe(first); // same table: same index
    expect(rows).toHaveBeenCalledTimes(2);
  });

  it('answers with the last names (or none) while a cold table is still loading or failing', async () => {
    let release!: (rows: NamedValidator[]) => void;
    const slow = new ValidatorNames(() => new Promise<NamedValidator[]>((resolve) => (release = resolve)), 20);
    expect(await slow.get()).toBe(EMPTY_NAMES);
    release(ROWS);
    expect((await slow.get()).byVote.size).toBe(2);

    const rows = jest.fn().mockResolvedValueOnce(ROWS).mockRejectedValue(new Error('RPC down'));
    const failing = new ValidatorNames(rows, 1_500, 0);
    const loaded = await failing.get();
    expect(await failing.get()).toBe(loaded);
    expect(rows).toHaveBeenCalledTimes(2);
    expect(nameIndex([]).byVote.size).toBe(0);
  });
});

describe('MainnetSlotSource', () => {
  it('reads the epoch through the shared data source and the leaders over JSON-RPC', async () => {
    const info = { epoch: 870, slotIndex: 5, slotsInEpoch: 432_000, absoluteSlot: 375_840_005 };
    const seen: unknown[] = [];
    const rpc = new JsonRpcClient(['https://rpc.invalid']);
    const call = jest.spyOn(rpc, 'call').mockResolvedValue(['leader-a', 'leader-b']);
    const source = new MainnetSlotSource({ getEpochInfo: async () => info }, rpc, (i) => seen.push(i));
    expect(await source.getEpochInfo()).toBe(info);
    expect(seen).toEqual([info]);
    expect(await source.getSlotLeaders(375_840_005, 100)).toEqual(['leader-a', 'leader-b']);
    expect(call).toHaveBeenCalledWith('getSlotLeaders', [375_840_005, 100], 10_000);
  });
});
