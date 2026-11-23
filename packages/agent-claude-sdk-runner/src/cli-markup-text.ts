// ---------------------------------------------------------------------------
// A turn's text never acts on the CLI as `@` mentions or as the CLI's own
// markup (TASK-1220).
//
// Measured on the pinned CLI (2.1.119, SDK 0.2.119) with a scripted model:
//
//   - `@<path>` in a turn's text (at the start, after whitespace, or after
//     。、？！ — the binary's turn-text parsers are
//     `(^|[\s。、？！])@…`) makes the CLI read that file
//     BEFORE the model call and hand it to the model as "Result of calling
//     the Read tool". No PreToolUse hook and no `canUseTool` call fires, so
//     the runner's gate and the host's `tool.pre-call` never see the read. It
//     reaches outside the agent's home: `@../x`, `@/etc/hosts`, the session's
//     `CLAUDE_CONFIG_DIR`, a symlink in the home pointing elsewhere, a quoted
//     `@"a b"`, a directory (its listing). `@server:uri` (MCP resources) and
//     `@agent-name` go through the same pass. The CLI's only off switch
//     (CLAUDE_CODE_DISABLE_ATTACHMENTS) also turns off the skill listing and
//     deferred tools, so it is not used.
//   - Text that holds the CLI's own markup (`<system-reminder>`,
//     `<task-notification>`, …) reads, to the model, byte for byte like what
//     the CLI itself injects. For some of it the CLI also files the message
//     as its own and stops echoing it back with `--replay-user-messages`,
//     which is how the shell learns a mid-turn message was folded into a turn
//     (TASK-708). The binary's echo filter drops a message whose text holds
//     `<local-command-stdout>`, `<local-command-stderr>`, `<bash-stdout>`,
//     `<bash-stderr>`, `<task-notification>`, `<tick>` or a
//     `<teammate-message` tag, and an array whose first text block is exactly
//     one of five CLI lines (`[Request interrupted by user]`, `… for tool
//     use]`, `No response requested.`, and two that start `The user doesn't
//     want to`).
//
// Turn text is untrusted: a Slack sender, a web chat, a routine prompt or a
// pasted connector result can all carry it. So the runner puts an invisible
// U+200B ZERO WIDTH SPACE:
//
//   - in front of every `@` that does not follow a letter, a digit or `/`.
//     That is broader than the CLI's own boundary set on purpose: a CLI that
//     widens the set stays closed. An email address (`bob@example.com`) and a
//     path segment (`uploads/@x.csv`, the runner's own attachment paths) are
//     left as they were. Do not narrow it to "what the CLI matches today";
//   - right after the `<` of a tag named in CLI_MARKUP_TAGS: the name must end
//     there (whitespace, `/` or `>`), except `teammate-message`, which the CLI
//     itself matches as a prefix. `<ticket>` or `<ChannelList />` is left
//     alone;
//   - in front of a text that starts with one of those CLI lines.
//
// Measured: the CLI reads no file for `​@/path` or `x ​@/path`, and the model
// gets the text verbatim. Only the CLI's copy carries the character; the
// display log and the chat's history keep what the person typed (see
// slash-text.ts, the same seam).
//
// Known cost (not measured on a real model): every `@` that follows a space or
// punctuation reaches the model with an invisible U+200B in front — a pasted
// decorator (`@dataclass`), `"$@"`, `@types/node`, `@handle`. If the model
// copies the character into a file or a command, that copy is broken.
// ---------------------------------------------------------------------------

import { SLASH_TEXT_GUARD } from './slash-text.js';

/** U+200B ZERO WIDTH SPACE — the one guard character, shared with slash-text.ts. */
export const CLI_MARKUP_GUARD = SLASH_TEXT_GUARD;

/**
 * Tag names the CLI writes into user-role messages itself, from the pinned
 * binary's tag table and its echo filter. Matched case-insensitively, opening
 * or closing; the name must end at whitespace, `/` or `>`, except the ones in
 * CLI_MARKUP_PREFIX_TAGS.
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
  'tick',
  'teammate-message',
  'channel',
  'cross-session-message',
  'fork-boilerplate',
] as const;

/** Tags the CLI's echo filter matches as a prefix (`<teammate-message …`). */
const CLI_MARKUP_PREFIX_TAGS = ['teammate-message'] as const;

/** Starts of the CLI lines that, as an array's first block, lose the echo. */
const CLI_LINE_STARTS = ['[Request interrupted', 'No response requested', "The user doesn't want to"] as const;

// `@` not preceded by a letter, a digit, `/` or the guard itself (idempotent).
const AT = new RegExp(`(?<![\\p{L}\\p{N}/${CLI_MARKUP_GUARD}])@`, 'gu');
const TAG = new RegExp(
  `<(?=/?(?:(?:${CLI_MARKUP_TAGS.join('|')})(?=[\\s/>])|${CLI_MARKUP_PREFIX_TAGS.join('|')}))`,
  'gi',
);

function guardText(text: string): string {
  const out = text.replace(AT, `${CLI_MARKUP_GUARD}@`).replace(TAG, `<${CLI_MARKUP_GUARD}`);
  const start = out.trimStart();
  return CLI_LINE_STARTS.some((s) => start.startsWith(s)) ? `${CLI_MARKUP_GUARD}${out}` : out;
}

/**
 * Returns `content` with every `@` mention, every CLI markup tag and a leading
 * CLI line guarded: a string, or each `{ type: 'text', text }`
 * block of an array. Everything else is returned as is. Never mutates its
 * input; returns the same reference when nothing changes.
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
