import type { Request, Response } from '@epoch/common_http_server';

import type { WalletParams } from '../dto/Wallet.dto';
import { getServices } from '../Services';
import type { MyStake } from '../types/Wallet.types';

/** A wallet's stake on mainnet (requests #10, #10b). Public chain data: any address can be viewed read-only. */
export class WalletController {
  /** GET /v1/wallets/:address/stake */
  static async stake(_req: Request, res: Response): Promise<MyStake> {
    const { address } = res.locals.params as WalletParams;
    const stake = await getServices().wallets.get(address);
    res.setHeader('cache-control', 'public, max-age=30');
    return stake;
  }
}
