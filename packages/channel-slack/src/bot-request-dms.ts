import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { admitSender, findSenderUser, isTemporaryLookupFailure, isTemporarySlackCode } from './admission.js';
import { botRequestBlocks, botRequestOutcomeBlocks } from './blocks.js';
import { agentSeenBy } from './bot-requests.js';
import { COPY } from './copy.js';
import type { Lifetime } from './lifetime.js';
import {
  BOT_REQUEST_DMS_MAX,
  BOT_REQUEST_DM_RECORDS_MAX,
  BOT_REQUEST_DM_TTL_MS,
  BOT_REQUEST_FANOUTS_MAX,
  BOT_REQUEST_FANOUT_WINDOW_MS,
  EMAIL_MAX,
} from './limits.js';
import { logCode } from './log-code.js';
import { withoutTrailingSlashes } from './manifest.js';
import { personName } from './person-name.js';
import type { SecretStore } from './secrets.js';
import { isRecord } from './slack-apps.js';
import type { SlackApi } from './slack-api.js';
import type { InstallRow, InstallStore } from './store.js';

/**
 * A bot request's Slack DMs (TASK-1170; design
 * docs/plans/2026-11-09-channel-slack-design.md §4 steps 2 and 4). The shared
 * bot (Admin › Slack's app) DMs the AX admins when a team admin asks for
 * their agent's own bot (bot-requests.ts `ask` → `opened`): who asked, the
 * bot's name and the agent, then Approve, a link to Admin › Slack (a token is
 * never pasted into Slack), and Decline, whose value is the request id (the
 * click's gate is bot-request-click.ts). Once the request is approved (a bot
 * made) or declined, each of those DMs is redrawn with who did it where the
 * buttons were (`closed`).
 *
 * The requester hears from the shared bot only when someone else answered
 * (D9; the self path's own browser saw how it went): that their request was
 * declined (`closed`), or, at the approver's Allow (bot-callback.ts →
 * `live`), that the bot is live and how to invite it.
 * An approve itself tells them nothing yet. The rule lives here only: the
 * callers call unconditionally.
 *
 * Who gets a DM (design decision D2). The Decline click's own identity rule,
 * so everyone DMed can also Decline: `users.lookupByEmail` with the address
 * auth verified (`auth:list-admins`) gives a Slack id and nothing else;
 * `admitSender` (users.info) must admit that account, a full member of the
 * shared workspace whose email Slack confirmed; and `auth:find-user-by-email`
 * on THAT confirmed email must answer the same AX account. Anyone else gets
 * nothing: an admin Slack doesn't know, a guest, a deactivated or unconfirmed
 * account, or one whose Slack email is another AX account's or nobody's. The
 * requester is never asked about their own request. Their own notices take
 * the same path from the email `auth:get-user` has for them, which nothing
 * says a provider verified: the map-back is what proves it.
 *
 * Bounds (D3, D4). At most BOT_REQUEST_DMS_MAX admins per request, in the
 * order auth lists them, and at most BOT_REQUEST_FANOUTS_MAX fan-outs per
 * requester per BOT_REQUEST_FANOUT_WINDOW_MS: an ask/cancel loop would
 * otherwise have the shared bot DM every admin each time, and spend the
 * users.info budget every sender's admission shares. A fan-out stops at its
 * first temporary Slack failure (`isTemporarySlackCode`); any other failure
 * skips that one admin. Where each DM went (its IM and ts, never a token) is
 * kept in memory for the redraw, for at most BOT_REQUEST_DM_RECORDS_MAX
 * requests and BOT_REQUEST_DM_TTL_MS. After a restart, or past either bound,
 * old DMs aren't redrawn when someone else answers: they keep their buttons.
 * The request itself is on Postgres, so a Decline clicked in one still
 * declines a request that is open, and that DM is redrawn (under the ask
 * itself: the subject it was drawn with is gone); on one already closed,
 * the click says it was already handled (bot-request-click.ts).
 *
 * A close during the fan-out (D8). `closed` marks the request closing before
 * it awaits anything, and the fan-out checks that before each admin and
 * again right before each post, so no DM goes out once the close is known. A
 * DM already on its way is redrawn exactly once: the close sets its line and
 * copies the list of DMs posted so far in one synchronous step, and the
 * fan-out redraws any DM it records after that itself. The DM a Decline was
 * clicked in joins that list in the same step, if the fan-out hasn't
 * recorded it yet, and the fan-out then leaves it to the close.
 *
 * A cancel (bot-requests.ts → `forget`) redraws nothing: it marks the
 * request closing and drops its record at once, so a fan-out still running
 * sends no more, and its slot is free. A Decline clicked in a DM about it
 * finds the request gone.
 *
 * Off the request path (D5). Every method that awaits anything runs it
 * tracked by the plugin's lifetime (shutdown drains it; `forget` awaits
 * nothing), takes no lock, and returns a promise that never rejects.
 * Callers call after the app lock is free and never await it: a DM that
 * fails never changes an answer, and the request still waits in Admin ›
 * Slack.
 *
 * What the bot says is COPY's. Outside names (the requester's display name,
 * never their email; the bot's and the agent's names) reach Slack only as the
 * admin DM's plain_text subject (blocks.ts), or through COPY's `shown` in the
 * requester's notices. A notification names nobody.
 *
 * Log lines are code-only: `slack_bot_request_dms_sent { requestId, sent,
 * skipped }` once per fan-out, `slack_bot_request_dms_skipped { requestId,
 * reason }` for a fan-out not started, `slack_bot_request_dm_admin_skipped
 * { requestId, stage, code }` for each admin it can't reach (Slack doesn't
 * know them at `lookup`, `admission` refused them, or their Slack email maps
 * elsewhere at `find-user`), `slack_bot_request_owner_dm_sent { requestId |
 * installId, notice }`, and `slack_bot_request_dm_failed { requestId |
 * installId, stage, code }` (plus admission.ts's own `slack_sender_not_mapped
 * { installId }` for a confirmed Slack email no AX account has). Never an
 * email, a name, a person's or an agent's id, a Slack user or channel id, a
 * ts, or a token.
 */

