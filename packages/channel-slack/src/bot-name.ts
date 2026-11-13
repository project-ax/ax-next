/**
 * The bot's name: what an admin may type, and the default we offer.
 *
 * Slack's rules, MEASURED in the TASK-1090 spike with `apps.manifest.validate`
 * and two real installs (`.claude/memory/decisions/2026-11-12-TASK-1090.md`):
 * ASCII letters, digits, space, `-`, `_` and `.` only (`Café` is refused as
 * `bad_username`); the words `slackbot`, `here`, `channel` and `everyone` are
 * reserved; the app name holds at most 35 characters, and the @handle Slack
 * derives from it is lowercased, loses its hyphens (`ax-spike-a` became
 * `axspikea`) and is cut to 21. Slack accepts duplicate names
 * silently, so uniqueness would be ours to enforce; one install per AX
 * instance has nothing to collide with yet.
 */
import { BOT_HANDLE_MAX, BOT_NAME_MAX } from './limits.js';

/**
 * Compared against a name's handle key (handleKey below), so a name whose
 * @handle would come out as one of these is refused too.
 */
export const RESERVED_BOT_NAMES: ReadonlySet<string> = new Set([
  'slackbot',
  'here',
  'channel',
  'everyone',
]);

export type BotNameRefusal = 'empty' | 'too-long' | 'bad-characters' | 'reserved';

export type BotNameCheck = { ok: true; name: string } | { ok: false; reason: BotNameRefusal };

/** Used when the branding name has no usable handle form. */
const FALLBACK_BOT_NAME = 'ax';

const WHITESPACE_RUN = /\s+/g;
const ALLOWED = /^[A-Za-z0-9 ._-]+$/;
const LETTER_OR_DIGIT = /[A-Za-z0-9]/;
const MARKS = /\p{M}/gu;
const NOT_HANDLE = /[^a-z0-9._-]+/g;
const DASH_RUN = /-{2,}/g;
const SEPARATORS = new Set(['-', '.', '_']);
const HANDLE_DROPPED = /[-._ ]/g;

/**
 * The name as its @handle reads, for the reserved-word check: lowercased,
 * with every space, `-`, `.` and `_` gone. Slack drops the hyphens itself, so
 * `slack-bot` would become the handle `slackbot`. Dots and underscores go too:
 * a near-miss refused here costs an admin one retype, while a reserved handle
 * that slips through costs a failed install.
 */
function handleKey(name: string): string {
  return name.toLowerCase().replace(HANDLE_DROPPED, '');
}

/**
 * Whether `raw` is a name Slack will take, and its tidy form: trimmed, with
 * each whitespace run collapsed to one space. Length counts characters (code
 * points), so a name of 18 emoji is refused for its characters, not its length.
 */
export function checkBotName(raw: string): BotNameCheck {
  const name = raw.trim().replace(WHITESPACE_RUN, ' ');
  if (name === '') return { ok: false, reason: 'empty' };
  if (Array.from(name).length > BOT_NAME_MAX) return { ok: false, reason: 'too-long' };
  if (!ALLOWED.test(name) || !LETTER_OR_DIGIT.test(name)) {
    return { ok: false, reason: 'bad-characters' };
  }
  if (RESERVED_BOT_NAMES.has(handleKey(name))) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true, name };
}

/** `s` without `-`, `.` or `_` at either end. A loop, not a regex: no backtracking. */
function trimSeparators(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && SEPARATORS.has(s[start]!)) start += 1;
  while (end > start && SEPARATORS.has(s[end - 1]!)) end -= 1;
  return s.slice(start, end);
}

/**
 * The name we suggest: the "handle form" of the branding name, so the name an
 * admin sees is the @handle people will type. Accents are dropped (NFKD, then
 * every combining mark), the rest is lowercased, each run of anything outside
 * `[a-z0-9._-]` becomes one `-`, separators are trimmed from both ends, and the
 * result is cut to the handle's 21 characters. A result Slack would refuse
 * (nothing left, or a name whose handle is a reserved word, such as
 * `slack-bot`) falls back to `ax`, as does no name.
 */
export function defaultBotName(brandingName: string | null): string {
  if (brandingName === null) return FALLBACK_BOT_NAME;
  const handle = brandingName
    .normalize('NFKD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(NOT_HANDLE, '-')
    .replace(DASH_RUN, '-');
  const cut = trimSeparators(trimSeparators(handle).slice(0, BOT_HANDLE_MAX));
  const check = checkBotName(cut);
  return check.ok ? check.name : FALLBACK_BOT_NAME;
}
