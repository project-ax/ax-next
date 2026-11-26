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
/**
 * Slack cuts the bot's legacy username (users.info `name`), derived from its
 * display name, to this many characters. The @handle people type is the
 * display name itself (bots.ts `handleFrom`).
 */
export const BOT_HANDLE_MAX = 21;

// ── The bot's picture ───────────────────────────────────────────────────────
// Slack's numbers here were read on docs.slack.dev on 2026-11-18 (see
// `.claude/memory/decisions/2026-11-18-TASK-1133.md`).

/**
 * The most decoded bytes of the bot's picture Connect takes (icon.ts):
 * branding's own cap on one logo (`MAX_LOGO_BYTES`). channel-web's
 * `SLACK_AVATAR_MAX_BYTES` (lib/slack-avatar-draw.ts) mirrors it, so the
 * browser never sends a picture this refuses. Neither package imports the
 * other (invariant 2): change both together.
 */
export const SLACK_ICON_MAX_BYTES = 1_048_576;
/** `apps.icon.set`'s `invalid_icon_size`: "between 512x512px and 2000x2000px". */
export const SLACK_ICON_MIN_PX = 512;
export const SLACK_ICON_MAX_PX = 2000;

// ── Installing ──────────────────────────────────────────────────────────────

/** Random bytes in an `installId` (base64url: 22 characters). */
export const INSTALL_ID_BYTES = 16;
/** How long an OAuth `state` stays good: 10 minutes. */
export const OAUTH_STATE_TTL_MS = 600_000;
/** Random bytes in an OAuth `state` (hex: 64 characters). */
export const OAUTH_STATE_BYTES = 32;
/**
 * An admin route's request body: a name, an app id, nothing at all. Connect
 * has its own cap, ADMIN_CONNECT_BODY_MAX_BYTES, because its body can carry
 * the bot's picture.
 */
export const ADMIN_BODY_MAX_BYTES = 16_384;
/**
 * Connect's request body: room for its two pasted tokens and a name (well
 * under 2 KiB, inside ADMIN_BODY_MAX_BYTES) plus the base64 of the largest
 * picture it takes (SLACK_ICON_MAX_BYTES): 1,414,488 bytes.
 */
export const ADMIN_CONNECT_BODY_MAX_BYTES = ADMIN_BODY_MAX_BYTES + Math.ceil(SLACK_ICON_MAX_BYTES / 3) * 4;
/** The longest team name or admin name shown, in UTF-16 code units (label.ts). */
export const LABEL_MAX = 120;
/**
 * The most Slack apps Disconnect couldn't delete that the store lists, oldest
 * first: what one Connect tries to delete and the Slack tab names.
 */
export const LEFTOVER_APPS_MAX = 10;
/**
 * The most open bot requests (TASK-1169) Admin › Slack lists, oldest first.
 * The store's own list is uncapped: an agent has one open request at most,
 * and a name check has to see every one.
 */
export const BOT_REQUESTS_MAX = 20;

// ── A bot request's DMs (TASK-1170, bot-request-dms.ts) ─────────────────────

/**
 * The most AX admins one bot request is DMed to, in the order auth lists
 * them (oldest account first). Each costs up to three Slack calls, one of
 * them users.info, whose budget every sender's admission shares.
 */
export const BOT_REQUEST_DMS_MAX = 20;
/**
 * The most fan-outs one requester starts per BOT_REQUEST_FANOUT_WINDOW_MS. An
 * ask/cancel loop would otherwise have the shared bot DM every admin each
 * time; three still lets a team admin cancel and ask again after a typo.
 */
export const BOT_REQUEST_FANOUTS_MAX = 3;
/** The window BOT_REQUEST_FANOUTS_MAX counts in: 10 minutes. Kept in memory, so a restart starts it over. */
export const BOT_REQUEST_FANOUT_WINDOW_MS = 600_000;
/**
 * The most requests whose DMs are remembered for their redraw (each DM's IM
 * and ts, in memory). Past it the oldest is forgotten: its DMs keep their
 * buttons when someone else answers. A Decline clicked in one still declines
 * a request that is open, and redraws that DM; on one already closed, it says
 * the request was already handled.
 */
