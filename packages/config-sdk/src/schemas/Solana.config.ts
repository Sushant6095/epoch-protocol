import { z } from '@epoch/common/pkg/zod';

export const SolanaConfigSchema = z.object({
  RPC_URL: z.string().url(),
  RPC_FALLBACK_URL: z.string().url().optional(),
  EPOCH_PROGRAM_ID: z.string().min(32).optional(),
});

export const GrpcConfigSchema = z.object({
  SOLAMI_GRPC_URL: z.string().min(1),
  SOLAMI_TOKEN: z.string().optional(),
  RPC_FAST_GRPC_URL: z.string().optional(),
  RPC_FAST_TOKEN: z.string().optional(),
});
