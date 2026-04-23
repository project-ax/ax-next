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
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WireResponse = z.infer<typeof WireResponseSchema>;
