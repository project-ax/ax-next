import { z } from 'zod';

// ---------------------------------------------------------------------------
// `memory:pre-capture` (TASK-908). A memory plugin fires it before it learns
// anything from a conversation. Any plugin may veto, and that pass records
// nothing. The context carries who and what (`agentId`, `userId`, `source`);
// a subscriber decides from ids it owns and never parses a conversation id.
// Parsed leniently: an unknown key is dropped, never refused.
// ---------------------------------------------------------------------------

export const MEMORY_PRE_CAPTURE_HOOK = 'memory:pre-capture';

export const MemoryPreCapturePayloadSchema = z.object({
  conversationId: z.string().min(1),
});

export type MemoryPreCapturePayload = z.infer<typeof MemoryPreCapturePayloadSchema>;

/**
 * How long each `memory:pre-capture` subscriber may take to answer. A memory
 * plugin fires the event with this bound, and the bus skips a subscriber past
 * it, so a veto that arrives late doesn't count and the pass is captured. A
 * subscriber that must fail closed answers well inside it (`@ax/routines`
 * derives its own deadline from this). One definition here, because the
 * producer and its subscribers may not import each other (invariant 2).
 */
export const MEMORY_PRE_CAPTURE_SUBSCRIBER_TIMEOUT_MS = 10_000;
