// Wire message schemas for IPC between the host and subprocess sandbox.
//
// These schemas validate the envelope (id / action / ok) only. Per-action
// schemas validate the inner `payload` / `result` shapes, and the total byte
// size of a single message is bounded by the framing layer (see framing.ts,
// MAX_FRAME) — there's no length cap here.
import { z } from 'zod';

export const WireRequestSchema = z.object({
  id: z.string().min(1).max(64),
  action: z.string().min(1).max(128),
  payload: z.unknown(),
});
export const WireResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string().min(1).max(64), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string().min(1).max(64),
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(64),
      message: z.string().max(4096),
    }),
  }),
]);
export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WireResponse = z.infer<typeof WireResponseSchema>;