export const BOT_REQUEST_DM_RECORDS_MAX = 200;
/** How long a request's DMs are remembered for their redraw: 7 days. */
export const BOT_REQUEST_DM_TTL_MS = 604_800_000;
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
 * The longest channel name stored on a binding and shown, in UTF-16 code
 * units (label.ts). Slack's own cap on a channel name is 80 characters.
 */
export const CHANNEL_NAME_MAX = 80;
/**
 * How long Slack's word that a connected channel is still live and not Slack
 * Connect is trusted before a turn there asks again (channel-check.ts,
 * TASK-1184). A channel archived or shared meanwhile still gets the turns
 * that start within this long.
 */
export const CHANNEL_CHECK_TTL_MS = 60_000;
/** At most this many channels' answers are kept, the oldest forgotten first. */
export const CHANNEL_CHECK_MAX = 1_000;
/**
 * How long a name found for a `<@U…>` in a message (mention-names.ts,
 * TASK-1190) is reused before users.info is asked again. Display text only:
 * a rename shows in the agent's text within this long.
 */
export const MENTION_NAME_TTL_MS = 600_000;
/**
 * At most this many mentioned people's names are kept, the oldest forgotten
 * first; and at most this many installs' rate-limit pauses (mention-names.ts),
 * expired ones forgotten first.
 */
export const MENTION_NAME_CACHE_MAX = 1_000;
/**
 * At most this many users.info calls are spent naming the people one message
 * mentions; any mentioned past them reads as `@someone`. They share Slack's
 * per-token rate limit with admission, which matters more.
 */
export const MENTION_LOOKUPS_PER_MESSAGE = 5;

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

/** Turns running or waiting in one conversation: a DM thread, or one person's in a channel thread. */
export const MAX_TURNS_PER_CONVERSATION = 3;
/**
 * Outsiders' turns running or waiting in one channel, across all its threads
 * (router.ts). Each one runs as the bot's requester (the binding's
 * connector), so this bounds how much of one person's identity, and turn
 * budget, a channel's outsiders can spend at once: one runs, the rest wait,
 * and one more is told the channel is busy.
 */
export const MAX_EXTERNAL_TURNS_PER_CHANNEL = 5;
/** The longest one Slack turn may run: 30 minutes. */
export const TURN_HARD_CAP_MS = 1_800_000;
/**
 * After `agent:invoke` reports a complete turn, how long the reply waits for
 * that turn's `chat:turn-end` before finishing anyway (the same grace
 * @ax/routines gives a fire). Counted again from each chunk of the turn's
 * own that comes after the report (turn.ts `armGrace`).
 */
export const TURN_END_GRACE_MS = 60_000;
/**
 * After `agent:invoke` reports a terminated turn other than
 * `conversation:busy`, how long the reply waits for that turn's own
 * `chat:turn-error`, which carries the reason's detail, before ending with
 * the outcome's reason alone (turn.ts, TASK-1250). The orchestrator fires it
 * before answering on every such exit but one, which races the answer and
 * carries no detail, so this only bounds a turn-error that never comes.
 */
export const TURN_ERROR_WAIT_MS = 5_000;

// ── Memory's speaker rule ───────────────────────────────────────────────────

/**
 * The most speaker names one channel thread keeps (TASK-1146): the names its
 * member's turns were labelled with (format.ts `senderLabelNames`), the most
 * recently seen kept. Two threads' worth, the most one capture check asks
 * about, fit in one `memory:pre-capture` answer
 * (`MEMORY_PRE_CAPTURE_SPEAKER_NAMES_MAX` in core, 32), so the veto never
 * has to refuse over its own names.
 */
export const THREAD_SPEAKER_NAMES_MAX = 16;

// ── Approval prompts ────────────────────────────────────────────────────────
// Slack's numbers in this section were read on 2026-11-14 (see
// `.claude/memory/decisions/2026-11-14-TASK-1095.md`).

/**
 * A button click's request body: one form field holding Slack's JSON about
 * the click, which repeats the clicked message.
 */
