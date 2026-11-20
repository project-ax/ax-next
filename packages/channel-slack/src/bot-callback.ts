import { makeAgentContext, type HookBus, type Logger } from '@ax/core';
import type { BotFinishRefusal, Bots } from './bots.js';
import type { RouteRequest, RouteSpec } from './http-types.js';
import { logCode } from './log-code.js';
import { BOT_OAUTH_CALLBACK_PATH, withoutTrailingSlashes } from './manifest.js';
import type { Mutex } from './mutex.js';
import { OAUTH_CODE_RE, STATE_RE, sha256Hex } from './slack-apps.js';
import type { InstallStore } from './store.js';
import { checkUser } from './user-auth.js';

/**
 * Where Slack sends a team agent's bot's approver after they click Allow, or
 * Cancel, on its install page (TASK-1167; design
 * docs/plans/2026-11-09-channel-slack-design.md §4):
 *
 *   GET /slack/bots/oauth/callback  ?code&state or ?error&state
 *       → 302 to `<publicOrigin>/?slack-bot=<connected|cancelled|failed>[&agentId=<id>]`
 *
 * It is the redirect_uri in every bot's manifest and install link (manifest.ts
 * `botUrls`), apart from Admin › Slack's own callback. It reads only a bot's
 * OAuth state: Admin › Slack's reads as unknown here, as a bot's does there
 * (store.ts, kind-scoped).
 *
 * The person must be signed in, whatever their role. The state was minted for
 * one AX user, the bot's approver, when they asked for the bot or picked the
 * request back up (bots.ts), and only its sha256 is stored, with a 10-minute
 * expiry. The callback refuses a state it doesn't know, and one minted for
 * someone else WITHOUT spending it: whoever learns the link can neither use
 * it nor spoil it, and no browser can finish an install for another person
 * (login CSRF). Otherwise it spends the state in one UPDATE, so it works
 * once. That, and all `finish` does after it (bots.ts), runs under the one
 * app lock, so it never interleaves with a request, a cancel, an agent's
 * deletion or anything Admin › Slack does.
 *
 * A browser lands here from Slack, so it never gets a JSON error. Whatever
 * happens (connected, cancelled, a refusal, a fault) it goes to the app's
 * root with `slack-bot=` and one fixed word. Once the state is known to be
 * the signed-in person's, and only then, the address also names the bot's
 * agent, read from the bot's row, so the web app can take them back to that
 * agent's settings: a browser the state wasn't minted for learns nothing
 * about the bot. Nothing in the request picks the address, so the callback
 * can't be used as an open redirect. It doesn't bypass http-server's CSRF
 * check, which lets any GET through: the state is what proves the visit came
 * from the person's own install link. It reads no body.
 *
 * Log lines are code-only: `slack_bot_install_refused { installId?, reason }`
 * for a visit that didn't finish (at info for a cancel, a stale or garbled
 * link, or a signed-out browser; at warn otherwise), `slack_bot_connected
 * { installId }` for one that did, and `slack_bot_failed { installId?, stage,
 * code }` for a step that failed. Never the code, the state, a token, a
 * person's or an agent's id, a name, or a Slack id other than the install's.
 */

export interface BotCallbackDeps {
  bus: HookBus;
  installs: Pick<InstallStore, 'peekOAuthState' | 'consumeOAuthState' | 'get'>;
  /** The one app lock (plugin.ts), held from the state's peek to the bot's handle. Not re-entrant. */
  lock: Mutex;
  bots: Pick<Bots, 'finish'>;
  /** Where the browser is sent back to: the app's root. */
  publicOrigin: string;
  logger: Logger;
  /** Epoch milliseconds. */
  now: () => number;
}

type Outcome = 'connected' | 'cancelled' | 'failed';

const PLUGIN = '@ax/channel-slack';

/** Refusals logged at info: the approver's own cancel, a stale or garbled link, a signed-out browser. */
const QUIET_REFUSALS: ReadonlySet<string> = new Set([
  'cancelled',
  'invalid-state',
  'invalid-request',
  'unauthenticated',
]);

/** `finish`'s failures whose step already logged its own code: the callback adds no second line. */
const LOGGED_BY_STEP: ReadonlySet<BotFinishRefusal> = new Set(['oauth-access', 'store-grant']);

/**
 * What Slack sent back: a code after Allow, an error after Cancel. Exactly
 * one of them, and a code of the shape Slack's have, or it isn't Slack's.
 */
