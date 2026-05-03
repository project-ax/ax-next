import type { ContentBlock } from '@ax/ipc-protocol';
import type { Turn } from './types.js';

/**
 * The system prompt steers the model toward short, plain titles. We tell it
 * to output exactly `Untitled` when there's no signal — that lets the
 * validator turn ambiguity into a NULL row rather than a literal "Untitled"
 * label nobody asked for.
 */
const SYSTEM_PROMPT =
  'You generate short, descriptive titles for conversations between a user ' +
  'and an AI assistant. Output ONLY the title — no quotes, no preamble, no ' +
  'trailing period. Maximum 8 words. Use Title Case. If the conversation ' +
  'is empty or unclear, output exactly: Untitled';

/**
 * Cap on the flattened transcript length we feed into the title model. The
 * point is to keep token usage bounded; first-turn conversations are usually
 * far below this. Beyond ~4 KB of context the title doesn't get any better.
 */
const TRANSCRIPT_BUDGET = 4000;

export interface BuiltPrompt {
  system: string;
  user: string;
}

/**
 * Build the title-LLM call's `system` + `user` strings from a conversation
 * transcript. Pure function — no I/O, no env, no side effects.
 *
 * Truncation: walk the turns in order, append each labeled line, stop when
 * the next addition would push us over the budget. Head-only (the start of
 * the conversation is what determines its topic; trailing rambles can be
 * dropped).
 */
export function buildPrompt(turns: Turn[]): BuiltPrompt {
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns) {
    const text = flattenBlocks(turn.contentBlocks);
    if (text.length === 0) continue;
    const label =
      turn.role === 'user'
        ? 'User'
        : turn.role === 'assistant'
          ? 'Assistant'
          : 'Tool';
    const line = `${label}: ${text}`;
    if (used + line.length > TRANSCRIPT_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  return {
    system: SYSTEM_PROMPT,
    user: `Summarize this conversation in ≤8 words:\n\n${lines.join('\n')}`,
  };
}

/**
 * Collapse a turn's content blocks into a plain-text snippet for the prompt.
 *
 * We keep `text` verbatim, abbreviate `tool_use` and `tool_result` to a
 * marker (the title model doesn't need the tool's payload), and drop
 * everything else — `thinking` / `redacted_thinking` would only confuse the
 * summarizer, and `image` blocks have no useful text projection here.
 */
function flattenBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool: ${b.name}]`;
      if (b.type === 'tool_result') return '[result]';
      // thinking, redacted_thinking, image — dropped.
      return '';
    })
    .filter((s) => s.length > 0)
    .join(' ');
}
