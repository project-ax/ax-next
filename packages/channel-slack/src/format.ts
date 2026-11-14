import { clampCodeUnits } from '@ax/core';
import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { cleanChannelName } from './label.js';
import { SENDER_NAME_MAX, STATUS_TITLE_MAX } from './limits.js';

/**
 * Text that leaves AX for Slack. Model output is untrusted (it can quote
 * anything a tool fetched), and Slack gives a few sequences meaning of their
 * own. Replies go out as Markdown (`markdown_text`), which Slack renders
 * itself, so nothing here converts formatting; it only takes away the power
 * to ping people or a whole channel and keeps every message under Slack's
 * caps.
 *
 * And for text coming IN: `decodeSlackEntities`, so the agent reads a
 * message as its sender typed it, and the sender labels in front of it.
 */

const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Slack's broadcast words. Typed bare, `@here`, `@channel` and `@everyone`
 * may notify a whole channel (whether Slack's Markdown does is unmeasured:
 * TASK-1097's walk checks), so they get the same treatment as `<!channel>`.
 * SLACK_CONTROL spells the same three.
 */
const BROADCAST_WORDS = ['here', 'channel', 'everyone'] as const;
const LONGEST_BROADCAST_WORD = Math.max(...BROADCAST_WORDS.map((word) => word.length));

/**
 * What Slack could read as a reference or a broadcast. The zero-width space
 * goes right after the match:
 *   - a `<` before `!`, `@` or `#`: `<!channel>`, `<@U…>`, `<#C…>`;
 *   - the `@` of a broadcast word, in any case, when no letter or digit comes
 *     right before the `@` or right after the word: `hi @channel.` and
 *     `(@Here)` are broadcasts, `me@channel.com` and `@channels` are not.
 * Letters and digits are ASCII `[A-Za-z0-9]`, not `\w`: `_` is Markdown's
 * emphasis mark (`_@here_`), so it exempts nothing. One pattern, lookarounds
 * only: punctuation next to a word can't slip past it.
 */
const SLACK_CONTROL = /<(?=[!@#])|(?<![A-Za-z0-9])@(?=(?:here|channel|everyone)(?![A-Za-z0-9]))/gi;

/**
 * `<!channel>`, `<!here>`, `<!everyone>`, `<@U…>` and `<#C…>` are Slack's
 * broadcast, user and channel references, and a bare `@here`, `@channel` or
 * `@everyone` may broadcast too. A zero-width space after the `<` (or the
 * `@`) keeps every character readable and makes none of them work: the bot
 * never pings anyone with words a model wrote.
 *
 * `before` is text that comes right before `text` in the same Slack message
 * (already decided, maybe already sent). It is only read, never marked: a `<`
 * that ends it gets its mark at the start of `text` when a `!`, `@` or `#`
 * follows, and an `@` that starts `text` right after a letter is an address,
 * not a broadcast. The end of `text` counts as the end of the message, so
 * text that may go on must not end with an `undecidedTail`.
 */
export function neutralizeSlackControls(text: string, before = ''): string {
  // Two characters reach every decision: an `@` that ends `before` needs the one before it.
  const context = before.slice(-2);
  return (context + text)
    .replace(SLACK_CONTROL, (mark: string, at: number) => (at + 1 < context.length ? mark : mark + ZERO_WIDTH_SPACE))
    .slice(context.length);
}

/**
 * How many code units at the end of `text` neutralizeSlackControls can't
 * decide yet: an `@` followed by nothing but the start of a broadcast word
 * (or the whole word: `@channel` then `s` is a name). The next characters
 * decide it, so a reply stream holds these back until they come
 * (reply-stream.ts). At most nine (`@everyone`); 0 when nothing waits.
 *
 * Whatever comes before the `@` is never read. A letter there makes the word
 * an address in the reply (`me@chan`), but Slack judges each message, and
 * the status card, a new stream or a cut can come between that letter and
 * the `@`: sent then, `@chan` would start the next run and `nel` complete a
 * live `@channel` in it. Held, the word reaches that run whole and is judged
 * there.
 */
export function undecidedTail(text: string): number {
  const at = text.lastIndexOf('@');
  if (at < 0 || text.length - at - 1 > LONGEST_BROADCAST_WORD) return 0;
  const start = text.slice(at + 1);
  if (!/^[A-Za-z]*$/.test(start)) return 0;
  const lower = start.toLowerCase();
  return BROADCAST_WORDS.some((word) => word.startsWith(lower)) ? text.length - at : 0;
}

/**
 * A status line's title (a tool's activity phrase, a step summary) made fit
 * for Slack's task card: no control, bidi or invisible characters (they
 * become spaces), single spaces, no Slack references or broadcast words, at
 * most STATUS_TITLE_MAX code units and never half an emoji. Neutralized
 * before it's clamped, so the cap holds. A cut can end the title right after
 * a broadcast word whose next letter it took off (`@heres` becomes `@here`),
 * so the cut title is neutralized again: that adds at most one mark, after
 * the last word's `@`, and the second cut then takes the word's last letter,
 * never the mark. Empty when nothing printable is left.
 */
export function cleanStatusTitle(text: string): string {
  const flat = replaceSurfaceRewriters(text).replace(/\s+/g, ' ').trim();
  const cut = clampCodeUnits(neutralizeSlackControls(flat), STATUS_TITLE_MAX);
  return clampCodeUnits(neutralizeSlackControls(cut), STATUS_TITLE_MAX).trimEnd();
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

const SLACK_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>' };
const MRKDWN_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Text from outside (an agent's or a channel's name) made fit for a mrkdwn
 * `text` field, the `/ax` replies' format: the three characters Slack
 * reserves become the entities Slack itself uses, in one pass, so an `&` is
 * escaped exactly once. No `<` is left to open a link, a mention or a
 * broadcast (`<!channel>`), and the reader sees the name as it was typed.
 * The inverse of `decodeSlackEntities`.
 */
export function mrkdwnEscape(text: string): string {
  return text.replace(/[&<>]/g, (c) => MRKDWN_ESCAPES[c] ?? c);
}

/**
 * A message's text as its sender typed it. Slack escapes exactly three
 * characters in message text, `&` `<` `>` as `&amp;` `&lt;` `&gt;`, so that
 * its own references (`<@U…>`, `<#C…>`, `<url|label>`) can't be confused
 * with typed text. This undoes those three, in one left-to-right pass, so a
 * typed `&lt;` (sent as `&amp;lt;`) stays `&lt;`. Nothing else changes: a
 * reference stays as Slack wrote it, and any other entity is left alone.
 */
export function decodeSlackEntities(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (entity, name: string) => SLACK_ENTITIES[name] ?? entity);
}

/**
 * A Slack display name, made fit for the sender labels (`dmSenderLabel`,
 * `channelSenderLabel`): no
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
  return `[Slack · DM · ${senderOf(name, slackUserId)}]`;
}

/**
 * Who a channel mention is from, and where, as the agent reads it at the
 * start of the message content (design §2): `[Slack · #support · Alice Smith
 * (U123)]`. `channel` is the binding's stored name, or the channel's
 * ingress-checked id when it has none; it is cleaned again here
 * (`cleanChannelName`: no brackets, parentheses, control, bidi or invisible
 * characters), so a name can't close the label early whoever stored it. The
 * sender as `dmSenderLabel` names them. Untrusted text in the CONTENT, never
 * in the turn's context: who the turn runs as comes from users.info and AX.
 */
export function channelSenderLabel(channel: string, name: string, slackUserId: string): string {
  return `[Slack · #${cleanChannelName(channel)} · ${senderOf(name, slackUserId)}]`;
}

/** `Alice Smith (U123)`, or the bare id when the sender has no name. */
function senderOf(name: string, slackUserId: string): string {
  return name.length > 0 ? `${name} (${slackUserId})` : slackUserId;
}
