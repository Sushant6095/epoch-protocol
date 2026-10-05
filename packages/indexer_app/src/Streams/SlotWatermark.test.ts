import { isAuthRefused, isFirehoseRefused, isRequestRefused, replayFrom, slotStreamRequest } from './SlotRequest';
import { SlotWatermark } from './SlotWatermark';

describe('SlotWatermark', () => {
  it('advances only through a contiguous run and lists the gaps above it', () => {
    const mark = new SlotWatermark(100);
    expect(mark.watermark).toBe(99);
    expect(mark.markDone(101)).toBe(false);
    expect(mark.markDone(103)).toBe(false);
    expect(mark.missing(105, 10)).toEqual([100, 102, 104, 105]);
    expect(mark.markDone(100)).toBe(true);
    expect(mark.watermark).toBe(101);
    expect(mark.markRange(102, 104)).toBe(true);
    expect(mark.watermark).toBe(104);
    expect(mark.pendingAbove).toBe(0);
    expect(mark.highestDone).toBe(104);
  });

  it('ignores slots before the run and slots already done', () => {
    const mark = new SlotWatermark(100, 110);
    expect(mark.markDone(50)).toBe(false);
    expect(mark.markDone(105)).toBe(false);
    expect(mark.isDone(105)).toBe(true);
    expect(mark.isDone(111)).toBe(false);
    expect(mark.missing(115, 2)).toEqual([111, 112]);
  });

  it('knows when an epoch is fully covered', () => {
    const mark = new SlotWatermark(64, 95);
    expect(mark.covers(64, 95)).toBe(true);
    expect(mark.covers(32, 63)).toBe(false);
    expect(mark.covers(96, 127)).toBe(false);
  });
});

describe('SlotRequest', () => {
  it('builds the firehose and the meta-only request at confirmed commitment', () => {
    const firehose = slotStreamRequest('firehose', 123);
    expect(firehose).toMatchObject({
      transactions: { fees: { vote: false, accountInclude: [], accountExclude: [], accountRequired: [] } },
      blocksMeta: { blocks: {} },
      slots: { tip: { filterByCommitment: false, interslotUpdates: false } },
      blocks: {},
      accounts: {},
      entry: {},
      commitment: 1,
      fromSlot: '123',
    });
    // Failed transactions stay in: `failed` is left unset (both).
    expect(firehose.transactions.fees.failed).toBeUndefined();
    const meta = slotStreamRequest('meta');
    expect(meta.transactions).toEqual({});
    expect(meta.fromSlot).toBeUndefined();
  });

  it('replays from the cursor only inside the endpoint’s window and not past the tip', () => {
    expect(replayFrom(500, 400, 600)).toBe(500);
    expect(replayFrom(399, 400, 600)).toBeUndefined();
    expect(replayFrom(601, 400, 600)).toBeUndefined();
    expect(replayFrom(500, undefined, 600)).toBeUndefined();
    expect(replayFrom(undefined, 400, 600)).toBeUndefined();
  });

  it('reads the gRPC status from the native client’s cause chain (as recorded from grpc.solami.dev)', () => {
    // What @triton-one/yellowstone-grpc 7 throws for a bad key: a generic message, the status in `cause`.
    const recorded = Object.assign(new Error('failed to open subscribe stream'), {
      code: 'GenericFailure',
      cause: Object.assign(
        new Error(
          `gRPC status: code: 'The request does not have valid authentication credentials', message: "invalid api key"`,
        ),
        {
          cause: new Error(
            `code: 'The request does not have valid authentication credentials', message: "invalid api key"`,
          ),
        },
      ),
    });
    expect(isAuthRefused(recorded)).toBe(true);
    expect(isFirehoseRefused(recorded)).toBe(false);
    const firehose = Object.assign(new Error('failed to open subscribe stream'), {
      cause: new Error(
        `gRPC status: code: 'The caller does not have permission to execute the specified operation', message: "unfiltered/firehose subscriptions are not allowed on non-PAYG streams"`,
      ),
    });
    expect(isFirehoseRefused(firehose)).toBe(true);
    expect(isAuthRefused(firehose)).toBe(false);
  });

  it('recognises Solami’s refusals (which retrying cannot fix)', () => {
    const firehose = new Error(
      'status: PermissionDenied, message: "unfiltered/firehose subscriptions are not allowed on non-PAYG streams; narrow your filters, enable PAYG, or request the firehose allowance"',
    );
    expect(isFirehoseRefused(firehose)).toBe(true);
    expect(isRequestRefused(firehose)).toBe(true);
    expect(isAuthRefused(new Error('status: Unauthenticated, message: "invalid api key"'))).toBe(true);
    expect(isAuthRefused(new Error('status: PermissionDenied, message: "this key does not have gRPC access"'))).toBe(
      true,
    );
    expect(isRequestRefused(new Error('too many filters in subscribe request: 40 (max 25)'))).toBe(true);
    expect(isRequestRefused(new Error('status: Unavailable, message: "session expired, please reconnect"'))).toBe(
      false,
    );
    expect(
      isRequestRefused(new Error('status: ResourceExhausted, message: "stream backpressure: client too slow"')),
    ).toBe(false);
  });
});
