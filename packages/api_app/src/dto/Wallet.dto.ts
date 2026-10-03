import { z } from '@epoch/common/pkg/zod';

import { isAddress } from '../Lib/Address';

const address = z.string().refine(isAddress, { message: 'not a Solana address (base58, 32 bytes)' });

/** GET /v1/validators/:vote */
export const VoteParamsDto = z.object({ vote: address });
export type VoteParams = z.infer<typeof VoteParamsDto>;

/** GET /v1/wallets/:address/stake */
export const WalletParamsDto = z.object({ address });
export type WalletParams = z.infer<typeof WalletParamsDto>;
