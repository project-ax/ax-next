import type { Logger } from '@ax/core';
import type { RouteHandler, RouteRequest, RouteResponse } from './http-types.js';
import { LifetimeClosedError, type Lifetime } from './lifetime.js';
import {
  EVENT_TEXT_MAX,
  EVENTS_MAX_BODY_BYTES,
  SLACK_ID_MAX,
  URL_CHALLENGE_MAX,
} from './limits.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import { verifySlackSignature } from './signature.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * `POST /slack/events/:installId`: Slack's Events API deliveries for one
 * install. The route is public, so it trusts nothing it hasn't checked, in
 * this order:
 *
 *   0. The body is at most EVENTS_MAX_BODY_BYTES (413). The route's own
 *      `maxBodyBytes` already refused anything larger; this is the backstop.
 *   1. The `installId` is 22 base64url characters AND the raw path spells it
 *      exactly (`params` are percent-decoded), else 404.
 *   2. The install exists, else 404.
 *   3. Its signing secret exists, else 404. Steps 1 to 3 give one answer,
 *      @ax/http-server's own 404 for a path nothing serves (status, headers
 *      and body; plugin.test.ts fetches the real router's to compare), so a
 *      guess can't tell which check refused it. The id's 128 random bits make
 *      the 404/401 split uninformative. Behind a GET catch-all such as
 *      @ax/static-files' `/*`, an unserved POST is a 405, so there this 404
 *      does say the route exists, as it does in every deployment.
 *      The plugin hands this route a store that remembers each install's
 *      signing secret for a minute (secret-cache.ts), so unsigned requests
 *      to a known install cost one vault read a minute, not one each.
 *   4. The v0 signature over the raw bytes, inside the five-minute replay
 *      window both ways, else 401. Nothing about the body is read before this.
 *   5. The body is a JSON object of a shape we accept, else 400.
 *   6. `url_verification` → 200 with the challenge (any status of install).
 *   7. `event_callback` for another app, a pending install or another
 *      workspace → 200 and ignored; our own bot's message → 200 and ignored;
 *      an `event_id` already seen → 200 and ignored. Otherwise the event id
 *      is recorded, 200 goes out, and only then the dispatch starts, tracked
 *      by the lifetime and never awaited: Slack wants its answer within 3 s,
 *      and a turn takes longer.
 *   8. Anything else → 200 and ignored.
 *   After `stopAdmission` every request gets 503, so Slack retries against
 *   the next pod.
 *
 * Event ids are recorded only after the signature passes, so a forged request
 * can't make the real event look like a repeat. The record is in memory and
 * bounded (createSeenEvents); the chart pins one replica, and a restart inside
 * Slack's retry window can replay one event (a stated residual).
 *
 * Logs name only the install and a reason, stage or code. Never a header, the
 * body, a Slack id, message text or an error's message.
 */

export const INSTALL_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** The path `http:register-route` serves the handler on. */
export const EVENTS_ROUTE_PATH = '/slack/events/:installId';
const EVENTS_PATH_PREFIX = '/slack/events/';

export interface SlackInnerEvent {
  type: string;
  subtype?: string;
  user?: string;
  botId?: string;
  text?: string;
  channel?: string;
  channelType?: string;
  ts?: string;
  threadTs?: string;
}

export interface SlackEnvelope {
  teamId: string;
  apiAppId: string;
  eventId: string;
  isExtSharedChannel: boolean;
  event: SlackInnerEvent;
}

export type ParsedBody =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'event_callback'; envelope: SlackEnvelope }
  | { kind: 'other' };

/** What a verified, new event for an active install is handed to. */
export type EventDispatcher = (install: InstallRow, envelope: SlackEnvelope) => Promise<void>;

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Slack ids and message timestamps: `T07ABCDEF12`, `Ev07ABCDEF12`, `1763035200.000100`. */
const SLACK_ID = new RegExp(`^[A-Za-z0-9._-]{1,${SLACK_ID_MAX}}$`);
/** Event types and subtypes, channel types: `message`, `app_mention`, `file_share`, `im`. */
const SLACK_NAME = /^[a-z0-9_.]{1,64}$/;

