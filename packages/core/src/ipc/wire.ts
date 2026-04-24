import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Action = z.string().min(1).max(128);

export const WireRequestSchema = z.object({
  id: Id,
  action: Action,
  payload: z.unknown(),
});

export const WireResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: Id, ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: Id,
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WireResponse = z.infer<typeof WireResponseSchema>;
