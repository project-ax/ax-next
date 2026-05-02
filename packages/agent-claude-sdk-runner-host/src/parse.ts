// ---------------------------------------------------------------------------
// parseJsonlToTurns — convert claude-agent-sdk's native jsonl transcript
// (`~/.claude/projects/<slug>/<sessionId>.jsonl`) into the canonical
// `Turn[]` shape that channel-web's history-adapter already consumes.
//
// Two design rules:
//
//   1. Every produced ContentBlock MUST round-trip through
//      `ContentBlockSchema.safeParse`. The jsonl on disk is untrusted at
//      our boundary (per Invariant I5 — untrusted-content stays untrusted
//      at every hop): the SDK is third-party code and the model output it
//      transcribes is by definition adversarial. Drop blocks that fail
//      validation; the surviving blocks still ship.
//
//   2. The function is total: malformed input never throws. Truncated
//      tails (mid-flush writes from a live SDK process), corrupt mid-file
//      lines, unknown `type` values, and empty files all yield well-typed
//      output — `[]` in the worst case.
//
// What we deliberately match (NOT invent):
//
//   - For an SDK user-message whose `content` is a tool_result array, the
//     emitted Turn keeps role:'user'. That's what `appendTurn` produced
//     when fed via `chat:turn-end`. Pivoting to role:'tool' here would
//     diverge from the channel-web history shape and break replay.
//   - We do NOT fabricate timestamps or uuids. A line missing either is
//     skipped — silently — same as a corrupt line.
// ---------------------------------------------------------------------------

import { ContentBlockSchema, type ContentBlock } from '@ax/ipc-protocol';
import { z } from 'zod';

export type ParsedTurnRole = 'user' | 'assistant';

export interface ParsedTurn {
  turnId: string;
  turnIndex: number;
  role: ParsedTurnRole;
  contentBlocks: ContentBlock[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Outer SDK-line envelope. Permissive on purpose — future SDK versions may
// add fields, and we don't want a passthrough field to break parsing.
// We only `branch` on `type === 'user' | 'assistant'`; everything else is
// skipped (ai-title, queue-operation, system, result, summary, last-prompt,
// and anything we haven't seen yet).
// ---------------------------------------------------------------------------
const SdkLineSchema = z
  .object({
    type: z.string(),
    uuid: z.string().optional(),
    timestamp: z.string().optional(),
    message: z
      .object({
        content: z.unknown(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function decodeBytes(bytes: Uint8Array): string {
  // 'fatal:false' (default) — invalid UTF-8 produces U+FFFD instead of
  // throwing. The line will then likely fail JSON.parse and be skipped.
  return new TextDecoder('utf-8').decode(bytes);
}

function normalizeContent(raw: unknown): ContentBlock[] {
  // String content → wrap as a single text block, then validate.
  if (typeof raw === 'string') {
    const wrapped = { type: 'text', text: raw };
    const r = ContentBlockSchema.safeParse(wrapped);
    return r.success ? [r.data] : [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: ContentBlock[] = [];
  for (const item of raw) {
    const r = ContentBlockSchema.safeParse(item);
    if (r.success) out.push(r.data);
    // failures: drop silently. They could be future-SDK block types or
    // model-emitted garbage; the consumer (e.g. UI) is unprepared to
    // render either, so dropping is the safe move. (I5.)
  }
  return out;
}

export function parseJsonlToTurns(jsonlBytes: Uint8Array): ParsedTurn[] {
  const text = decodeBytes(jsonlBytes);
  if (text.length === 0) return [];

  const lines = text.split('\n');
  const turns: ParsedTurn[] = [];
  let nextIndex = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Truncated tail or mid-file corruption. Skip and keep going.
      continue;
    }

    const env = SdkLineSchema.safeParse(parsed);
    if (!env.success) continue;

    const { type, uuid, timestamp, message } = env.data;

    // Only `user` and `assistant` lines are turn-bearing. Everything else
    // (ai-title, queue-operation, system, result, summary, last-prompt,
    // anything unknown) is metadata.
    if (type !== 'user' && type !== 'assistant') continue;

    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    if (typeof timestamp !== 'string' || timestamp.length === 0) continue;
    if (!message) continue;

    const contentBlocks = normalizeContent(message.content);

    // A turn-bearing line that produced zero valid blocks gets skipped
    // entirely. Matches the chat:turn-end subscriber's heartbeat policy
    // (empty turns aren't persisted as appended rows).
    if (contentBlocks.length === 0) continue;

    turns.push({
      turnId: uuid,
      turnIndex: nextIndex++,
      role: type,
      contentBlocks,
      createdAt: timestamp,
    });
  }

  return turns;
}
