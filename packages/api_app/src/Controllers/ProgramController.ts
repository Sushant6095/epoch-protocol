import type { Request, Response } from '@epoch/common_http_server';

import type { AddressParams, VoteParams } from '../dto/Program.dto';
import { currentSession } from '../Lib/Session';
import { getProgramServices } from '../Services/Program/ProgramServices';
import type {
  FeeMarketSnapshot,
  LenderPositionSnapshot,
  OnChainHistorySnapshot,
  OperatorPositionSnapshot,
  VaultSnapshot,
} from '../types/Program.types';

/**
 * The Epoch program on its own cluster (devnet for now): the Vault, a validator's Manage tab, a wallet's lender
 * position and the Fee Market. 503 PROGRAM_NOT_CONFIGURED / POOL_NOT_INITIALIZED until the program and its Pool exist
 * (except the not-onboarded estimate, which answers from mainnet data and the planned parameters).
 */
export class ProgramController {
  /** GET /v1/vault — session optional (`withdrawQueue[].isMine`, the "You" lender row). */
  static async vault(_req: Request, res: Response): Promise<VaultSnapshot> {
    res.setHeader('cache-control', 'private, max-age=5');
    return getProgramServices().vault.snapshot(currentSession(res)?.address);
  }

  /** GET /v1/validators/:vote/position */
  static async position(_req: Request, res: Response): Promise<OperatorPositionSnapshot> {
    const { vote } = res.locals.params as VoteParams;
    res.setHeader('cache-control', 'public, max-age=10');
    return getProgramServices().positions.position(vote);
  }

  /** GET /v1/validators/:vote/history — the on-chain ValidatorHistory with its freshness. */
  static async history(_req: Request, res: Response): Promise<OnChainHistorySnapshot> {
    const { vote } = res.locals.params as VoteParams;
    res.setHeader('cache-control', 'public, max-age=10');
    return getProgramServices().validatorHistory.history(vote);
  }

  /** GET /v1/wallets/:address/lender */
  static async lender(_req: Request, res: Response): Promise<LenderPositionSnapshot> {
    const { address } = res.locals.params as AddressParams;
    res.setHeader('cache-control', 'private, max-age=5');
    return getProgramServices().lenders.lender(address);
  }

  /** GET /v1/market — session optional (`myHedge`, `myPositions`, "You" in recent swaps). */
  static async market(_req: Request, res: Response): Promise<FeeMarketSnapshot> {
    res.setHeader('cache-control', 'private, max-age=5');
    return getProgramServices().market.snapshot(currentSession(res)?.address);
  }
}
