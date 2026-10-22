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
