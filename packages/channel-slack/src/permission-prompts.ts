import { PluginError, type HookBus } from '@ax/core';
import type { Answer, SubjectAnswer } from './answers.js';
import { COPY } from './copy.js';
import { cleanPromptSubject } from './format.js';
import type { PermissionIn, SkillReach } from './turn-registry.js';

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
 * agent and conversation), for the prompt's own session and host. The
 * prompt's subject says before the click that an Allow lasts.
 *
 *   - Allow, in this order (TASK-1208):
 *
 *       1. `proxy:add-host` with exactly `{ sessionId, host }`. The proxy
 *          widens that session's LIVE allowlist, and only for its owner: it
 *          throws `forbidden` unless the ctx's user owns the session, and
 *          answers `{ added: false }` once the session has ended. A host it
 *          lets through reaches the agent's next turn as a "now allowed"
 *          line (TASK-1199).
 *       2. `host-grants:grant` with `{ ownerUserId, agentId, host }`: the
 *          ctx's user and agent (the prompt's, which the gate re-proved),
 *          never the click's and never the agent the proxy answered with.
 *          It keeps the host on that agent's allowed sites, added by that
 *          person (the web app's "Always for this agent"), so the agent's
 *          later sessions reach it too. It runs even when the session has
 *          already ended: a prompt lives a day, and the click is still the
 *          asker's. Nothing is kept unless step 1 answered.
 *
 *       add-host refuses (forbidden, invalid-host)  → promptClosed (logged by code)
 *       add-host's answer can't be read             → promptClosed (logged: bad-response)
 *       added (true or false), then kept            → hostAllowed
 *       added, but not kept: no host-grants:grant,
 *       or it refuses (invalid-host, missing-field),
 *       or its answer fails its shape (invalid-return),
 *       or can't be read (bad-response), all logged
 *       by code                                     → hostAllowedForNow, or hostEnded once ended
 *       or the agent's list is full (grant-limit,
 *       logged by code)                             → hostAllowedListFull, or hostEndedListFull once ended
 *       anything else, at either step               → thrown to the gate: "try again"
 *
 *     Every line settles the prompt, and none says "from now on" unless the
 *     host was kept. A failure the asker may retry is the gate's to say, and
 *     both steps are safe to repeat: the proxy records a host once (so the
 *     agent is told once), and the grant answers `created: false` for a host
 *     already kept. Both calls are JOINED (`callJoined`): past the bus's
 *     deadline one fails only once its handler has settled, so nothing it
 *     started is still running when the gate lets the prompt go.
 *   - Deny: nothing is called. The host stays refused, and the agent asks
 *     again if it needs it. hostDenied.
 *
 * Known gaps: in a connected channel the prompt shows the host to everyone
 * there (the web app shows it to the person alone), and whether Slack links
 * a domain-shaped plain_text is unmeasured (TASK-1097's walk).
 *
 * The site is the agent's (TASK-1212), not the clicker's. On a team agent an
 * Allow covers every member's later sessions, and an outsider's turn, which
 * runs as its requester, reaches it too. This widens a capability on
 * purpose: it is why the prompt says "Once allowed, it stays allowed". Its
 * owners and team admins see it, and remove it, in the agent's settings. On
 * a personal agent only its owners add one, and on a shared personal agent
 * anyone who can use it does, as on a team agent (TASK-1248).
 *
 * A SKILL: a catalog skill the agent asked to use (`request_capability`'s
 * card, kind `skill`), asked about in a DM or an attended turn after its
 * reply. The card comes in the turn itself: tool-policy holds
 * `request_capability` only when nobody is there to answer its card
 * (TASK-1135). Its subject names the skill's id, what it reaches (the card's
 * hosts, and one sentence when it downloads packages, never which), then the
 * catalog skill's description (`COPY.skillSubject`). The description is text
 * its author wrote; the hosts come from the skill's admin-approved
 * connectors, but they are outside text all the same. All of it is shown
 * only as the prompt's plain_text subject (cleaned there), never in mrkdwn,
 * a notification or a log. The card waits in Today too
 * (channel-web keeps it there), so its prompt links Today. Allow is offered
 * only on a reach the subject names whole: every host one the egress proxy
 * would take (HOST_RE), and the id and reach unchanged by the subject's
 * cleaning and cap. Anything else (a card without the broker's `hosts` and
 * `packages`, a host the proxy would refuse, more than the subject can hold)
 * gets a link to the web app, whose subject leaves the reach out rather than
 * show part of it. Slack never collects a key: a card that needs one, or a
 * bus without the two hooks Allow needs, gets that link too, instead of
 * buttons (`skillPromptFor`), and nothing is opened for it.
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

/** What Allow on a host prompt calls first (credential-proxy). Optional: without it, no host prompt is offered. */
export const ADD_HOST = 'proxy:add-host';
/**
 * What Allow calls next, to keep the host on the agent's allowed sites for
 * the asker (@ax/host-grants, TASK-1208). Optional: without it, an Allow lets
 * the host through for the live session only, and its line says so.
 */
export const REMEMBER_HOST = 'host-grants:grant';

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
/**
 * The allowed sites' refusals, which trying again can't change: the list is full, or a host or key it won't take.
 * `invalid-return` is the bus saying the answer failed its shape AFTER the handler ran (core hook-bus.ts), so the
 * site may have been kept: never "try again", and never "from now on".
 */
