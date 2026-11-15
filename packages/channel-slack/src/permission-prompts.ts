import { PluginError, type HookBus } from '@ax/core';
import type { Answer, SubjectAnswer } from './answers.js';
import { COPY } from './copy.js';
import type { PermissionIn } from './turn-registry.js';

/**
 * The two `chat:permission-request` cards, asked about in Slack (TASK-1095):
 * a host the sandbox was refused, and a catalog skill the agent asked to use.
 *
 * A HOST. The egress proxy lets a session reach only the hosts on its
 * allowlist; when the sandbox tries another, chat-orchestrator fires the
 * egress wall's card (`chat:permission-request`, kind `host`) for the turn
 * running then. A DM or an attended channel turn posts a prompt for it after
 * its reply (turn.ts): "Wants to connect to <host>", with Allow and Deny. An
 * outsider's turn never gets one.
 *
 * The host is whatever the sandbox tried to reach, so the model can choose
 * it: untrusted. It reaches a prompt only once it passes the proxy's own
 * HOST_RE (`hostSubject`), so it is a plain lowercase DNS name (nothing in it
 * can mention, link, broadcast or format), and it is shown only as the
 * prompt's plain_text subject. The answer checks it again before it acts.
 *
 * Once the click gate (answers.ts) has proved the clicker is the person whose
 * turn it was, the answer runs as them (the gate's ctx: the prompt's user,
 * agent and conversation), for the prompt's own session and host:
 *
 *   - Allow: `proxy:add-host` with exactly `{ sessionId, host }`. The proxy
 *     widens that session's LIVE allowlist, and only for its owner: it throws
 *     `forbidden` unless the ctx's user owns the session, and answers
 *     `{ added: false }` once the session has ended. Session only: nothing is
 *     remembered for the agent (`host-grants:grant`, "Always for this agent",
 *     stays a choice in the web app).
 *
 *       added: true                  → hostAllowed
 *       added: false (chat ended)    → hostEnded
 *       forbidden, invalid-host      → promptClosed (logged by code)
 *       an answer it can't read      → promptClosed (logged: bad-response)
 *       anything else                → thrown to the gate: "try again"
 *
 *     Every line settles the prompt. A failure the asker may retry is the
 *     gate's to say; adding a host twice changes nothing. The call is
 *     JOINED (`callJoined`): past the bus's deadline it fails only once the
 *     proxy's own handler has settled, so nothing it started is still
 *     running when the gate lets the prompt go.
 *   - Deny: nothing is called. The host stays refused, and the agent asks
 *     again if it needs it. hostDenied.
 *
 * Known gap: in a connected channel the prompt shows the host to everyone
 * there (the web app shows it to the person alone), and whether Slack links
 * a domain-shaped plain_text is unmeasured (TASK-1097's walk).
 *
 * A SKILL: a catalog skill the agent asked to use (`request_capability`'s
 * card, kind `skill`), asked about in a DM or an attended turn after its
 * reply. In Slack the card comes in a continuation: tool-policy holds
 * `request_capability` itself, and the card fires once that hold is allowed
 * and the woken agent asks again. Its subject is the catalog skill's
 * description (`COPY.skillSubject`): text its author wrote, so outside
 * text, shown only as the prompt's plain_text subject (cleaned there), never
 * in mrkdwn, a notification or a log. The card waits in Today too
 * (channel-web keeps it there), so its prompt links Today. Slack never
 * collects a key: a card that needs one, or a bus without the two hooks
 * Allow needs, gets a link to the web app instead of buttons
 * (`skillPromptFor`), and nothing is opened for it.
 *
 *   - Allow does what the web app's `/api/chat/permission-decision` does
 *     (channel-web routes-chat.ts `postPermissionDecision`), as the
 *     prompt's user, every check before the grant:
 *
 *       1. `agents:resolve`, for the prompt's user and agent: the click gate
 *          already asked it (answers.ts step 7).
 *       2. `conversations:get { conversationId, userId }`, the prompt's: the
 *          conversation is theirs (@ax/conversations refuses anyone else's,
 *          and re-checks the agent), and its frozen agent is the prompt's.
 *       3. `agent:apply-capability-grant { conversationId, userId, agentId,
 *          skillId }`, all four the prompt's, never the click's or the
 *          card's: it attaches the skill for that person on that agent, and
 *          retires the conversation's warm session so their next message
 *          starts with it. It checks nothing itself, so the two checks above
 *          are the only ones. Never the authored-skill grant:
 *          `request_capability` fires cards for catalog skills only.
 *
 *       attached (true, or false: already there)  → skillAllowed
 *       not theirs, another agent's, gone, an
 *       answer it can't read, the skill gone
 *       from the catalog, a hook not on the bus   → skillFailed (logged by code)
 *       anything else                             → thrown to the gate: "try again"
 *
 *     Every line settles the prompt; attaching twice changes nothing. The
 *     grant is called JOINED, as the host's add is; the read is a plain call
 *     (past its deadline it has changed nothing).
 *   - Deny: nothing is called (the web app's "Not now" is its own record).
 *     skillDenied.
 *
 * Logs (`slack_prompt_failed`) name the install, the kind, a stage and a
 * code: never the host, the session, the skill, its description, an id or a
 * token.
 */