export interface BotRequestDmsDeps {
  bus: HookBus;
  /** The shared bot's calls: find a person by email, admit them (users.info), DM them, redraw a DM. No others. */
  api: Pick<SlackApi, 'usersLookupByEmail' | 'usersInfo' | 'postDirect' | 'updateMessage'>;
  installs: Pick<InstallStore, 'current' | 'get'>;
  secrets: Pick<SecretStore, 'get'>;
  /** Every DM runs tracked: shutdown drains it. */
  lifetime: Pick<Lifetime, 'track'>;
  /** For the Approve link: `<origin>/?admin=slack`. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch ms: the fan-out window and the records' TTL. */
  now: () => number;
}

export interface BotRequestDms {
  /**
   * A request just opened: DM the AX admins. Call it after the app lock is
   * free, and never await it on a request path. Never rejects.
   */
  opened(i: { requestId: string; agentId: string; requesterUserId: string; botName: string }): Promise<void>;
  /**
   * A request was approved (a bot made) or declined, by `byUserId`: redraw
   * the admins' DMs, and tell the requester of a decline that isn't their
   * own. `clicked` is the DM a Slack Decline was clicked in
   * (bot-request-click.ts): it is redrawn too, once, even when nothing was
   * kept for the request (a restart, the TTL or the cap forgot it) or its
   * post looked failed. Call it after the app lock is free, and never await
   * it on a request path. Never rejects.
   */
  closed(i: {
    requestId: string;
    requesterUserId: string;
    botName: string;
    outcome: 'approved' | 'declined';
    byUserId: string;
    clicked?: PostedDm;
  }): Promise<void>;
  /**
   * A request was taken back (its team cancelled it): forget its DMs. A
   * fan-out still running sends no more, and nothing is redrawn: a Decline
   * clicked in one finds the request gone. Call it after the app lock is
   * free. It has nothing to await (all of it is done before it returns), so
   * nothing is left for shutdown to drain. Never rejects.
   */
  forget(i: { requestId: string }): Promise<void>;
  /**
   * A team agent's own bot just went live (its approver's Allow): when an AX
   * admin approved it for someone else, its requester hears. Call it after
   * the app lock is free, for every connected Allow. Never rejects.
   */
  live(i: { installId: string }): Promise<void>;
}

/** channel-web's link into Admin › Slack (its lib/slack-admin-link.ts): keep the two in step. */
const ADMIN_SLACK_LINK = '/?admin=slack';
/** users.lookupByEmail's own "nobody here has that address": a miss, not a failure. */
const USERS_NOT_FOUND = 'users_not_found';
const SESSION = 'channel-slack';