const REMEMBER_REFUSALS: ReadonlySet<string> = new Set(['grant-limit', 'invalid-host', 'missing-field', 'invalid-return']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createHostAnswer(d: { bus: HookBus }): SubjectAnswer {
  return async (ctx, prompt, action, extra) => {
    const subject = prompt.subject;
    const closed: Answer = { line: COPY.promptClosed, settle: true };
    // The gate hands this answer host prompts only.
    if (subject.kind !== 'host') return closed;
    if (action === 'deny') return { line: COPY.hostDenied, settle: true };
    // No other button exists (blocks.ts `actionOf`); one this build doesn't know does nothing.
    if (action !== 'allow' || !d.bus.hasService(ADD_HOST)) return closed;

    /** Logged by stage and code (never the host, the session or an id), then `answer`. */
    const failed = (stage: 'add-host' | 'remember', code: string, answer: Answer = closed): Answer => {
      try {
        ctx.logger.warn('slack_prompt_failed', { installId: extra.install.installId, kind: 'host', stage, code });
      } catch {
        // A log line never changes an answer.
      }
      return answer;
    };
    // Before acting, as before showing: only a host the proxy would take, whatever the prompt holds.
    if (!HOST_RE.test(subject.host)) return failed('add-host', 'invalid-host');

    // 1. The live session, as its owner. Its refusals keep nothing.
    let out: unknown;
    try {
      out = await d.bus.callJoined<{ sessionId: string; host: string }, unknown>(ADD_HOST, ctx, {
        sessionId: subject.sessionId,
        host: subject.host,
      });
    } catch (err) {
      if (err instanceof PluginError && REFUSALS.has(err.code)) return failed('add-host', err.code);
      throw err;
    }
    const added = isRecord(out) ? out['added'] : undefined;
    // It may have let the host through: closed, not "try again". Nothing is kept.
    if (typeof added !== 'boolean') return failed('add-host', 'bad-response');

    // 2. Kept on the agent's allowed sites, added by the asker: the gate's ctx, never the click or the proxy's agentId.
    const notKept: Answer = { line: added ? COPY.hostAllowedForNow : COPY.hostEnded, settle: true };
    if (!d.bus.hasService(REMEMBER_HOST)) return notKept;
    let kept: unknown;
    try {
      kept = await d.bus.callJoined<{ ownerUserId: string; agentId: string; host: string }, unknown>(REMEMBER_HOST, ctx, {
        ownerUserId: ctx.userId,
        agentId: ctx.agentId,
        host: subject.host,
      });
    } catch (err) {
      if (err instanceof PluginError && REMEMBER_REFUSALS.has(err.code)) {
        // A full list says so: "for now" alone would invite a retry that can't stick.
        const full: Answer = { line: added ? COPY.hostAllowedListFull : COPY.hostEndedListFull, settle: true };
        return failed('remember', err.code, err.code === 'grant-limit' ? full : notKept);
      }
      throw err;
    }
    // `created: false` is a host already kept: kept all the same.
    if (isRecord(kept) && typeof kept['created'] === 'boolean') return { line: COPY.hostAllowed, settle: true };
    // It may have kept it: not "try again", but never "from now on" either.
    return failed('remember', 'bad-response', notKept);
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
 * The card's reach when a prompt can name it whole, else null:
 *
 *   - null when the card didn't carry it in the broker's shape;
 *   - the reach itself when there is nothing in it to name;
 *   - null when any host is one the egress proxy would refuse (HOST_RE);
 *   - null unless the subject up to its description (the id and the reach)
 *     reads exactly the same once cleaned (`cleanPromptSubject`): nothing in
 *     it cut by the cap, marked or changed.
 *
 * The description comes after the reach (`COPY.skillSubject`), the head
 * ends in a full stop, and nothing after a full stop changes how the text
 * before it is cleaned (format.ts `cleanLine`: no rule that marks or merges
 * reads past one). So a subject whose head passes keeps every host,
 * unchanged, wherever it is drawn: the prompt (after prompt-post.ts cuts it
 * to the same cap), its answered redraw, and the web link.
 */
function nameableReach(p: SkillCard): SkillReach | null {
  const reach = p.reach;
  if (reach === null) return null;
  if (reach.hosts.length === 0 && !reach.downloads) return reach;
  if (!reach.hosts.every((host) => HOST_RE.test(host))) return null;
  const head = COPY.skillSubject(p.skillId, '', reach);
  return cleanPromptSubject(head) === head ? reach : null;
}

/**
 * How a skill card is asked about in Slack, and with what subject
 * (`COPY.skillSubject`: its id, what it reaches and its description, raw:
 * the draw cleans it):
 *
 *   - `buttons`: Allow and Deny. Only a card that needs nothing but a yes,
 *     whose reach the subject names whole (`nameableReach`), on a bus with
 *     both hooks Allow calls.
 *   - `web`: its subject and a link to the web app, nothing to click. A card
 *     that needs a key (Slack never collects one), a reach the subject can't
 *     name whole (the subject then leaves the reach out: a host is never
 *     shown cut or altered; the web app shows it whole), or a bus without
 *     the grant or the ownership read that must come before it.
 */
export function skillPromptFor(
  p: SkillCard,
  bus: Pick<HookBus, 'hasService'>,
): { kind: 'buttons'; subjectText: string } | { kind: 'web'; subjectText: string } {
  const reach = nameableReach(p);
  const subjectText = COPY.skillSubject(p.skillId, p.description, reach ?? undefined);
  if (reach === null || p.needsKey || !bus.hasService(APPLY_GRANT) || !bus.hasService(CONVERSATION_GET)) {
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
