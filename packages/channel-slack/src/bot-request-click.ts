import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { admitSender, findSenderUser, isTemporaryLookupFailure, type Admission } from './admission.js';
import { isAxAdmin } from './ax-admin.js';
import type { PostedDm } from './bot-request-dms.js';
import type { BotReply } from './bots.js';
import { COPY } from './copy.js';
import type { BotRequestClickHandler } from './interactions.js';
import { logCode } from './log-code.js';
import type { SecretStore } from './secrets.js';
import type { SlackApi } from './slack-api.js';

/**
 * The Decline gate (TASK-1170): who may decline a bot request from the
 * shared bot's DM about it (bot-request-dms.ts sends it to each AX admin).
 * The interactions route (interactions.ts) hands on only what Slack signed,
 * and only for the shared install: who clicked, the DM, the clicked message,
 * and the request id the button carries. Being sent the DM proves nothing:
 * it may be days old, its reader may have been demoted since, and its
 * buttons name only a request. So the clicker is proved again, from Slack
 * and AX, on every click, in this order:
 *
 *   1. The install's bot token, from the vault. Without it nothing can be
 *      said: logged, and nothing more is asked.
 *   2. The clicker, admitted from users.info (`admitSender`): a full member
 *      of the install's workspace whose email Slack has confirmed. A refusal
 *      gets silence (a non-member learns nothing from the bot); Slack briefly
 *      unavailable gets "try again".
 *   3. That confirmed email maps to an AX account (`findSenderUser`, exactly
 *      as users.info gave it).
 *   4. That account is an AX admin NOW (`isAxAdmin`): one demoted since the
 *      DM was sent declines nothing. Steps 3 and 4 refuse alike, with one
 *      private line ("Only an admin can answer this."), so the clicker can't
 *      tell an account that isn't an admin from no account at all. Both run
 *      before anything touches the request, so a non-admin learns nothing
 *      about it, not even whether it is still open.
 *   5. The same decline Admin › Slack runs (bot-requests.ts), as that admin,
 *      with the DM she clicked in (its channel and ts, from the click Slack
 *      signed). It reads and deletes the request under the app lock, so a
 *      request answered first (approved, declined or cancelled) is a 404:
 *      "This request was already handled." That is what makes each button
 *      act at most once: of two clicks (a double click, or two admins), only
 *      one finds the request. A 200 says nothing privately: the redraw of the
 *      DMs, which names who declined, is the answer, and the DM she clicked
 *      is redrawn first, even when nothing was kept for the request (the
 *      records live in memory: a restart, their TTL or their cap forgets
 *      them). Only a click in an IM (`D…`) names a DM to redraw: the button
 *      is drawn only in our DMs, so a click claiming any other channel still
 *      declines but redraws nothing it names (logged as a warning).
 *      Anything else, or a throw, is "try again".
 *   An auth fault at step 3 or 4 is "try again" too: an outage is not a "no".
 *
 * No step here has a deadline of its own. Unlike a prompt's click
 * (answers.ts), nothing is taken for the click, so a slow step keeps nobody
 * else waiting; and each call already has one (the Slack client's, the
 * bus's). The decline in particular must not be cut short: it may still land
 * after any deadline, and "try again" would then be false.
 *
 * What the bot says here is COPY only, and only to the clicker
 * (`chat.postEphemeral` in their DM, no thread: the DM's message is a
 * top-level one). Logs (`slack_bot_request_click_*`) name the install, the
 * request (our own random id) and a reason, stage or code: never a Slack id,
 * an email, a name, an AX user's id, or an error's message.
 */

export interface BotRequestClickDeps {
  bus: HookBus;
  /** users.info for step 2 and postEphemeral for the private lines; the type grants nothing else. */
  api: Pick<SlackApi, 'usersInfo' | 'postEphemeral'>;
  secrets: Pick<SecretStore, 'get'>;
  /** The one decline Admin › Slack runs (bot-requests.ts), here as the admin who clicked, with the DM she clicked in when it is an IM. */
  requests: { decline(i: { requestId: string; actorUserId: string; clicked?: PostedDm }): Promise<BotReply> };
  logger: Logger;
}

const SESSION = 'channel-slack';

/** A DM's channel id: the only place a bot request's Decline button is drawn. */
const IM_CHANNEL_RE = /^D[A-Z0-9]+$/;

