// ---------------------------------------------------------------------------
// A turn's text never acts on the CLI as `@` mentions or as the CLI's own
// markup (TASK-1220).
//
// Measured on the pinned CLI (2.1.119, SDK 0.2.119) with a scripted model:
//
//   - `@<path>` anywhere in a turn's text (at the start or after whitespace)
//     makes the CLI read that file BEFORE the model call and hand it to the
//     model as "Result of calling the Read tool". No PreToolUse hook and no
//     `canUseTool` call fires, so the runner's gate and the host's
//     `tool.pre-call` never see the read. It reaches outside the agent's home:
//     `@../x`, `@/etc/hosts`, the session's `CLAUDE_CONFIG_DIR`, a symlink
//     in the home pointing elsewhere, a quoted `@"a b"`, a directory (its
//     listing). `@server:uri` (MCP resources) and `@agent-name` go through
//     the same pass. The CLI's only off switch (CLAUDE_CODE_DISABLE_ATTACHMENTS)
//     also turns off the skill listing and deferred tools, so it is not used.
//   - Text that holds the CLI's own markup (`<system-reminder>`,
//     `<task-notification>`, `<local-command-stdout>`, …) reads, to the model,
//     byte for byte like what the CLI itself injects. For some tags the CLI
//     also files the message as its own: it stops echoing it back with
//     `--replay-user-messages`, which is how the shell learns a mid-turn
//     message was folded into a turn (TASK-708).
//
// Turn text is untrusted: a Slack sender, a web chat, a routine prompt or a
// pasted connector result can all carry it. So the runner puts an invisible
// U+200B ZERO WIDTH SPACE:
//
//   - in front of every `@` that does not follow a letter or a digit. The CLI
//     only looks after start-of-text or whitespace; guarding after any
//     non-alphanumeric too keeps a CLI that widens that set closed, and
//     leaves an email address (`bob@example.com`) as it was;
//   - right after the `<` of an opening or closing tag from CLI_MARKUP_TAGS
//     (a closed list, so pasted HTML and code are left alone).
//
// Measured: the CLI reads no file for `​@/path` or `x ​@/path`, and the model
// gets the text verbatim. Only the CLI's copy carries the character; the
// display log and the chat's history keep what the person typed (see
// slash-text.ts, the same seam).
//
// Known cost: a pasted decorator (`@dataclass` on its own line) reaches the
// model with an invisible U+200B in front.
// ---------------------------------------------------------------------------

/** U+200B ZERO WIDTH SPACE. */
export const CLI_MARKUP_GUARD = '​';

/**
 * Tag names the CLI writes into user-role messages itself, taken from the
 * pinned binary. Matched case-insensitively, opening or closing.
 */
export const CLI_MARKUP_TAGS = [
  'system-reminder',
  'task-notification',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'command-name',
  'command-message',
  'command-args',
  'user-prompt-submit-hook',
  'persisted-output',
  'user-memory-input',
  'new-diagnostics',
] as const;

// `@` not preceded by a letter, a digit or the guard itself (idempotent).
const AT = /(?<![\p{L}\p{N}​])@/gu;
const TAG = new RegExp(`<(?=/?(?:${CLI_MARKUP_TAGS.join('|')})(?![\\w-]))`, 'gi');

function guardText(text: string): string {
  return text.replace(AT, `${CLI_MARKUP_GUARD}@`).replace(TAG, `<${CLI_MARKUP_GUARD}`);
}

/**
 * Returns `content` with every `@` mention and every CLI markup tag guarded:
 * a string, or each `{ type: 'text', text }` block of an array. Everything
 * else is returned as is. Never mutates its input; returns the same reference
 * when nothing changes.
 */
export function keepCliMarkupAsText(content: unknown): unknown {
  if (typeof content === 'string') return guardText(content);
  if (!Array.isArray(content)) return content;
  let out: unknown[] | undefined;
  content.forEach((block: unknown, i) => {
    if (typeof block !== 'object' || block === null) return;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type !== 'text' || typeof text !== 'string') return;
    const next = guardText(text);
    if (next === text) return;
    out ??= [...content];
    out[i] = { ...block, text: next };
  });
  return out ?? content;
}