type Check = (value: unknown) => value is string;
const isId: Check = (v): v is string => typeof v === 'string' && SLACK_ID.test(v);
const isName: Check = (v): v is string => typeof v === 'string' && SLACK_NAME.test(v);
const isText: Check = (v): v is string => typeof v === 'string' && v.length <= EVENT_TEXT_MAX;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The inner event's optional fields: our name, Slack's name, and the check. */
const OPTIONAL_EVENT_FIELDS = [
  ['subtype', 'subtype', isName],
  ['user', 'user', isId],
  ['botId', 'bot_id', isId],
  ['text', 'text', isText],
  ['channel', 'channel', isId],
  ['channelType', 'channel_type', isName],
  ['ts', 'ts', isId],
  ['threadTs', 'thread_ts', isId],
] as const satisfies ReadonlyArray<readonly [keyof SlackInnerEvent, string, Check]>;

/**
 * The inner event, or null when it is malformed. A missing or null optional
 * field is absent; a present one that fails its check is malformed (fail
 * closed: a `bot_id` we can't read must not read as "not a bot").
 */
function parseEvent(raw: unknown): SlackInnerEvent | null {
  if (!isRecord(raw) || !isName(raw['type'])) return null;
  const event: SlackInnerEvent = { type: raw['type'] };
  for (const [key, wire, check] of OPTIONAL_EVENT_FIELDS) {
    const value = raw[wire];
    if (value === undefined || value === null) continue;
    if (!check(value)) return null;
    event[key] = value;
  }
  return event;
}

function parseEnvelope(json: Record<string, unknown>): SlackEnvelope | null {
  const teamId = json['team_id'];
  const apiAppId = json['api_app_id'];
  const eventId = json['event_id'];
  const ext = json['is_ext_shared_channel'];
  if (!isId(teamId) || !isId(apiAppId) || !isId(eventId)) return null;
  if (ext !== undefined && ext !== null && typeof ext !== 'boolean') return null;
  const event = parseEvent(json['event']);
  if (event === null) return null;
  return { teamId, apiAppId, eventId, isExtSharedChannel: ext === true, event };
}

/**
 * A verified body, already JSON-parsed. Null when it isn't a JSON object, or
 * is a `url_verification` or `event_callback` we can't read: the caller
 * answers 400. Only the fields above are kept; everything else is dropped.
 */