/** A ctx for a lookup about a person: no agent, and the AX user once known. */
const lookupCtx = (userId: string, logger: Logger): AgentContext =>
  makeAgentContext({ sessionId: SESSION, agentId: '', userId, logger });

export function createBotRequestClickHandler(d: BotRequestClickDeps): BotRequestClickHandler {
  return async (install, click) => {
    const installId = install.installId;
    const { requestId } = click;
    const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string> = {}): void => {
      try {
        d.logger[level](msg, { installId, requestId, ...fields });
      } catch {
        // A log line never changes what a click does.
      }
    };
    const failed = (stage: string, code: string, level: 'warn' | 'error' = 'error'): void =>
      log(level, 'slack_bot_request_click_failed', { stage, code });
    const refused = (reason: string, fields: Record<string, string> = {}): void =>
      log('info', 'slack_bot_request_click_refused', { reason, ...fields });

    // 1. The bot token. Nothing can be said without it.
    let botToken: string | null;
    try {
      botToken = await d.secrets.get(install, 'bot-token');
    } catch (err) {
      failed('bot-token', logCode(err));
      return;
    }
    if (botToken === null) {
      failed('bot-token', 'missing');
      return;
    }
    const token = botToken;

    /** A line only the clicker sees, in their DM. A failure is logged, never thrown. */
    const tell = async (text: string): Promise<void> => {
      try {
        await d.api.postEphemeral(token, { channel: click.channel, user: click.slackUserId, text });
      } catch (err) {
        failed('ephemeral', logCode(err), 'warn');
      }
    };

    // 2. The clicker, admitted from users.info. admitSender never rejects.
    const teamId = install.teamId;
    const admission: Admission =
      teamId === null
        ? { ok: false, reason: 'other-workspace' }
        : await admitSender(d.api, token, click.slackUserId, teamId);
    if (!admission.ok) {
      refused('not-admitted', { code: admission.code ?? admission.reason });
      if (isTemporaryLookupFailure(admission)) await tell(COPY.promptFailed);
      return;
    }

    // 3. Their confirmed email, to an AX account.
    let userId: string | null;
    try {
      userId = await findSenderUser(d.bus, lookupCtx('', d.logger), admission.email, { installId, logger: d.logger });
    } catch (err) {
      failed('find-user', logCode(err));
      await tell(COPY.promptFailed);
      return;
    }
    if (userId === null) {
      refused('not-mapped');
      await tell(COPY.botRequestOnlyAdmin);
      return;
    }

    // 4. An AX admin now. Before anything touches the request.
    let admin: boolean;
    try {
      admin = await isAxAdmin(d.bus, lookupCtx(userId, d.logger), userId);
    } catch (err) {
      failed('is-admin', logCode(err));
      await tell(COPY.promptFailed);
      return;
    }
    if (!admin) {
      refused('not-admin');
      await tell(COPY.botRequestOnlyAdmin);
      return;
    }

    // 5. The decline Admin › Slack runs, as her, with the DM she clicked in. Only
    // our DMs carry the button, so a click that says it came from anywhere but
    // an IM (`D…`) names no message to redraw: the shared bot never overwrites a
    // channel message on a click's word. Her decision still stands (steps 2-4
    // proved her without the channel). Read inside the try: a reply we can't
    // read is a fault too.
    const inIm = IM_CHANNEL_RE.test(click.channel);
    let status: number;
    try {
      status = (
        await d.requests.decline({
          requestId,
          actorUserId: userId,
          ...(inIm ? { clicked: { channel: click.channel, ts: click.messageTs } } : {}),
        })
      ).status;
    } catch (err) {
      failed('decline', logCode(err));
      await tell(COPY.promptFailed);
      return;
    }
    if (status === 200) {
      // A click claiming a channel other than an IM went through, without the
      // DM it names being redrawn (any DM kept for the request still is). Real
      // Slack traffic shouldn't send one: worth a look, so a warning.
      if (inIm) log('info', 'slack_bot_request_click_declined');
      else log('warn', 'slack_bot_request_click_declined', { reason: 'clicked-not-im' });
      return;
    }
    if (status === 404) {
      refused('gone');
      await tell(COPY.botRequestHandled);
      return;
    }
    failed('decline', `status-${status}`);
    await tell(COPY.promptFailed);
  };
}
