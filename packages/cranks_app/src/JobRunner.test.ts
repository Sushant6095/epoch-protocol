import { Logger } from '@epoch/logger';
import { PublicKey } from '@solana/web3.js';

import { pool, position, SOL, withdrawRequest } from './__fixtures__/accounts';
import { atAddress, FakeChain } from './__fixtures__/FakeChain';
import jitoClaims from './__fixtures__/jito-claims.json';
import { type Job, type JobOutcome } from './Jobs';
import { JobRunner } from './JobRunner';

/** A job that records its runs and answers from a script (default: done). */
class ScriptedJob implements Job {
  runs: bigint[] = [];
  constructor(
    readonly name: string,
    private readonly log: string[],
    public answer: (epoch: bigint, run: number) => JobOutcome | Error = () => 'done',
  ) {}
  async run(epoch: bigint): Promise<JobOutcome> {
    this.runs.push(epoch);
    this.log.push(this.name);
    const answer = this.answer(epoch, this.runs.length);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

function setup() {
  const log: string[] = [];
  const job = (name: string) => new ScriptedJob(name, log);
  const jobs = {
    claim: job('claim'),
    score: job('score'),
    sweep: job('sweep'),
    markDefault: job('markDefault'),
    accrue: job('accrue'),
    withdrawals: job('withdrawals'),
    finalize: job('finalize'),
    settle: job('settle'),
  };
  let epoch = 100n;
  let now = 0;
  const runner = new JobRunner(
    async () => epoch,
    [
      { job: jobs.claim, gate: false },
      { job: jobs.score, gate: false },
      { job: jobs.sweep, gate: true },
      { job: jobs.markDefault, gate: true },
      { job: jobs.accrue, gate: true },
    ],
    [jobs.withdrawals],
    [jobs.finalize, jobs.settle],
    { pollMs: 60_000, alertAfterMs: 60 * 60_000, now: () => now },
  );
  return {
    runner,
    jobs,
    log,
    setEpoch: (e: bigint) => (epoch = e),
    advance: (ms: number) => (now += ms),
  };
}

describe('JobRunner', () => {
  it('runs the boundary in program order, then withdrawals, then the pollers', async () => {
    const { runner, log } = setup();
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'sweep', 'markDefault', 'accrue', 'withdrawals', 'finalize', 'settle']);
  });

  it('runs each boundary job once per epoch, but withdrawals and pollers on every tick', async () => {
    const { runner, log, setEpoch } = setup();
    await runner.tick();
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['withdrawals', 'finalize', 'settle']);

    log.length = 0;
    setEpoch(101n);
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'sweep', 'markDefault', 'accrue', 'withdrawals', 'finalize', 'settle']);
  });

  it('holds later steps while a gate is waiting (epoch rewards), but never the pollers', async () => {
    const { runner, jobs, log } = setup();
    jobs.sweep.answer = (_e, run) => (run < 3 ? 'retry' : 'done');
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'sweep', 'finalize', 'settle']);
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['sweep', 'finalize', 'settle']);
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['sweep', 'markDefault', 'accrue', 'withdrawals', 'finalize', 'settle']);
    expect(runner.doneSteps()).toEqual(['claim', 'score', 'sweep', 'markDefault', 'accrue']);
  });

  it('does not let the score or claim steps block the sweep', async () => {
    const { runner, jobs, log } = setup();
    jobs.score.answer = () => 'retry';
    jobs.claim.answer = () => new Error('boom');
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'sweep', 'markDefault', 'accrue', 'withdrawals', 'finalize', 'settle']);
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'withdrawals', 'finalize', 'settle']);
  });

  it('treats a throwing job as retry and keeps going', async () => {
    const { runner, jobs, log } = setup();
    jobs.markDefault.answer = (_e, run) => (run === 1 ? new Error('RPC down') : 'done');
    await runner.tick();
    expect(log).toEqual(['claim', 'score', 'sweep', 'markDefault', 'finalize', 'settle']);
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['markDefault', 'accrue', 'withdrawals', 'finalize', 'settle']);
  });

  it('logs one alert per gate still unfinished after alertAfterMs', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { runner, jobs, advance } = setup();
    jobs.sweep.answer = () => 'retry';
    await runner.tick();
    advance(59 * 60_000);
    await runner.tick();
    expect(errors).not.toHaveBeenCalled();
    advance(2 * 60_000);
    await runner.tick();
    await runner.tick();
    const alerts = errors.mock.calls.filter(([m]) => String(m).startsWith('ALERT'));
    expect(alerts.map(([, , meta]) => (meta as { job: string }).job)).toEqual(['sweep', 'markDefault', 'accrue']);
    errors.mockRestore();
  });

  it('survives a failing epoch read and stops cleanly', async () => {
    const log: string[] = [];
    const job = new ScriptedJob('only', log);
    let calls = 0;
    const runner = new JobRunner(
      async () => {
        calls++;
        if (calls === 1) throw new Error('RPC down');
        return 7n;
      },
      [{ job, gate: true }],
      [],
      [],
      { pollMs: 1, alertAfterMs: 1_000, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) },
    );
    await runner.tick();
    expect(log).toEqual([]);
    const stop = runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stop();
    expect(log[0]).toBe('only');
    expect(job.runs.every((e) => e === 7n)).toBe(true);
  });
});

