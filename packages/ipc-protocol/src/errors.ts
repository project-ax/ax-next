import { z } from 'zod';

/**
 * The closed set of error codes emitted by any host IPC handler.
 *
 * A regression guard in schemas.test.ts asserts this set exactly —
 * adding or removing a code is a protocol change and must be done
 * with intent.
 */
export const IpcErrorCodeSchema = z.enum([
  'SESSION_INVALID',
  'HOST_UNAVAILABLE',
  'VALIDATION',
  'HOOK_REJECTED',
  'NOT_FOUND',
  'INTERNAL',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

/** Inner error body — carried inside the envelope below. */
export const IpcErrorSchema = z.object({
  code: IpcErrorCodeSchema,
  message: z.string(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

/**
 * Wire envelope for an error response. `.strict()` so unknown top-level
 * keys are rejected: the envelope shape is frozen (extensions go inside
 * `error`, not next to it) and any drift is a protocol bug we want the
 * decoder to surface loudly.
 */
export const IpcErrorEnvelopeSchema = z
  .object({
    error: IpcErrorSchema,
  })
  .strict();
export type IpcErrorEnvelope = z.infer<typeof IpcErrorEnvelopeSchema>;
