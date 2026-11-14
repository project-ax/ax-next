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
 *   - a `<` before `!`, `@`, `#` or `&`: `<!channel>`, `<@U…>`, `<#C…>`, and
 *     `<&excl;channel>`, which a decoder could turn into the first;
 *   - an `&` that starts a character reference Markdown or HTML could decode,
 *     in any case: a numeric one (`&#` and a digit, or `&#x`); any name ended
 *     by `;` (`&commat;`, `&excl;`, `&num;`, `&lt;`, `&nvlt;` …: HTML has
 *     too many to list the dangerous ones) except `&amp;`, `&gt;`, `&quot;`,
 *     `&apos;` and `&nbsp;`, harmless and common in prose; `&lt` with no `;`
 *     (HTML's legacy form, the only one without `;` that decodes to a
 *     mention's character); and a name too long for a stream to wait for (31
 *     characters, longer than any HTML name). Whether Slack decodes
 *     `markdown_text` at all is unmeasured (TASK-1097's walk): this is
 *     defense in depth. Marked, a reference decodes to nothing. Any other
 *     name with no `;` is left alone, because no decoder reads it (Markdown
 *     needs the `;`, HTML's legacy names have none of these characters) and
 *     it is how a link's query string looks (`&page=2&utm_source=x`): a mark
 *     there would break the link. So is a lone letter (`R&D`, `a&b`);
 *   - the `@` of a broadcast word, in any case, when no letter or digit comes
 *     right after the word, WHATEVER comes before the `@`: `hi @channel.`,
 *     `(@Here)` and `me@channel.com` are marked, `@channels` and
 *     `me@channels.com` are not. A letter before the `@` used to exempt the
 *     word as an address, but every way that letter can vanish before Slack
 *     reads the word (a message edge, a decoder turning `&copy` into `©`)
 *     made the word live again; marking it whatever precedes ends that
 *     whole class. The price: an address on a domain that starts with one
 *     of the words (`me@channel.com`) gets an invisible mark after its `@`
 *     (it shows the same; a copy and paste carries the mark). Rare.
 * Letters and digits are ASCII `[A-Za-z0-9]`, not `\w`: `_` is Markdown's
 * emphasis mark (`_@here_`), so it doesn't continue a word. One pattern,
 * lookarounds only: punctuation next to a word can't slip past it.
 */
const SLACK_CONTROL =
  /<(?=[!@#&])|&(?=#[0-9x]|lt|[a-z][a-z0-9]{30}|(?!(?:amp|gt|quot|apos|nbsp);)[a-z][a-z0-9]{0,30};)|@(?=(?:here|channel|everyone)(?![A-Za-z0-9]))/gi;

/**
 * An `&` that ends the text with nothing after it but the start of a
 * reference SLACK_CONTROL may still mark: `&`, `&#`, or a name of up to 30
 * letters and digits that a `;` could still end (`&excl`, `&amp`), any case.
 * `&lt` is decided (always marked), and so is a name of 31 (marked: it is
 * longer than any HTML name, so the stream stops waiting and releases it
 * marked). So a held tail is at most 31 code units.
 */
const UNDECIDED_ENTITY = /&(?:#|(?!lt)[a-z][a-z0-9]{0,29})?$/i;
const LONGEST_UNDECIDED_ENTITY = 31;

/**
 * `<!channel>`, `<!here>`, `<!everyone>`, `<@U…>` and `<#C…>` are Slack's
 * broadcast, user and channel references, and a bare `@here`, `@channel` or
 * `@everyone` may broadcast too, spelled out or in HTML entities
 * (`&#64;channel`, `&lt;!here&gt;`). A zero-width space after the `<` (or
 * the `@`, or the `&`) keeps every character readable and makes none of them
 * work: the bot never pings anyone with words a model wrote.
 *
 * `before` is text that comes right before `text` in the same Slack message
 * (already decided, maybe already sent). Only its last character is read,
 * and never marked: no rule looks behind what it marks any more, so the one
 * thing `before` can still decide is a `<` that ends it, which gets its mark
 * at the start of `text` when a `!`, `@`, `#` or `&` follows (the `<!` rule
 * across chunks). An `&` or `@` that ends decided text would get the same,
 * but a reply never decides one: `undecidedTail` holds them back. The end of
 * `text` counts as the end of the message, so text that may go on must not
 * end with an `undecidedTail`.
 */
export function neutralizeSlackControls(text: string, before = ''): string {
  // Every match is marked: one on `before`'s last character puts its mark at the start of `text`.
  const context = before.slice(-1);
  return (context + text).replace(SLACK_CONTROL, (mark: string) => mark + ZERO_WIDTH_SPACE).slice(context.length);
}

/**
 * How many code units at the end of `text` neutralizeSlackControls can't
 * decide yet: an `@` followed by nothing but the start of a broadcast word
 * (or the whole word: `@channel` then `s` is a name), or an `&` followed by
 * nothing but the start of a reference it may mark (`&#`, `&excl`: a `;`
 * may still come). The next characters decide it, so a reply stream holds
 * these back until they come (reply-stream.ts). At most 31 (`&` and a
 * 30-character name; at 31 the name is marked); 0 when nothing waits.
 *
 * Whatever comes before the `@` is never read (it exempts nothing). The
 * word waits because its own end decides it: sent as `@chan`, the `@` is
 * already out when `nel` shows it needed a mark (and `nel` alone is
 * nothing), while `@channels` is a name. A reference waits for the same
 * reason: sent as `&#` or `&excl`, the `&` is already out when `64;` or `;`
 * shows it needed a mark.
 */
export function undecidedTail(text: string): number {
  const entity = UNDECIDED_ENTITY.exec(text.slice(-LONGEST_UNDECIDED_ENTITY));
  return Math.max(undecidedWord(text), entity === null ? 0 : entity[0].length);
}

/** undecidedTail's `@`: a broadcast word that may still be starting. */
function undecidedWord(text: string): number {
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