/** What a log line is about: the request, or (once it went live) the bot's install. */
type LogKey = { requestId: string } | { installId: string };

/** The shared bot, as one piece of work needs it. The token never outlives that work. */
interface Workspace {
  installId: string;
  teamId: string;
  token: string;
}

/** One DM posted: its IM and ts, all a redraw needs. */
export interface PostedDm {
  channel: string;
  ts: string;
}

const sameDm = (a: PostedDm, b: PostedDm): boolean => a.channel === b.channel && a.ts === b.ts;

/** One request's DMs, kept for the redraw (D3, D8). */
interface DmRecord {
  /** When its fan-out began (epoch ms): the TTL counts from here. */
  at: number;
  /** The shared install the DMs went through; null until the fan-out has it. */
  installId: string | null;
  /** The subject exactly as the DMs were drawn with it; null until the fan-out builds it. */
  subject: string | null;
  /** Every DM posted, in order. */
  sent: PostedDm[];
  /** Set by `closed` before it awaits anything: no DM goes out after it. */
  closing: boolean;
  /** The close's line, once known: a DM recorded after it is the fan-out's to redraw. */
  line: string | null;
}

/**
 * Whether one AX person can be DMed in the shared workspace (D2). If not:
 * `absent` (Slack doesn't know them, admission refused them, or their Slack
 * email isn't theirs in AX), `temporary` (Slack briefly not there: a fan-out
 * stops), or `failed` (anything else), with the stage it stopped at and a
 * code.
 */
type Reach =
  | { ok: true; slackUserId: string }
  | { ok: false; why: 'absent' | 'temporary' | 'failed'; stage: string; code: string };

type Opened = Parameters<BotRequestDms['opened']>[0];
type Closed = Parameters<BotRequestDms['closed']>[0];

