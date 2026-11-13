import { clampCodeUnits } from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { SENDER_NAME_MAX, STATUS_TITLE_MAX } from './limits.js';

/**
 * Text that leaves AX for Slack. Model output is untrusted (it can quote
 * anything a tool fetched), and Slack gives a few sequences meaning of their
 * own. Replies go out as Markdown (`markdown_text`), which Slack renders
 * itself, so nothing here converts formatting; it only takes away the power
 * to ping people and keeps every message under Slack's caps.
 */

const ZERO_WIDTH_SPACE = '\u200B';

/**
 * `<!channel>`, `<!here>`, `<!everyone>`, `<@U…>` and `<#C…>` are Slack's
 * broadcast, user and channel references. A zero-width space after the `<`
 * keeps every character readable and makes none of them a reference: the bot
 * never pings anyone with words a model wrote. Harmless in a 1:1 DM, but this
 * is the boundary channel replies (TASK-1094) reuse.
 *
 * Per string. A reply stream also handles a `<` at the end of one delta
 * followed by `!`, `@` or `#` at the start of the next (reply-stream.ts).
 */
export function neutralizeSlackControls(text: string): string {
  return text.replace(/<(?=[!@#])/g, `<${ZERO_WIDTH_SPACE}`);
}

/**
 * A status line's title (a tool's activity phrase, a step summary) made fit
 * for Slack's task card: no control, bidi or invisible characters (they
 * become spaces), single spaces, no Slack references, at most
 * STATUS_TITLE_MAX code units and never half an emoji. Neutralized before
 * it's clamped, so the cap holds; a cut can only drop characters, so it can't
 * rebuild a reference. Empty when nothing printable is left.
 */
export function cleanStatusTitle(text: string): string {
  const flat = replaceSurfaceRewriters(text).replace(/\s+/g, ' ').trim();
  return clampCodeUnits(neutralizeSlackControls(flat), STATUS_TITLE_MAX).trimEnd();
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Where to cut `text` so the first part has at most `limit` code units: just
 * after the last newline in that window, else just after the last space, else
 * at `limit`. Never between the two halves of an emoji. `text.length` when it
 * already fits. Only a newline or space after the first character counts, so
 * a part is never a lone separator. Can be 0 only when `limit` is 0, or 1
 * with an emoji first.
 */
export function cutIndex(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  if (limit <= 0) return 0;
  const window = text.slice(0, limit);
  const newline = window.lastIndexOf('\n');
  const space = window.lastIndexOf(' ');
  let cut = newline > 0 ? newline + 1 : space > 0 ? space + 1 : limit;
  if (cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) {
    cut -= 1;
  }
  return cut;
}

/**
 * `text` in parts of at most `limit` code units, each cut by `cutIndex`. The
 * parts join back to exactly `text`: nothing is trimmed or dropped. Empty
 * text is no parts.
 */
export function splitForPost(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new RangeError('splitForPost: limit must be an integer of at least 2');
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const cut = cutIndex(rest, limit);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}

/**
 * A Slack display name, made fit for the sender label (`dmSenderLabel`): no
 * control, bidi or invisible characters, no brackets or parentheses (so a
 * name can't close the label early and start a second one), single spaces,
 * at most SENDER_NAME_MAX code units. Empty when nothing printable is left.
 * The name is the sender's own Slack profile text: untrusted, for the model
 * to read, never used for identity.
 */
export function cleanSenderName(raw: string): string {
  const flat = replaceSurfaceRewriters(raw)
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clampCodeUnits(flat, SENDER_NAME_MAX).trimEnd();
}

/**
 * Who a DM is from, as the agent reads it at the start of the message
 * content (design §2): `[Slack · DM · Alice Smith (U123)]`. The Slack
 * user id is ingress-checked (`[A-Za-z0-9._-]`); the name is
 * `cleanSenderName`'s. The label is untrusted text in the CONTENT, never in
 * the turn's context: nothing treats it as permission to do anything, and
 * the turn's identity comes from users.info and AX alone.
 */
export function dmSenderLabel(name: string, slackUserId: string): string {
  const who = name.length > 0 ? `${name} (${slackUserId})` : slackUserId;
  return `[Slack · DM · ${who}]`;
}
