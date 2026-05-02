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
// Two behaviors that diverge from "1 jsonl line == 1 Turn":
//
//   - tool_result remap. A user-type line whose content carries any
//     tool_result block becomes role='tool' (not 'user'). The channel-web
//     history-adapter routes role='tool' into the assistant lane; without
//     this remap a tool result would render as if the user typed it. This
//     also matches what the legacy runner emitted via `chat:turn-end` —
//     `role:'tool'` for tool_result-bearing emissions.
//
//   - Same-message.id coalesce. The SDK splits a logical assistant
//     message that mixes text + tool_use across two consecutive jsonl
//     lines (different uuid, same `message.id`). We append the second
//     line's blocks onto the first emitted Turn so the consumer sees one
//     assistant Turn with both blocks in order. Cross-message coalescing
//     (i.e. text → tool_use → tool_result → followup-text) is NOT done
//     here; granularity within a multi-step interaction will still
//     differ from what the legacy runner emitted.
// ---------------------------------------------------------------------------

import { ContentBlockSchema, type ContentBlock } from '@ax/ipc-protocol';
import { z } from 'zod';

export type ParsedTurnRole = 'user' | 'assistant' | 'tool';

export interface ParsedTurn {
  turnId: string;
  turnIndex: number;
  role: ParsedTurnRole;
  contentBlocks: ContentBlock[];
  createdAt: string;
}

// Outer SDK-line envelope. `uuid` and `timestamp` are required up front:
// without them the line can't be turned into a Turn anyway. `message` is
// optional because non-turn-bearing lines (ai-title, queue-operation, …)
// don't carry one.
const SdkLineSchema = z
  .object({
    type: z.string(),
    uuid: z.string().min(1),
    timestamp: z.string().min(1),
    message: z
      .object({
        id: z.string().optional(),
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

interface NormalizedContent {
  blocks: ContentBlock[];
  hasToolResult: boolean;
}

function normalizeContent(raw: unknown): NormalizedContent {
  if (typeof raw === 'string') {
    const wrapped = { type: 'text', text: raw };
    const r = ContentBlockSchema.safeParse(wrapped);
    return r.success
      ? { blocks: [r.data], hasToolResult: false }
      : { blocks: [], hasToolResult: false };
  }
  if (!Array.isArray(raw)) {
    return { blocks: [], hasToolResult: false };
  }

  const blocks: ContentBlock[] = [];
  let hasToolResult = false;
  for (const item of raw) {
    const r = ContentBlockSchema.safeParse(item);
    if (r.success) {
      blocks.push(r.data);
      if (r.data.type === 'tool_result') hasToolResult = true;
    }
    // Failures: drop. They could be future-SDK block types or model-emitted
    // garbage; the consumer is unprepared to render either. (I5.)
  }
  return { blocks, hasToolResult };
}

export function parseJsonlToTurns(jsonlBytes: Uint8Array): ParsedTurn[] {
  const text = decodeBytes(jsonlBytes);
  if (text.length === 0) return [];

  const lines = text.split('\n');
  const turns: ParsedTurn[] = [];
  let nextIndex = 0;

  // Tracks the message.id of the most recently emitted assistant Turn, or
  // null if the last emitted Turn was non-assistant (or nothing has been
  // emitted yet). A blank/corrupt line in between does NOT clear this —
  // nothing was emitted, so the streak continues.
  let lastEmittedAssistantMsgId: string | null = null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const env = SdkLineSchema.safeParse(parsed);
    if (!env.success) continue;

    const { type, uuid, timestamp, message } = env.data;

    // Only `user` and `assistant` lines are turn-bearing. Everything else
    // (ai-title, queue-operation, system, result, summary, last-prompt,
    // anything unknown) is metadata.
    if (type !== 'user' && type !== 'assistant') continue;
    if (!message) continue;

    const { blocks, hasToolResult } = normalizeContent(message.content);
    if (blocks.length === 0) continue;

    let role: ParsedTurnRole;
    if (type === 'assistant') {
      role = 'assistant';
    } else {
      // type === 'user'. Any tool_result in the array remaps to role='tool'
      // so channel-web routes it into the assistant lane. Pure text/image
      // (e.g. SDK caller attaching an image input) keeps role='user'.
      role = hasToolResult ? 'tool' : 'user';
    }

    const prev = turns.length > 0 ? turns[turns.length - 1] : undefined;
    if (
      role === 'assistant' &&
      lastEmittedAssistantMsgId !== null &&
      typeof message.id === 'string' &&
      message.id.length > 0 &&
      message.id === lastEmittedAssistantMsgId &&
      prev !== undefined
    ) {
      // Coalesce onto the previous Turn. Keep its turnId + createdAt; the
      // SDK's first line is the canonical start of the logical message.
      prev.contentBlocks = [...prev.contentBlocks, ...blocks];
      continue;
    }

    turns.push({
      turnId: uuid,
      turnIndex: nextIndex++,
      role,
      contentBlocks: blocks,
      createdAt: timestamp,
    });

    if (role === 'assistant' && typeof message.id === 'string' && message.id.length > 0) {
      lastEmittedAssistantMsgId = message.id;
    } else {
      // A non-assistant emission, or an assistant emission missing
      // message.id, breaks the coalesce streak.
      lastEmittedAssistantMsgId = null;
    }
  }

  return turns;
}