export function createBotRequestDms(d: BotRequestDmsDeps): BotRequestDms {
  const approveUrl = `${withoutTrailingSlashes(d.publicOrigin)}${ADMIN_SLACK_LINK}`;
  /** Each request's DMs, by its id, oldest first (insertion order). */
  const records = new Map<string, DmRecord>();
  /** When each requester's fan-outs inside the window began, by their id. */
  const fanOuts = new Map<string, number[]>();

  /** A ctx for a lookup about a person: no agent, and the person when there is one. */
  const ctxOf = (userId: string): AgentContext =>
    makeAgentContext({ sessionId: SESSION, agentId: '', userId, logger: d.logger });

  /** A log line never changes what a DM does. */
  const log = (level: 'info' | 'warn', msg: string, fields: Record<string, string | number>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  const failed = (key: LogKey, stage: string, code: string): void =>
    log('warn', 'slack_bot_request_dm_failed', { ...key, stage, code });
  /** One admin the fan-out can't reach (D2), and which check said so. */
  const skipped = (key: LogKey, stage: string, code: string): void =>
    log('info', 'slack_bot_request_dm_admin_skipped', { ...key, stage, code });

  /** Forget what has outlived its TTL or window, then make room for one more record. */
  function prune(now: number): void {
    for (const [requestId, record] of records) {
      if (now - record.at >= BOT_REQUEST_DM_TTL_MS) records.delete(requestId);
    }
    for (const requestId of records.keys()) {
      if (records.size < BOT_REQUEST_DM_RECORDS_MAX) break;
      records.delete(requestId);
    }
    for (const [userId, times] of fanOuts) {
      const recent = times.filter((t) => now - t < BOT_REQUEST_FANOUT_WINDOW_MS);
      if (recent.length === 0) fanOuts.delete(userId);
      else fanOuts.set(userId, recent);
    }
  }

  /** The install `read` answers, if it is there and live, with its bot token; else null, logged. */
  async function liveInstall(key: LogKey, read: () => Promise<InstallRow | null>): Promise<Workspace | null> {
    let install: InstallRow | null;
    try {
      install = await read();
    } catch (err) {
      failed(key, 'workspace', logCode(err));
      return null;
    }
    if (install === null) {
      failed(key, 'workspace', 'missing');
      return null;
    }
    const teamId = install.teamId;
    if (install.status !== 'active' || teamId === null) {
      failed(key, 'workspace', 'inactive');
      return null;
    }
    let token: string | null;
    try {
      token = await d.secrets.get(install, 'bot-token');
    } catch (err) {
      failed(key, 'bot-token', logCode(err));
      return null;
    }
    if (token === null) {
      failed(key, 'bot-token', 'missing');
      return null;
    }
    return { installId: install.installId, teamId, token };
  }

  /**
   * D2: the Slack account to DM for one AX person, or why there is none. The
   * lookup's answer gives only an id: who that is comes from users.info
   * (admission.ts), and the email Slack confirmed must map back to this very
   * account, or they couldn't Decline what they were sent.
   */
  async function memberFor(ws: Workspace, ax: { userId: string; email: string }): Promise<Reach> {
    let slackUserId: string;
    try {
      slackUserId = await d.api.usersLookupByEmail(ws.token, ax.email);
    } catch (err) {
      const code = logCode(err);
      if (code === USERS_NOT_FOUND) return { ok: false, why: 'absent', stage: 'lookup', code };
      return { ok: false, why: isTemporarySlackCode(code) ? 'temporary' : 'failed', stage: 'lookup', code };
    }
    const admission = await admitSender(d.api, ws.token, slackUserId, ws.teamId);
    if (!admission.ok) {
      const code = admission.code ?? admission.reason;
      if (isTemporaryLookupFailure(admission)) return { ok: false, why: 'temporary', stage: 'admission', code };
      // A refusal is about the account; a users.info call that failed otherwise is a failure.
      return { ok: false, why: admission.reason === 'lookup-failed' ? 'failed' : 'absent', stage: 'admission', code };
    }
    let mapped: string | null;
    try {
      mapped = await findSenderUser(d.bus, ctxOf(''), admission.email, { installId: ws.installId, logger: d.logger });
    } catch (err) {
      return { ok: false, why: 'failed', stage: 'find-user', code: logCode(err) };
    }
    if (mapped !== ax.userId) return { ok: false, why: 'absent', stage: 'find-user', code: 'not-mapped' };
    return { ok: true, slackUserId };
  }

  /** One DM redrawn with `line` where its buttons were. A failure is logged, never thrown. */
  async function redraw(key: LogKey, token: string, subject: string, dm: PostedDm, line: string): Promise<void> {
    try {
      await d.api.updateMessage(token, { channel: dm.channel, ts: dm.ts, ...botRequestOutcomeBlocks({ subject, line }) });
    } catch (err) {
      failed(key, 'update', logCode(err));
    }
  }

  /**
   * Whom to ask, from `auth:list-admins`: each entry auth could name, once,
   * never the requester, the first BOT_REQUEST_DMS_MAX in auth's order. Null
   * (logged) when the list can't be had.
   */
  async function adminsToAsk(key: LogKey, requesterUserId: string): Promise<Array<{ userId: string; email: string }> | null> {
    let out: unknown;
    try {
      out = await d.bus.call<Record<string, never>, unknown>('auth:list-admins', ctxOf(''), {});
    } catch (err) {
      failed(key, 'admins', logCode(err));
      return null;
    }
    const listed = isRecord(out) ? out['admins'] : undefined;
    if (!Array.isArray(listed)) {
      failed(key, 'admins', 'bad-answer');
      return null;
    }
    const admins: Array<{ userId: string; email: string }> = [];
    // The requester is never asked about their own request, and nobody twice.
    const seen = new Set<string>([requesterUserId]);
    for (const entry of listed) {
      if (admins.length >= BOT_REQUEST_DMS_MAX) break;
      if (!isRecord(entry)) continue;
      const userId = entry['userId'];
      const email = entry['email'];
      if (typeof userId !== 'string' || userId === '' || seen.has(userId)) continue;
      if (typeof email !== 'string' || email === '' || email.length > EMAIL_MAX) continue;
      seen.add(userId);
      admins.push({ userId, email });
    }
    return admins;
  }

  async function fanOut(i: Opened, record: DmRecord): Promise<void> {
    const key = { requestId: i.requestId };
    const ws = await liveInstall(key, () => d.installs.current());
    if (ws === null) return;
    record.installId = ws.installId;
    const admins = await adminsToAsk(key, i.requesterUserId);
    if (admins === null) return;
    let sent = 0;
    if (admins.length > 0) {
      // Who asked, by display name only (never their email: Slack keeps a copy), and the agent as they see it.
      const asRequester = ctxOf(i.requesterUserId);
      const [requester, agent] = await Promise.all([
        personName(d.bus, asRequester, i.requesterUserId, {
          allowEmail: false,
          fallback: COPY.botRequestRequesterFallback,
          onFault: (err) => failed(key, 'requester', logCode(err)),
        }),
        agentSeenBy(d.bus, asRequester, { agentId: i.agentId, requestedByUserId: i.requesterUserId }, (err) =>
          failed(key, 'agent', logCode(err)),
        ),
      ]);
      const subject = COPY.botRequestSubject({ requester, botName: i.botName, agentName: agent.name });
      record.subject = subject;
      const message = botRequestBlocks({ subject, requestId: i.requestId, approveUrl });
      for (const admin of admins) {
        if (record.closing) break;
        const reach = await memberFor(ws, admin);
        if (!reach.ok) {
          // Not reachable is no fault, but an operator can still see why: by stage and code alone.
          if (reach.why === 'absent') skipped(key, reach.stage, reach.code);
          else failed(key, reach.stage, reach.code);
          if (reach.why === 'temporary') break;
          continue;
        }
        // A close that landed while they were looked up: nothing more goes out.
        if (record.closing) break;
        let dm: PostedDm;
        try {
          dm = await d.api.postDirect(ws.token, { user: reach.slackUserId, ...message });
        } catch (err) {
          const code = logCode(err);
          failed(key, 'post', code);
          if (isTemporarySlackCode(code)) break;
          continue;
        }
        sent += 1;
        // Recorded and checked in one step (D8): before the close's line is
        // set, the close redraws this DM; after it, this does. Unless the
        // close has it already: the DM a Decline was clicked in, before this
        // post's answer came back.
        if (record.sent.some((posted) => sameDm(posted, dm))) continue;
        record.sent.push(dm);
        if (record.line !== null) await redraw(key, ws.token, subject, dm, record.line);
      }
    }
    log('info', 'slack_bot_request_dms_sent', { requestId: i.requestId, sent, skipped: admins.length - sent });
  }

  /**
   * Every admin DM `record` kept, and the one a Decline was clicked in, each
   * redrawn once with who approved or declined it. With no record (a
   * restart, the TTL or the cap forgot it), only the clicked one: under the
   * ask itself (the subject it was drawn with is gone), through the shared
   * install there is now.
   */
  async function redrawAll(key: LogKey, i: Closed, record: DmRecord | undefined): Promise<void> {
    const { clicked } = i;
    if (record === undefined && clicked === undefined) return;
    // Who did it, by display name only.
    const name = await personName(d.bus, ctxOf(''), i.byUserId, {
      allowEmail: false,
      fallback: COPY.botRequestAdminFallback,
      onFault: (err) => failed(key, 'closed-by', logCode(err)),
    });
    const line = i.outcome === 'approved' ? COPY.botRequestApproved(name) : COPY.botRequestDeclined(name);
    let posted: PostedDm[] = clicked === undefined ? [] : [clicked];
    let subject = '';
    let installId: string | null = null;
    if (record !== undefined) {
      // One synchronous step (D8): a DM recorded before this is in `posted`
      // and redrawn here; one recorded after it, the fan-out redraws itself.
      // The clicked DM is this close's, recorded now if the fan-out hasn't
      // (its post's answer may still be on its way), so the fan-out leaves it.
      record.line = line;
      if (clicked !== undefined && !record.sent.some((dm) => sameDm(dm, clicked))) record.sent.push({ ...clicked });
      // The clicked DM first: its redraw is the clicker's only answer, so it
      // doesn't wait behind every other admin's.
      posted =
        clicked === undefined
          ? [...record.sent]
          : [{ ...clicked }, ...record.sent.filter((dm) => !sameDm(dm, clicked))];
      subject = record.subject ?? '';
      installId = record.installId;
    }
    if (posted.length === 0) return;
    // The token of the install the DMs went through, read again: none is kept.
    const ws = await liveInstall(key, () => (installId === null ? d.installs.current() : d.installs.get(installId)));
    if (ws === null) return;
    for (const dm of posted) await redraw(key, ws.token, subject, dm, line);
  }

  /**
   * One DM from the shared bot to the requester, `text` and no blocks, if
   * they can be found (D2, from the email auth has for them). Whatever stops
   * it is logged, and nothing is retried.
   */
  async function notifyOwner(
    key: LogKey,
    ws: Workspace,
    requesterUserId: string,
    notice: 'live' | 'declined',
    text: string,
  ): Promise<void> {
    let user: unknown;
    try {
      user = await d.bus.call<{ userId: string }, unknown>('auth:get-user', ctxOf(''), { userId: requesterUserId });
    } catch (err) {
      failed(key, 'owner-email', logCode(err));
      return;
    }
    if (user === null) {
      failed(key, 'owner-email', 'no-account');
      return;
    }
    // Only an answer about this very person.
    if (!isRecord(user) || user['id'] !== requesterUserId) {
      failed(key, 'owner-email', 'bad-answer');
      return;
    }
    const email = user['email'];
    if (typeof email !== 'string' || email === '' || email.length > EMAIL_MAX) {
      failed(key, 'owner-email', 'no-email');
      return;
    }
    // auth doesn't say a provider verified this address: Slack's confirmed email mapping back is the proof.
    const reach = await memberFor(ws, { userId: requesterUserId, email });
    if (!reach.ok) {
      failed(key, reach.stage, reach.code);
      return;
    }
    try {
      await d.api.postDirect(ws.token, { user: reach.slackUserId, text });
    } catch (err) {
      failed(key, 'post', logCode(err));
      return;
    }
    log('info', 'slack_bot_request_owner_dm_sent', { ...key, notice });
  }

  async function close(i: Closed, record: DmRecord | undefined): Promise<void> {
    const key = { requestId: i.requestId };
    await redrawAll(key, i, record);
    // The requester hears of a decline unless it was their own. An approve
    // tells them nothing yet: they hear when the bot goes live.
    if (i.outcome !== 'declined' || i.byUserId === i.requesterUserId) return;
    const ws = await liveInstall(key, () => d.installs.current());
    if (ws === null) return;
    await notifyOwner(key, ws, i.requesterUserId, 'declined', COPY.botDeclinedForOwner(i.botName));
  }

  async function announce(installId: string): Promise<void> {
    const key = { installId };
    const bot = await d.installs.get(installId);
    if (bot === null || bot.kind !== 'bot' || bot.status !== 'active' || bot.agentId === null) return;
    // Only one an AX admin approved for someone else: on the self path, the
    // requester's own browser saw it go live.
    const requester = bot.requestedByUserId;
    if (requester === null || requester === bot.connectedByUserId) return;
    const ws = await liveInstall(key, () => d.installs.current());
    if (ws === null) return;
    const text = COPY.botLiveForOwner({ botName: bot.botName, handle: bot.botHandle });
    await notifyOwner(key, ws, requester, 'live', text);
  }

  return {
    async opened(i) {
      try {
        // All of this before anything is awaited, so a `closed` that follows always finds the record.
        const now = d.now();
        prune(now);
        const recent = fanOuts.get(i.requesterUserId) ?? [];
        if (recent.length >= BOT_REQUEST_FANOUTS_MAX) {
          log('warn', 'slack_bot_request_dms_skipped', { requestId: i.requestId, reason: 'too-many-asks' });
          return;
        }
        fanOuts.set(i.requesterUserId, [...recent, now]);
        const record: DmRecord = { at: now, installId: null, subject: null, sent: [], closing: false, line: null };
        records.set(i.requestId, record);
        await d.lifetime.track(() => fanOut(i, record));
      } catch (err) {
        failed({ requestId: i.requestId }, 'fan-out', logCode(err));
      }
    },

    async closed(i) {
      try {
        // Before anything is awaited: the fan-out posts nothing more from here on.
        const found = records.get(i.requestId);
        let record: DmRecord | undefined;
        if (found !== undefined) {
          found.closing = true;
          // A request closes once.
          records.delete(i.requestId);
          // Past its TTL it was as good as forgotten.
          if (d.now() - found.at < BOT_REQUEST_DM_TTL_MS) record = found;
        }
        await d.lifetime.track(() => close(i, record));
      } catch (err) {
        failed({ requestId: i.requestId }, 'close', logCode(err));
      }
    },

    async forget(i) {
      // As a close marks it, before anything else: the fan-out posts nothing more from here on.
      const found = records.get(i.requestId);
      if (found === undefined) return;
      found.closing = true;
      records.delete(i.requestId);
    },

    async live(i) {
      try {
        await d.lifetime.track(() => announce(i.installId));
      } catch (err) {
        failed({ installId: i.installId }, 'live', logCode(err));
      }
    },
  };
}