export const INTERACTIONS_MAX_BODY_BYTES = 65_536;
/**
 * Random bytes in a prompt's id, the opaque value both of its buttons carry
 * (base64url: 22 characters; Slack caps a button's value at 2,000).
 */
export const PROMPT_ID_BYTES = 16;
/**
 * How long a prompt can be answered in Slack: 24 hours. After that, or after
 * a restart (open prompts live in memory), a click is pointed at Today, where
 * the request still waits.
 */
export const PROMPT_TTL_MS = 86_400_000;
/**
 * At most this many prompts are open at once. Past it, the oldest one nobody
 * is answering is forgotten, and a click on it is pointed at Today.
 */
export const PROMPT_MAX = 1_000;
/**
 * The most people told, once each, that a prompt isn't theirs to answer
 * (prompts.ts `firstRefusal`). Anyone else who clicks it after that is
 * refused without a word: each telling is a Slack call, and only the person
 * who asked can answer anyway.
 */
export const PROMPT_REFUSALS_MAX = 20;
/**
 * The longest prompt subject shown (a decision's summary, a host, or a
 * skill's id, reach and description), in UTF-16 code units (format.ts
 * `cleanPromptSubject`). A skill's is the longest: its sentence (about 25),
 * a 64-character id, a colon and a 240-character description come to 337,
 * and the hosts it reaches come on top. They come before the description
 * (`COPY.skillSubject`), so this cap can only ever cut the description; a
 * skill whose id and reach alone don't fit whole gets the web app's link
 * instead of Allow (permission-prompts.ts `skillPromptFor`), never a cut
 * host list. Slack's cap on a section's text is 3,000.
 */
export const PROMPT_SUBJECT_MAX = 400;
/**
 * The longest host a host prompt keeps (prompts.ts): a DNS name's 253
 * characters, the bound credential-proxy's HOST_RE puts on a host too.
 */
export const PROMPT_HOST_MAX = 253;
/**
 * The most permission prompts (a host the sandbox was refused, a skill the
 * agent asked to use, a skill's link to the web app) one reply posts after
 * it. Each is a message in the thread, and Slack takes about one a second
 * per channel; anything past this is counted in the log
 * (`slack_permission_skipped`). Skills past it get one line after the
 * prompts, counting them and pointing at Today, where they wait (TASK-1155);
 * a host past it is asked about again when the agent needs it.
 */
export const PERMISSION_PROMPTS_PER_TURN_MAX = 3;
/**
 * How long a turn that held a call spends finding that call's decision
 * before it ends with the Today link instead of a prompt.
 */
export const DECISION_LOOKUP_TIMEOUT_MS = 5_000;
/**
 * After an Allow, how long past the moment the agent is woken (the end of
 * the decision's undo window) the thread waits for the agent to start
 * answering. Nothing by then, and the thread stops waiting without a word.
 */
export const CONTINUATION_START_GRACE_MS = 60_000;
/**
 * The longest a thread waits for the moment the agent is woken, however far
 * out the decision's `pendingUntil` says it is. decisions wakes it when the
 * undo window closes (seconds); anything further out is not waited for (and
 * a timer past 2^31-1 ms would fire at once).
 */
export const CONTINUATION_WAKE_MAX_MS = 300_000;
/**
 * How long each step of answering a click may take (answers.ts: the bot
 * token's vault read, a Slack call, an AX lookup, the binding read, the
 * answer itself) before it counts as failed. A step before the answer: the
 * asker is told to try again, and the prompt can be answered again. The
 * answer itself may still be running (an approve can land late), so a timed
 * out answer is not retryable: the asker is told it is still going, and the
 * prompt stays taken, every other click on it silent, until the answer lands
 * and shows what it did. A hang backstop, not a latency goal. A step that
 * hung with no deadline would keep the prompt taken for as long as it hung.
 * Above SLACK_API_TIMEOUT_MS, so a Slack call's own deadline answers first,
 * and well under the hook bus's own 120 s.
 */
export const PROMPT_STEP_TIMEOUT_MS = 30_000;