/**
 * The hosts the egress proxy lets a session reach: an exact-match, lowercase
 * DNS name of at most 253 characters, in labels of at most 63. No wildcard,
 * port, scheme, path or trailing dot.
 *
 * A copy of credential-proxy's HOST_RE (packages/credential-proxy/src/
 * plugin.ts), the pattern `proxy:add-host` itself enforces, kept here rather
 * than imported (invariant 2: each trust boundary validates for itself). Its
 * other twins are @ax/host-grants' (host-validate.ts) and @ax/tool-policy's
 * (egress-allowlist.ts). permission-prompts.test.ts reads the proxy's from
 * its source and fails when the two differ: change them together.
 */
export const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** What Allow on a host prompt calls (credential-proxy). Optional: without it, no host prompt is offered. */
export const ADD_HOST = 'proxy:add-host';

/**
 * What a host prompt asks (`COPY.hostSubject`), or null when `host` is not
 * one the egress proxy would ever let through (HOST_RE): then it is never
 * shown, and never asked about.
 */
export function hostSubject(host: string): string | null {
  return typeof host === 'string' && HOST_RE.test(host) ? COPY.hostSubject(host) : null;
}

/** The proxy's refusals that close a prompt for good: not the asker's session, or a host it won't take. */
const REFUSALS: ReadonlySet<string> = new Set(['forbidden', 'invalid-host']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createHostAnswer(d: { bus: HookBus }): SubjectAnswer {
  return async (ctx, prompt, action, extra) => {
    const subject = prompt.subject;
    const closed = { line: COPY.promptClosed, settle: true };
    // The gate hands this answer host prompts only.
    if (subject.kind !== 'host') return closed;
    if (action === 'deny') return { line: COPY.hostDenied, settle: true };
    // No other button exists (blocks.ts `actionOf`); one this build doesn't know does nothing.
    if (action !== 'allow' || !d.bus.hasService(ADD_HOST)) return closed;

    const failed = (code: string): typeof closed => {
      try {
        ctx.logger.warn('slack_prompt_failed', { installId: extra.install.installId, kind: 'host', stage: 'add-host', code });
      } catch {
        // A log line never changes an answer.
      }
      return closed;
    };
    // Before acting, as before showing: only a host the proxy would take, whatever the prompt holds.
    if (!HOST_RE.test(subject.host)) return failed('invalid-host');

    let out: unknown;
    try {
      out = await d.bus.callJoined<{ sessionId: string; host: string }, unknown>(ADD_HOST, ctx, {
        sessionId: subject.sessionId,
        host: subject.host,
      });
    } catch (err) {
      if (err instanceof PluginError && REFUSALS.has(err.code)) return failed(err.code);
      throw err;
    }
    if (isRecord(out) && out['added'] === true) return { line: COPY.hostAllowed, settle: true };
    if (isRecord(out) && out['added'] === false) return { line: COPY.hostEnded, settle: true };
    // It may have let the host through: closed, not "try again".
    return failed('bad-response');
  };
}

// ── A catalog skill ─────────────────────────────────────────────────────────

/** What Allow on a skill prompt calls (chat-orchestrator). Optional: without it, a skill card links to the web app. */
export const APPLY_GRANT = 'agent:apply-capability-grant';
/** The ownership read Allow makes first (@ax/conversations). Optional, as the grant is: one without the other links too. */
export const CONVERSATION_GET = 'conversations:get';

/** A skill card, as the turn registry hands it on (turn-registry.ts). */
export type SkillCard = Extract<PermissionIn, { kind: 'skill' }>;

/**
 * How a skill card is asked about in Slack, and with what subject
 * (`COPY.skillSubject`, raw: the draw cleans it):
 *
 *   - `buttons`: Allow and Deny. Only a card that needs nothing but a yes,
 *     on a bus with both hooks Allow calls.
 *   - `web`: its subject and a link to the web app, nothing to click. A card
 *     that needs a key (Slack never collects one), or a bus without the
 *     grant or the ownership read that must come before it.
 */
export function skillPromptFor(
  p: SkillCard,
  bus: Pick<HookBus, 'hasService'>,
): { kind: 'buttons'; subjectText: string } | { kind: 'web'; subjectText: string } {
  const subjectText = COPY.skillSubject(p.description);
  if (p.needsKey || !bus.hasService(APPLY_GRANT) || !bus.hasService(CONVERSATION_GET)) {
    return { kind: 'web', subjectText };
  }
  return { kind: 'buttons', subjectText };
}

/** conversations:get's refusals: not the person's (or gone), or its agent out of their reach. The web route's 404. */
const NOT_THEIRS: ReadonlySet<string> = new Set(['not-found', 'forbidden']);
/** The grant's one refusal: the skill left the catalog after it was asked for. Trying again can't help. */
const GRANT_REFUSALS: ReadonlySet<string> = new Set(['skill-not-found']);

export function createSkillAnswer(d: { bus: HookBus; publicOrigin: string }): SubjectAnswer {
  // Today: the web app's workspace root (channel-web `WORKSPACE_ROOT_PATH`), where the card waits too.
  const todayLink = `${d.publicOrigin}/workspace`;

  return async (ctx, prompt, action, extra) => {
    const subject = prompt.subject;
    const closed: Answer = { line: COPY.promptClosed, settle: true };
    // The gate hands this answer skill prompts only.
    if (subject.kind !== 'skill') return closed;
    if (action === 'deny') return { line: COPY.skillDenied, settle: true };
    // No other button exists (blocks.ts `actionOf`); one this build doesn't know does nothing.
    if (action !== 'allow') return closed;

    /** Not connected from here, for a reason trying again can't change: logged by code, then the web app. */
    const failed = (stage: 'ownership' | 'grant', code: string): Answer => {
      try {
        ctx.logger.warn('slack_prompt_failed', { installId: extra.install.installId, kind: 'skill', stage, code });
      } catch {
        // A log line never changes an answer.
      }
      return { line: COPY.skillFailed(todayLink), settle: true };
    };
    if (!d.bus.hasService(CONVERSATION_GET) || !d.bus.hasService(APPLY_GRANT)) return failed('grant', 'unavailable');

    // 2. The web route's ownership check: the prompt's conversation is its
    // user's, and its frozen agent is the prompt's. A read: past the bus's
    // deadline it acted on nothing, so a plain call.
    let read: unknown;
    try {
      read = await d.bus.call<{ conversationId: string; userId: string }, unknown>(CONVERSATION_GET, ctx, {
        conversationId: prompt.conversationId,
        userId: prompt.userId,
      });
    } catch (err) {
      if (err instanceof PluginError && NOT_THEIRS.has(err.code)) return failed('ownership', err.code);
      throw err;
    }
    const conversation = isRecord(read) ? read['conversation'] : undefined;
    if (!isRecord(conversation)) return failed('ownership', 'bad-response');
    if (conversation['agentId'] !== prompt.agentId) return failed('ownership', 'other-agent');

    // 3. The grant, which checks nothing itself: everything in it is the prompt's.
    let out: unknown;
    try {
      out = await d.bus.callJoined<
        { conversationId: string; userId: string; agentId: string; skillId: string },
        unknown
      >(APPLY_GRANT, ctx, {
        conversationId: prompt.conversationId,
        userId: prompt.userId,
        agentId: prompt.agentId,
        skillId: subject.skillId,
      });
    } catch (err) {
      if (err instanceof PluginError && GRANT_REFUSALS.has(err.code)) return failed('grant', err.code);
      throw err;
    }
    // `attached: false` is a skill already attached: connected all the same, as the web app reads it.
    if (isRecord(out) && typeof out['attached'] === 'boolean') return { line: COPY.skillAllowed, settle: true };
    // It may have attached: the web app, not "try again".
    return failed('grant', 'bad-response');
  };
}
