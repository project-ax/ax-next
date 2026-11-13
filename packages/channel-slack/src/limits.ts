/**
 * Every cap channel-slack enforces, as one named constant each.
 *
 * Where we sit under one of Slack's own limits, Slack's number is noted beside
 * ours. Those were read from docs.slack.dev on 2026-11-12, not recalled (see
 * `.claude/memory/decisions/2026-11-13-TASK-1093.md`). Lengths are characters
 * unless the name says bytes.
 */

// ── The bot's name ──────────────────────────────────────────────────────────

/** Slack's cap on the app name (`display_information.name`). */
export const BOT_NAME_MAX = 35;
/** Slack cuts the bot's @handle, derived from its display name, to this many characters. */
export const BOT_HANDLE_MAX = 21;

// ── Installing ──────────────────────────────────────────────────────────────

/** Random bytes in an `installId` (base64url: 22 characters). */
export const INSTALL_ID_BYTES = 16;
/** How long an OAuth `state` stays good: 10 minutes. */
export const OAUTH_STATE_TTL_MS = 600_000;
/** Random bytes in an OAuth `state` (hex: 64 characters). */
export const OAUTH_STATE_BYTES = 32;
/** An admin route's request body. Connect's two pasted tokens and a name need well under 2 KiB. */
export const ADMIN_BODY_MAX_BYTES = 16_384;
/** The longest team name or admin name shown, in UTF-16 code units (label.ts). */
export const LABEL_MAX = 120;

// ── Events ingress ──────────────────────────────────────────────────────────

/** How far a request's timestamp may be from our clock, either way. */
export const SIGNATURE_TOLERANCE_S = 300;
/** A signature or timestamp header longer than this is refused unread (real ones: 67 and 10). */
export const SIGNATURE_HEADER_MAX = 8_192;
/** How long an event id is remembered: Slack retries at about 0 s, 1 min and 5 min. */
export const EVENT_DEDUPE_TTL_MS = 3_600_000;
/** At most this many event ids are remembered. */
export const EVENT_DEDUPE_MAX = 10_000;
/** How long an install's signing secret is remembered between vault reads (secret-cache.ts). */
export const SIGNING_SECRET_CACHE_TTL_MS = 60_000;
/** At most this many installs' signing secrets are remembered. */
export const SIGNING_SECRET_CACHE_MAX = 64;
export const EVENTS_MAX_BODY_BYTES = 262_144;
/** A message's text, Slack's own cap. */
export const EVENT_TEXT_MAX = 40_000;
/** A `url_verification` challenge (Slack's are about 48 characters). */
export const URL_CHALLENGE_MAX = 4_096;

// ── Slack Web API calls ─────────────────────────────────────────────────────

export const SLACK_API_TIMEOUT_MS = 10_000;
/** Decoded body bytes read from one Slack answer. */
export const SLACK_RESPONSE_CAP_BYTES = 1_048_576;
/** The wait after a rate limit with no usable Retry-After, and the least we ever wait. */
export const RETRY_AFTER_DEFAULT_MS = 1_000;
/** The longest we wait on a rate limit, whatever Retry-After says. */
export const RETRY_AFTER_CAP_MS = 60_000;
/** A Slack id (app, client, user, team) or message ts. Real ones are under 30. */
export const SLACK_ID_MAX = 64;
/** A Slack token or secret. Real ones are well under 200. */
export const SLACK_TOKEN_MAX = 512;

// ── Replies ─────────────────────────────────────────────────────────────────

export const FLUSH_INTERVAL_MS = 1_000;
/** Markdown characters per stream message (Slack refuses past 12,000 over a stream's life). */
export const STREAM_TEXT_LIMIT = 11_000;
/** A stream's age before it is rotated: 9 minutes (Slack ends a stream at 10). */
export const STREAM_MAX_AGE_MS = 540_000;
/** Characters per `chat.postMessage` part when a reply falls back to posting. */
export const POST_PART_LIMIT = 11_000;
export const STATUS_TITLE_MAX = 120;

// ── Turns ───────────────────────────────────────────────────────────────────

/** Turns running or waiting in one conversation. */
export const MAX_TURNS_PER_CONVERSATION = 3;
/** The longest one DM turn may run: 15 minutes. */
export const TURN_HARD_CAP_MS = 900_000;
