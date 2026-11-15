import { PluginError, type HookBus } from '@ax/core';
import type { SubjectAnswer } from './answers.js';
import { COPY } from './copy.js';

/**
 * A host the sandbox was refused, asked about in Slack (TASK-1095). The
 * egress proxy lets a session reach only the hosts on its allowlist; when the
 * sandbox tries another, chat-orchestrator fires the egress wall's card
 * (`chat:permission-request`, kind `host`) for the turn running then. A DM
 * or an attended channel turn posts a prompt for it after its reply
 * (turn.ts): "Wants to connect to <host>", with Allow and Deny. An outsider's
 * turn never gets one.
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
 * Logs (`slack_prompt_failed`) name the install, the kind, a stage and a
 * code: never the host, the session, an id or a token.
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
