// ---------------------------------------------------------------------------
// A turn's text is never a CLI slash command (TASK-1217).
//
// The runner hands each turn to the `claude` CLI as a user message, and the
// CLI checks whether its text is one of its own `/` commands before the model
// sees it. Measured on the pinned CLI (2.1.119, SDK 0.2.119), in the SDK's
// streaming mode:
//   - `/update-config …` and `/simplify` expand the CLI's bundled skill
//     straight into the turn. There is no `Skill` call, so neither the
//     runner's PreToolUse gate nor the host's `tool.pre-call` sees it.
//   - `/clear` makes no model call and switches the CLI to a new session id.
//     The runner keeps the first id (main.ts, `system/init`), so the
//     transcript it ships would stop following the conversation.
//   - `/hello there` (any word the CLI doesn't know) gets the CLI's own
//     "Unknown command: /hello", and the model never sees the message.
//
// Why every slash, not just the CLI's command names: nothing in AX offers `/`
// commands (the web composer sends plain text, a Slack turn starts with the
// sender's label, and only a plain routine prompt can start with `/`). The
// CLI's direct expansion skips `tool.pre-call` even for an AX skill's name,
// and the model can still open an AX skill through the `Skill` tool, which is
// checked.
//
// Why U+200B: the CLI's queued-message path `trim()`s the text before it
// looks for `/`, so a leading space doesn't survive. JS `trim()` keeps U+200B
// (it isn't whitespace), so the text still starts with it after trimming, and
// it reaches the model verbatim (measured). Sending the text as a block array
// doesn't help either: the CLI reads the LAST text block of an array as the
// command text. So every text block that would start with `/` is guarded.
//
// Only the CLI's copy carries the invisible character. What the person typed
// is what the display log and the chat's history keep: the host saves the
// turn before it reaches the runner, and the runner-core shell records its
// copy before this loop wraps the message.
//
// The aisdk runner already hands `/` text to its model as plain words, so
// both runners now agree.
// ---------------------------------------------------------------------------

/** U+200B ZERO WIDTH SPACE. JS `trim()` keeps it, so the CLI's queued-message check cannot strip it either. */
export const SLASH_TEXT_GUARD = '​';

/** `text` with the guard in front, or `undefined` when it needs none. */
function guarded(text: string): string | undefined {
  return text.trimStart().startsWith('/') ? `${SLASH_TEXT_GUARD}${text}` : undefined;
}

/**
 * Returns `content` with SLASH_TEXT_GUARD in front of every text that would
 * otherwise start with `/` (after leading whitespace): a string, or each
 * `{ type: 'text', text }` block of an array. Everything else is returned as
 * is. Never mutates its input; returns the same reference when nothing changes.
 */
export function keepSlashAsText(content: unknown): unknown {
  if (typeof content === 'string') return guarded(content) ?? content;
  if (!Array.isArray(content)) return content;
  let out: unknown[] | undefined;
  content.forEach((block: unknown, i) => {
    if (typeof block !== 'object' || block === null) return;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type !== 'text' || typeof text !== 'string') return;
    const next = guarded(text);
    if (next === undefined) return;
    out ??= [...content];
    out[i] = { ...block, text: next };
  });
  return out ?? content;
}