function slackAnswer(query: Readonly<Record<string, string>>): { code: string } | { error: string } | null {
  const code = query['code'];
  const error = query['error'];
  if (code !== undefined && error === undefined) return OAUTH_CODE_RE.test(code) ? { code } : null;
  if (error !== undefined && code === undefined) return { error };
  return null;
}

export function createBotCallbackRoute(d: BotCallbackDeps): RouteSpec {
  const authCtx = makeAgentContext({
    sessionId: 'channel-slack',
    agentId: PLUGIN,
    userId: 'system',
    logger: d.logger,
  });
  const appOrigin = withoutTrailingSlashes(d.publicOrigin);

  /** A log line never changes an answer. */
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string>): void => {
    try {
      d.logger[level](msg, fields);
    } catch {
      // Nothing left to report it with.
    }
  };
  const refused = (reason: string, installId?: string): void => {
    log(QUIET_REFUSALS.has(reason) ? 'info' : 'warn', 'slack_bot_install_refused', {
      ...(installId !== undefined ? { installId } : {}),
      reason,
    });
  };

  /**
   * Where the browser goes: the app's root and the outcome, and the bot's
   * agent once the state is known to be the signed-in person's. Built from
   * config and the bot's row alone, through URLSearchParams, so no value can
   * add or replace another parameter.
   */
  const back = (outcome: Outcome, agentId: string | null = null): string => {
    const params = new URLSearchParams({ 'slack-bot': outcome });
    if (agentId !== null) params.set('agentId', agentId);
    return `${appOrigin}/?${params.toString()}`;
  };

  async function visit(req: RouteRequest): Promise<string> {
    const gate = await checkUser(d.bus, authCtx, req);
    if (!gate.ok) {
      // A fault (500) was logged code-only by the gate.
      if (gate.status === 401) refused('unauthenticated');
      return back('failed');
    }
    const state = req.query['state'];
    if (state === undefined || !STATE_RE.test(state)) {
      refused('invalid-state');
      return back('failed');
    }
    const slack = slackAnswer(req.query);
    if (slack === null) {
      refused('invalid-request');
      return back('failed');
    }
    const stateHash = sha256Hex(state);
    const actorUserId = gate.userId;
    // No agent in the ctx: these lookups act for nobody's agent.
    const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: actorUserId, logger: d.logger });

    return d.lock.run(async () => {
      let installId: string | undefined;
      let agentId: string | null = null;
      try {
        // Peek first: a browser the state wasn't minted for is refused
        // WITHOUT spending it, and told nothing about the bot.
        const peeked = await d.installs.peekOAuthState(stateHash, 'bot');
        if (peeked === null) {
          refused('invalid-state');
          return back('failed');
        }
        installId = peeked.installId;
        if (peeked.userId !== actorUserId) {
          refused('state-user-mismatch', installId);
          return back('failed');
        }
        const spent = await d.installs.consumeOAuthState(stateHash, 'bot');
        // Spent by another visit since the peek.
        if (spent === null) {
          refused('invalid-state');
          return back('failed');
        }
        // The visit is the state's own person's: from here on the address
        // names the bot's agent, read from its row, never from the request.
        const install = await d.installs.get(spent.installId);
        agentId = install?.agentId ?? null;
        if (spent.expiresAt.getTime() <= d.now()) {
          refused('expired', installId);
          return back('failed', agentId);
        }
        if ('error' in slack) {
          // Only the code picks the outcome; Slack's text goes nowhere.
          const cancelled = slack.error === 'access_denied';
          refused(cancelled ? 'cancelled' : 'slack-error', installId);
          return back(cancelled ? 'cancelled' : 'failed', agentId);
        }
        if (install === null) {
          refused('not-pending', installId);
          return back('failed');
        }
        const done = await d.bots.finish({ actorUserId, ctx, install, code: slack.code });
        if (done.outcome === 'failed') {
          if (!LOGGED_BY_STEP.has(done.reason)) refused(done.reason, installId);
          return back('failed', agentId);
        }
        log('info', 'slack_bot_connected', { installId });
        return back('connected', agentId);
      } catch (err) {
        log('error', 'slack_bot_failed', {
          ...(installId !== undefined ? { installId } : {}),
          stage: 'callback',
          code: logCode(err),
        });
        return back('failed', agentId);
      }
    });
  }

  return {
    method: 'GET',
    path: BOT_OAUTH_CALLBACK_PATH,
    handler: async (req, res) => {
      let location: string;
      try {
        location = await visit(req);
      } catch (err) {
        // Anything the steps above didn't answer still sends the browser home.
        log('error', 'slack_bot_failed', { stage: 'callback', code: logCode(err) });
        location = back('failed');
      }
      res.redirect(location, 302);
    },
  };
}