export function parseBody(json: unknown): ParsedBody | null {
  if (!isRecord(json)) return null;
  const type = json['type'];
  if (type === 'url_verification') {
    const challenge = json['challenge'];
    if (
      typeof challenge !== 'string' ||
      challenge.length === 0 ||
      challenge.length > URL_CHALLENGE_MAX
    ) {
      return null;
    }
    return { kind: 'url_verification', challenge };
  }
  if (type === 'event_callback') {
    const envelope = parseEnvelope(json);
    return envelope === null ? null : { kind: 'event_callback', envelope };
  }
  return { kind: 'other' };
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

/**
 * Event ids seen in the last `ttlMs`, at most `max` of them (the oldest goes
 * first). `firstSighting` records the id and answers true the first time,
 * false while it is remembered. Ids arrive in time order, so expiry walks
 * from the oldest end.
 */
export function createSeenEvents(o: { ttlMs: number; max: number }): {
  firstSighting(eventId: string, nowMs: number): boolean;
} {
  if (!Number.isSafeInteger(o.ttlMs) || o.ttlMs <= 0 || !Number.isSafeInteger(o.max) || o.max <= 0) {
    throw new RangeError('createSeenEvents: ttlMs and max must be positive integers');
  }
  const { ttlMs, max } = o;
  const seenAt = new Map<string, number>();
  return {
    firstSighting(eventId, nowMs) {
      for (const [id, at] of seenAt) {
        if (nowMs - at < ttlMs) break;
        seenAt.delete(id);
      }
      const at = seenAt.get(eventId);
      if (at !== undefined && nowMs - at < ttlMs) return false;
      seenAt.delete(eventId);
      while (seenAt.size >= max) {
        const oldest = seenAt.keys().next();
        if (oldest.done === true) break;
        seenAt.delete(oldest.value);
      }
      seenAt.set(eventId, nowMs);
      return true;
    },
  };
}

// ── The handler ─────────────────────────────────────────────────────────────

export interface EventsHandlerDeps {
  store: Pick<InstallStore, 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  lifetime: Lifetime;
  seen: ReturnType<typeof createSeenEvents>;
  dispatch: EventDispatcher;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
}

type IgnoreReason = 'app' | 'status' | 'team' | 'duplicate' | 'other';
type FailedStage = 'install' | 'secret' | 'dispatch';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * @ax/http-server's own answer for a path no route serves. Pinned against the
 * real router (plugin.test.ts) and the memory canary, not by a copy of it.
 */
function notFound(res: RouteResponse): void {
  res.status(404).json({ error: 'not-found' });
}

export function createEventsHandler(d: EventsHandlerDeps): RouteHandler {
  // A log line never changes the answer Slack gets.
  const log = (level: 'info' | 'warn', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  const failed = (installId: string, stage: FailedStage, err: unknown): void => {
    log('warn', 'slack_event_failed', { installId, stage, code: logCode(err) });
  };
  const ignored = (installId: string, reason: IgnoreReason): void => {
    log('info', 'slack_event_ignored', { installId, reason });
  };
  const refused = (installId: string, reason: 'signature' | 'malformed'): void => {
    log('warn', 'slack_event_refused', { installId, reason });
  };

  async function handle(req: RouteRequest, res: RouteResponse): Promise<void> {
    if (req.body.length > EVENTS_MAX_BODY_BYTES) {
      res.status(413).json({ error: 'body-too-large' });
      return;
    }

    const installId = Object.hasOwn(req.params, 'installId') ? req.params['installId'] : undefined;
    if (
      installId === undefined ||
      !INSTALL_ID_RE.test(installId) ||
      req.rawPath !== EVENTS_PATH_PREFIX + installId
    ) {
      notFound(res);
      return;
    }

    let install: InstallRow | null;
    try {
      install = await d.store.get(installId);
    } catch (err) {
      failed(installId, 'install', err);
      res.status(503).end();
      return;
    }
    if (install === null) {
      notFound(res);
      return;
    }

    let signingSecret: string | null;
    try {
      signingSecret = await d.secrets.get(install, 'signing-secret');
    } catch (err) {
      failed(installId, 'secret', err);
      res.status(503).end();
      return;
    }
    if (signingSecret === null || signingSecret.length === 0) {
      notFound(res);
      return;
    }

    const nowMs = d.now();
    if (!verifySlackSignature({ headers: req.headers, body: req.body, signingSecret, nowMs })) {
      refused(installId, 'signature');
      res.status(401).end();
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(utf8.decode(req.body));
    } catch {
      json = undefined;
    }
    const parsed = parseBody(json);
    if (parsed === null) {
      refused(installId, 'malformed');
      res.status(400).end();
      return;
    }
    if (parsed.kind === 'url_verification') {
      res.status(200).json({ challenge: parsed.challenge });
      return;
    }
    if (parsed.kind === 'other') {
      ignored(installId, 'other');
      res.status(200).end();
      return;
    }

    const { envelope } = parsed;
    const mismatch: IgnoreReason | null =
      envelope.apiAppId !== install.appId
        ? 'app'
        : install.status !== 'active'
          ? 'status'
          : envelope.teamId !== install.teamId
            ? 'team'
            : null;
    if (mismatch !== null) {
      ignored(installId, mismatch);
      res.status(200).end();
      return;
    }
    // Our bot's own messages (its replies) come back as events: never answer them.
    if (envelope.event.user !== undefined && envelope.event.user === install.botUserId) {
      res.status(200).end();
      return;
    }
    if (!d.seen.firstSighting(`${install.installId}:${envelope.eventId}`, nowMs)) {
      ignored(installId, 'duplicate');
      res.status(200).end();
      return;
    }

    const active = install;
    try {
      res.status(200).end();
    } finally {
      // The id is recorded, so a retry would be dropped: the dispatch runs
      // even if writing the 200 failed.
      void d.lifetime
        .track(() => d.dispatch(active, envelope))
        .catch((err: unknown) => failed(installId, 'dispatch', err));
    }
  }

  return async (req, res) => {
    let admitted = false;
    try {
      await d.lifetime.admit(() => {
        admitted = true;
        return handle(req, res);
      });
    } catch (err) {
      if (!admitted && err instanceof LifetimeClosedError) {
        res.status(503).end();
        return;
      }
      throw err;
    }
  };
}
