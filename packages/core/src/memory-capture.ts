import { z } from 'zod';

// ---------------------------------------------------------------------------
// `memory:pre-capture` (TASK-908). A memory plugin fires it before it learns
// anything from a conversation. Any plugin may veto, and that pass records
// nothing. The context carries who and what (`agentId`, `userId`, `source`);
// a subscriber decides from ids it owns and never parses a conversation id.
// Parsed leniently: an unknown key is dropped, never refused.
//
// The answer can name the speakers (TASK-1146). A subscriber that lets memory
// learn from the conversation, and labels the people speaking in its
// transcript by name, appends those names as `speakerNames`. Whatever a
// subscriber returns replaces the payload, so it returns the one it was given
// with its names added. It never removes a name an earlier subscriber added,
// not even to fit under MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX: past the cap it
// refuses instead, because a dropped name is one memory could file facts
// under. Memory reads the fire's final payload. In a turn that isn't private,
// it stores no statement whose subject is made of those names, except in a team
// agent's member turn, where it files the subject under the person the turn
// runs as. So a subscriber names only the people whose words the
// conversation's user turns carry. An answer with
// a known key that doesn't parse is one memory can't trust, so it learns
// nothing from it.
//
// The names are untrusted display text. Memory only compares words with them.
// It never logs them, and never puts them in an error message or a prompt.
// ---------------------------------------------------------------------------

export const MEMORY_PRE_CAPTURE_HOOK = 'memory:pre-capture';

/**
 * The most names one answer may carry in `speakerNames` (TASK-1146). An
 * answer with more doesn't parse. Bounded so the words memory compares every
 * subject with stay few, whoever supplied them.
 */
export const MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX = 32;

/**
 * The longest one speaker name may be, in UTF-16 code units (what a string's
 * `length` counts, so a character outside the Basic Multilingual Plane counts
 * twice). An answer with a longer name, or an empty one, doesn't parse.
 */
export const MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX = 256;

export const MemoryPreCapturePayloadSchema = z.object({
  conversationId: z.string().min(1),
  speakerNames: z
    .array(z.string().min(1).max(MEMORY_PRE_CAPTURE_SPEAKER_NAME_MAX))
    .max(MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX)
    .optional(),
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
