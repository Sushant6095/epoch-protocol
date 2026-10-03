import { type PoolAccount, sharesToAssets, type Tranche } from '@epoch/epoch-sdk';

import { isoIst } from '../../Lib/Stats';
import { type LenderPosition, type LenderPositionSnapshot } from '../../types/Program.types';
import { big, payload, toSol, uiShares } from './ProgramFormat';
import { eventEpoch, type ProgramServiceDeps } from './ProgramSources';
import { requestEventsBySeq } from './WithdrawEvents';

/** A request bounced at the junior floor stays on the card this many program epochs (decision 20). */
const BOUNCED_WINDOW_EPOCHS = 30;

const valueOf = (pool: PoolAccount, tranche: Tranche, shares: bigint): bigint =>
  tranche === 'senior'
    ? sharesToAssets(shares, pool.seniorAssets, pool.seniorShares)
    : sharesToAssets(shares, pool.juniorAssets, pool.juniorShares);

/** `GET /v1/wallets/:address/lender` (request #8d): the Vault's Withdraw tab and the My Stake Lend card. */
export class LenderPositionService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async lender(owner: string): Promise<LenderPositionSnapshot> {
    const { program, events } = this.deps;
    const { address: poolAddress, account: pool } = await program.requirePool();
    const [info, accounts, requests, cancelled] = await Promise.all([
      program.epochInfo(),
      program.lenderAccounts(owner),
      program.withdrawRequests(),
      events.query({ names: ['WithdrawCancelled'], where: { pool: poolAddress, owner, reason: '1' }, limit: 500 }),
    ]);
    const epoch = info.epoch;

    const tranches: LenderPosition['tranches'] = [];
    for (const tranche of ['senior', 'junior'] as const) {
      const lender = accounts[tranche]?.account;
      if (!lender) continue;
      const unlock = Number(lender.lastDepositEpoch) + pool.params.juniorLockEpochs;
      tranches.push({
        tranche,
        shares: uiShares(lender.shares),
        valueSol: toSol(valueOf(pool, tranche, lender.shares)),
        depositEpoch: Number(lender.lastDepositEpoch),
        lockedUntilEpoch: tranche === 'junior' && unlock > epoch ? unlock : null,
      });
    }

    const queued = requests.filter((r) => r.account.owner.toBase58() === owner && !r.account.cancelled);
    const bounced = (
      await Promise.all(cancelled.map(async (event) => ({ event, at: await eventEpoch(program, event) })))
    ).filter((b) => b.at >= epoch - BOUNCED_WINDOW_EPOCHS);
    const requested = await requestEventsBySeq(
      events,
      [
        ...queued.map((r) => r.account.seq.toString()),
        ...bounced.map((b) => String(payload(b.event, 'WithdrawCancelled').seq)),
      ],
      { pool: poolAddress, owner },
    );

    const withdrawRequests: LenderPosition['withdrawRequests'] = queued.map((r) => ({
      id: Number(r.account.seq),
      tranche: r.account.tranche,
      shares: uiShares(r.account.shares),
      sol: toSol(valueOf(pool, r.account.tranche, r.account.shares)),
      askedEpoch: Number(r.account.requestedEpoch),
      signature: requested.get(r.account.seq.toString())?.signature ?? null,
      status: 'queued',
    }));
    for (const { event } of bounced) {
      const seq = String(payload(event, 'WithdrawCancelled').seq);
      const request = requested.get(seq);
      // The bounce event carries no shares or tranche: without the request event there is nothing true to show.
      if (!request) continue;
      const fields = payload(request, 'WithdrawRequested');
      const tranche = fields.tranche as Tranche;
      const shares = big(fields.shares);
      withdrawRequests.push({
        id: Number(seq),
        tranche,
        shares: uiShares(shares),
        sol: toSol(valueOf(pool, tranche, shares)),
        askedEpoch: await eventEpoch(program, request),
        signature: request.signature,
        status: 'bounced',
      });
    }
    withdrawRequests.sort((a, b) => b.id - a.id);

    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(this.deps.now?.()),
      source: `Epoch program on ${program.cluster}: LenderShares and WithdrawRequest accounts and withdrawal events`,
      owner,
      tranches,
      withdrawRequests,
    };
  }
}
