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

// ── Admission ───────────────────────────────────────────────────────────────

/** The longest sender email admitted (admission.ts): `auth:find-user-by-email`'s own cap. */
export const EMAIL_MAX = 320;
/** The longest Slack display name put in a DM's sender label (format.ts), in UTF-16 code units. */
export const SENDER_NAME_MAX = 80;

// ── Slack Web API calls ─────────────────────────────────────────────────────

export const SLACK_API_TIMEOUT_MS = 10_000;
/** Decoded body bytes read from one Slack answer. */
export const SLACK_RESPONSE_CAP_BYTES = 1_048_576;
/** The wait after a rate limit with no usable Retry-After, and the least we ever wait. */
export const RETRY_AFTER_DEFAULT_MS = 1_000;
/** The longest we wait on a rate limit, whatever Retry-After says. */
export const RETRY_AFTER_CAP_MS = 60_000;
/** A Slack id (app, client, user, team, channel) or message ts. Real ones are under 30. */
export const SLACK_ID_MAX = 64;
/**
 * What every check in this package takes for a Slack id or message ts
 * (`T07ABCDEF12`, `Ev07ABCDEF12`, `1763035200.000100`): one pattern, so the
 * events ingress, the Slack client and the settings routes can't drift apart.
 */
export const SLACK_ID_RE = new RegExp(`^[A-Za-z0-9._-]{1,${SLACK_ID_MAX}}$`);
/** A Slack token or secret. Real ones are well under 200. */
export const SLACK_TOKEN_MAX = 512;

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * Channels asked for per `conversations.list` page. Slack: "an integer under
 * 1000", and "We recommend no more than 200 results at a time".
 */
export const CHANNEL_LIST_PAGE_LIMIT = 200;
/**
 * At most this many `conversations.list` pages per channel picker (1,000
 * channels). A workspace with more gets a list marked truncated; a channel
 * past it can still be connected with `/ax connect` from inside it.
 */
export const CHANNEL_LIST_MAX_PAGES = 5;
/**
 * The longest channel name stored on a binding and shown, in UTF-16 code
 * units (label.ts). Slack's own cap on a channel name is 80 characters.
 */
export const CHANNEL_NAME_MAX = 80;

// ── The /ax command ─────────────────────────────────────────────────────────

/** A slash command's request body: a short form (Slack's own fields come to well under 2 KiB). */
export const COMMANDS_MAX_BODY_BYTES = 16_384;
/** The longest `/ax` text read: a subcommand and an agent's name need far less. */
export const SLASH_TEXT_MAX = 512;
/**
 * How long `/ax` waits for its own answer before saying "working on it" and
 * sending the answer privately once it's ready. Slack wants the HTTP answer
 * within 3,000 ms.
 */
export const SLASH_REPLY_DEADLINE_MS = 2_500;
/**
 * The longest agent name `/ax connect` matches, after normalizing: @ax/agents'
 * own cap on a display name. Anything longer names no agent.
 */
export const AGENT_NAME_ARG_MAX = 128;

// ── Agent settings ──────────────────────────────────────────────────────────

/**
 * The longest agent id a settings route takes from its path (printable
 * ASCII). Agent ids are opaque here; real ones are far shorter.
 */
export const AGENT_ID_MAX = 128;

// ── Replies ─────────────────────────────────────────────────────────────────

export const FLUSH_INTERVAL_MS = 1_000;
/** Markdown characters per stream message (Slack refuses past 12,000 over a stream's life). */
export const STREAM_TEXT_LIMIT = 11_000;
/** A stream's age before it is rotated: 9 minutes (Slack ends a stream at 10). */
export const STREAM_MAX_AGE_MS = 540_000;
/** Characters per `chat.postMessage` part when a reply falls back to posting. */
export const POST_PART_LIMIT = 11_000;
export const STATUS_TITLE_MAX = 120;
/**
 * How many times one reply call is tried again after Slack says `ratelimited`
 * (each wait is Slack's Retry-After, at most RETRY_AFTER_CAP_MS) before the
 * reply stops waiting: a stream call then falls back to posting, a post gives up.
 */
export const REPLY_RATE_LIMIT_RETRIES = 5;

// ── Turns ───────────────────────────────────────────────────────────────────

/** Turns running or waiting in one conversation. */
export const MAX_TURNS_PER_CONVERSATION = 3;
/** The longest one DM turn may run: 15 minutes. */
export const TURN_HARD_CAP_MS = 900_000;
/**
 * After `agent:invoke` reports a complete turn, how long the reply waits for
 * that turn's `chat:turn-end` before finishing anyway (the same grace
 * @ax/routines gives a fire).
 */
export const TURN_END_GRACE_MS = 60_000;