describe('JobRunner.create', () => {
  it("holds the sweep on the MEV claim gate, never the scorer, and leaves alerting to the gate's own bounded wait", async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    const [score, claim, sweep] = ['score', 'claim', 'sweep'].map((name) => new ScriptedJob(name, log));
    let now = 0;
    const runner = new JobRunner(
      async () => 100n,
      [
        { job: score, gate: false },
        { job: claim, gate: true, alert: false },
        { job: sweep, gate: true },
      ],
      [],
      [],
      { pollMs: 60_000, alertAfterMs: 60 * 60_000, now: () => now },
    );
    claim.answer = () => 'retry';
    await runner.tick();
    expect(log).toEqual(['score', 'claim']);
    now += 2 * 60 * 60_000;
    await runner.tick();
    expect(errors.mock.calls.filter(([m]) => String(m).startsWith('ALERT'))).toEqual([
      expect.arrayContaining([expect.objectContaining({ job: 'sweep' })]),
    ]);
    claim.answer = () => 'done';
    log.length = 0;
    await runner.tick();
    expect(log).toEqual(['claim', 'sweep']);
    errors.mockRestore();
  });

  it('wires every job on one chain, in the program order', async () => {
    const chain = new FakeChain();
    chain.scorer = undefined; // scores off
    chain.positionAccounts = [atAddress(position({ lastSweptEpoch: 99n }), 120)];
    chain.poolAccount = pool({ lastAccruedEpoch: 99n, withdrawHead: 0n, withdrawTail: 1n, cash: 10n * SOL });
    chain.requests.set(0n, withdrawRequest({ shares: SOL * 1_000n }));
    chain.onExecute = (call) => {
      if (call.name === 'process_withdrawal') chain.poolAccount = { ...chain.poolAccount!, withdrawHead: 1n };
      return { status: 'sent', signature: call.label };
    };
    const data = {
      voters: jest.fn(),
      voteStates: jest.fn(),
      mevCommissions: jest.fn(),
    };
    const runner = JobRunner.create(chain, data, [], { pollMs: 60_000, alertAfterMs: 3_600_000 });
    await runner.tick();
    expect(chain.executed()).toEqual(['sweep', 'accrue', 'process_withdrawal']);
    expect(data.voters).not.toHaveBeenCalled();
    // History first (it scores validators from the chain), then the scorer for the rest, then the bounded MEV claim
    // gate, the first step that can block, then closing settled Fee Index ballots, the sweep and the steps after it.
    expect(runner.doneSteps()).toEqual([
      'HistoryJob',
      'UpdateScoreJob',
      'ClaimMevJob',
      'CloseBallotsJob',
      'SweepJob',
      'MarkDefaultJob',
      'AccrueJob',
    ]);
  });

  it("finishes history and scores before Jito's MEV claim gate, which then holds the sweep until the claim lands", async () => {
    // Real mainnet accounts: a 700-bps validator's epoch 1050 TDA with its merkle root, and its claimed commission node.
    const { tda700, claimStatus700 } = jitoClaims.accounts;
    const chain = new FakeChain();
    chain.epoch = 1051n;
    chain.scorer = undefined; // scores off
    chain.positionAccounts = [
      atAddress(position({ vote: new PublicKey(tda700.vote), status: 'active', lastSweptEpoch: 1050n }), 120),
    ];
    chain.poolAccount = pool({ lastAccruedEpoch: 1050n });
    chain.accountData.set(tda700.address, Buffer.from(tda700.data, 'base64'));
    const data = { voters: jest.fn(), voteStates: jest.fn(), mevCommissions: jest.fn() };
    const runner = JobRunner.create(chain, data, [], { pollMs: 60_000, alertAfterMs: 3_600_000 });

    // Not claimed yet: history and the scorer are done for the epoch (they never wait on Jito), the sweep waits.
    await runner.tick();
    expect(runner.doneSteps()).toEqual(['HistoryJob', 'UpdateScoreJob']);
    expect(chain.executed()).toEqual([]);

    // Jito's crank claims the commission node into the vote account: the gate opens and the sweep collects it.
    chain.accountData.set(claimStatus700.address, Buffer.from(claimStatus700.data, 'base64'));
    await runner.tick();
    expect(runner.doneSteps()).toEqual([
      'HistoryJob',
      'UpdateScoreJob',
      'ClaimMevJob',
      'CloseBallotsJob',
      'SweepJob',
      'MarkDefaultJob',
      'AccrueJob',
    ]);
    expect(chain.executed()).toEqual(['sweep', 'accrue']);
  });
});
