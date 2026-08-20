// ---------------------------------------------------------------------------
// The aisdk runner's transcript serialization (design §5).
//
// Newline-delimited JSON. Line 0 is a HEADER; every later line is one
// transcript entry wrapping one AI SDK `ModelMessage`.
//
//   {"v":1,"runner":"aisdk"}
//   {"role":"user","uuid":"…","message":{"role":"user","content":"hi"}}
//   {"role":"assistant","uuid":"…","message":{"role":"assistant","content":[…]}}
//   {"role":"tool","uuid":"…","message":{"role":"tool","content":[…]}}
//
// Line-oriented because the host's delta protocol is seq-based (`fromSeq`,
// `maxSeq`, `prefixHash`) and advances `sentOffset` to complete-line
// boundaries. One entry per line, always — a message must NEVER serialize
// across two lines, which is why nothing here pretty-prints.
//
// WHY THE ENVELOPE, when the design says "one ModelMessage per line": two
// host-side functions in @ax/conversations read stored transcript lines
// generically, and a bare `{role, content}` ModelMessage is invisible to both.
//
//   - `dropTurnFromJsonl` (backing `conversations:drop-turn`, which @ax/routines
//     uses to drop a silence-token turn) locates the line to remove by its
//     TOP-LEVEL `uuid`. Without one, drop-turn matches nothing and silently
//     no-ops. Hence `uuid` — which is also what the turn-end `turnId` refers to.
//   - `roleOfJsonlLine` (the B3 display/resume divergence detector) needs the
//     line's DISPLAY ROLE. Without one it returns null for every line and the
//     detector goes blind on this runner. Hence `role`, in the host's own
//     `TurnRole` vocabulary — not ours, not the SDK's.
//
// The host reads `role` when present and falls back to its legacy SDK-shape
// sniffing otherwise, so both runners work.
//
// A NOTE ON `raw`: entries restored from the host store keep the EXACT line
// bytes they were stored as. `encodeTranscript` re-emits those verbatim rather
// than re-serializing the parsed message. That is what keeps the resumed
// session's `prefixHash` matching the host's stored bytes — re-serializing
// would drop any field zod stripped and silently force a whole-file resync on
// every single resume.
// ---------------------------------------------------------------------------

import { modelMessageSchema, type ModelMessage } from 'ai';

/** Bumped only on an incompatible change to the line shape. */
export const TRANSCRIPT_VERSION = 1;
/** Identifies which runner wrote the transcript. The cross-runner detector. */
export const TRANSCRIPT_RUNNER = 'aisdk';

/**
 * The display role of a transcript entry, in the host's vocabulary
 * (`TurnRole` in @ax/conversations). Derived from the message's own role;
 * `system` is carried for completeness but is not a display turn.
 */
export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export interface TranscriptEntry {
  /** Stable per-entry id. Surfaces as `turnId` on `event.turn-end`. */
  uuid: string;
  role: TranscriptRole;
  message: ModelMessage;
  /**
   * The exact line this entry was stored as, when it came from the host store.
   * Re-emitted verbatim so the shipped prefix stays byte-stable. Absent for
   * entries this process created (they serialize fresh).
   */
  raw?: string;
}

export type DecodeResult =
  | { ok: true; headerRaw: string; entries: TranscriptEntry[] }
  | { ok: false; reason: string };

function encodeEntry(entry: TranscriptEntry): string {
  if (entry.raw !== undefined) return entry.raw;
  return JSON.stringify({
    role: entry.role,
    uuid: entry.uuid,
    message: entry.message,
  });
}

export function headerLine(): string {
  return JSON.stringify({ v: TRANSCRIPT_VERSION, runner: TRANSCRIPT_RUNNER });
}

/**
 * Serialize the transcript. `headerRaw` lets a resumed session re-emit the
 * header it was stored with, byte for byte (see the `raw` note above).
 */
export function encodeTranscript(
  entries: readonly TranscriptEntry[],
  headerRaw: string = headerLine(),
): Buffer {
  const lines = [headerRaw, ...entries.map(encodeEntry)];
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const ROLES = new Set<TranscriptRole>(['user', 'assistant', 'tool', 'system']);

/**
 * Parse stored transcript bytes.
 *
 * Untrusted-input posture: these bytes come back from the host store and may
 * have been written by the OTHER runner, truncated, or rewritten by a
 * `conversations:drop-turn`. Nothing here throws — every failure is a clean
 * `{ ok: false, reason }` that the caller turns into "no resumable transcript".
 *
 * ALL-OR-NOTHING on purpose. A tempting alternative is to truncate at the
 * first bad line and keep the prefix, but a transcript can end mid-tool-call:
 * a dangling `tool-call` with no matching `tool-result` makes the provider
 * reject the very next request. Losing history is recoverable (the user
 * re-states, and the runner-neutral display log still renders the whole
 * conversation); a transcript that 400s every turn is not.
 */
export function decodeTranscript(bytes: Buffer): DecodeResult {
  const text = bytes.toString('utf8');
  if (text.trim().length === 0) return { ok: false, reason: 'empty transcript' };

  const lines = text.split('\n');
  // Drop the trailing empty segment produced by the final newline.
  if (lines[lines.length - 1] === '') lines.pop();

  const headerRaw = lines[0];
  if (headerRaw === undefined) return { ok: false, reason: 'empty transcript' };

  let header: unknown;
  try {
    header = JSON.parse(headerRaw);
  } catch {
    // No parseable header at all — the claude-sdk runner's jsonl starts with a
    // real SDK entry, so this is also what a foreign transcript often looks
    // like. Either way: not ours.
    return { ok: false, reason: 'transcript has no parseable header line' };
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { ok: false, reason: 'transcript header is not an object' };
  }
  const h = header as { v?: unknown; runner?: unknown };
  if (h.runner !== TRANSCRIPT_RUNNER) {
    // THE CROSS-RUNNER DEMOTION (design §5). Translating between two vendors'
    // message shapes is explicitly out of scope — it would be lossy in both
    // directions — so we report the transcript unusable and the shell starts a
    // fresh session.
    return {
      ok: false,
      reason: `transcript was written by runner '${String(h.runner)}', not '${TRANSCRIPT_RUNNER}'`,
    };
  }
  if (h.v !== TRANSCRIPT_VERSION) {
    return {
      ok: false,
      reason: `transcript version ${String(h.v)} is not ${TRANSCRIPT_VERSION}`,
    };
  }

  const entries: TranscriptEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `line ${i + 1} is not valid JSON` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: `line ${i + 1} is not an object` };
    }
    const o = parsed as { role?: unknown; uuid?: unknown; message?: unknown };
    if (typeof o.uuid !== 'string' || o.uuid.length === 0) {
      return { ok: false, reason: `line ${i + 1} has no uuid` };
    }
    if (typeof o.role !== 'string' || !ROLES.has(o.role as TranscriptRole)) {
      return { ok: false, reason: `line ${i + 1} has an unknown role` };
    }
    const message = modelMessageSchema.safeParse(o.message);
    if (!message.success) {
      return { ok: false, reason: `line ${i + 1} is not a valid ModelMessage` };
    }
    entries.push({
      uuid: o.uuid,
      role: o.role as TranscriptRole,
      message: message.data,
      raw,
    });
  }

  return { ok: true, headerRaw, entries };
}

/** The display role for a message — the value the host's `TurnRole` expects. */
export function roleOf(message: ModelMessage): TranscriptRole {
  return message.role;
}
