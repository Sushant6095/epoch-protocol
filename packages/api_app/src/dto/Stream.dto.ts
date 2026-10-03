import { z } from '@epoch/common/pkg/zod';

const channels = z.array(z.string().max(32)).min(1).max(16);

/** WS /v1/stream client messages: `subscribe` / `unsubscribe` channels, or `ping`. */
export const StreamClientMessageDto = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), channels }),
  z.object({ op: z.literal('unsubscribe'), channels }),
  z.object({ op: z.literal('ping') }),
]);

export type StreamClientMessage = z.infer<typeof StreamClientMessageDto>;
