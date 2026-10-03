import type { Request, Response } from '@epoch/common_http_server';

import type { VoteParams } from '../dto/Wallet.dto';
import { getServices } from '../Services';
import type { ValidatorProfile } from '../types/Wallet.types';

/** One validator's public profile (request #5). No sign-in. */
export class ValidatorProfileController {
  /** GET /v1/validators/:vote */
  static async profile(_req: Request, res: Response): Promise<ValidatorProfile> {
    const { vote } = res.locals.params as VoteParams;
    const profile = await getServices().profiles.get(vote);
    res.setHeader('cache-control', 'public, max-age=60');
    return profile;
  }
}
