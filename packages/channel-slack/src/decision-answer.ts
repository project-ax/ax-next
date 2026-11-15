import { makeReqId, PluginError, type HookBus } from '@ax/core';
import type { SubjectAnswer } from './answers.js';
import { COPY } from './copy.js';
import { logCode } from './log-code.js';
import type { ContinuationRequest } from './turn.js';

/**
 * Answering a held call from Slack (TASK-1095): what Allow and Deny on a
 * decision's prompt do, once the click gate (answers.ts) has proved the
 * clicker is the person whose turn it was. The gate hands over a ctx built
 * from the prompt (its user, agent and conversation), and the answer runs as
 * them, for the prompt's own decision:
 *
 *   - Allow: `decisions:approve` for the prompt's user, once (no approval
 *     scope), with `requestShownInFull: false`: Slack shows the decision's
 *     host-authored summary, never the recorded call, so a connector call
 *     parks for the agent instead of going out from the host (TASK-1046
 *     F2). It carries a continuation id minted here. When decisions hands
 *     the approval to the conversation's warm agent under exactly that id
 *     (`path 'agent-executes'`), the thread starts following the agent's
 *     next turn right away (turn.ts `followContinuation`), before the gate
 *     redraws the prompt: the agent wakes when the undo window closes
 *     (`pendingUntil`), and a redraw can take that long. Only that id is
 *     followed: a sink registered under any other would take a running
 *     turn's events away from it (turn-registry.ts keeps one sink per id).
 *   - Deny: `decisions:dismiss` for the prompt's user. decisions checks no
 *     ctx on it, so the gate is all that stands between a click and this
 *     call: the user id is the prompt's, never anything a click says.
 *
 * What the prompt then says comes from what decisions handed back
 * (`decisionOutcome`): a closed table of COPY lines, read field by field,
 * since it is another plugin's answer. Every line settles the prompt: the
 * answer landed, or it can't land here, and Today has the rest. A decision
 * that was already answered (a retry after a failure, an answer from Today,
 * a Deny after the approve went through) reads as what it is: decisions
 * absorbs a second answer and hands back the stored row, so nothing is
 * approved twice.
 *
 * Both hooks are called JOINED (`callJoined`). The bus's deadline stops it
 * waiting, not the hook, which may still land: an approve that lands after
 * the prompt was let go would leave the asker's next click to answer beside
 * it (Allow, then Deny). Joined, a call past the deadline fails only once
 * the hook, and every call it made, has settled, so the answer holds the
 * prompt for as long as the hook runs (the gate tells the asker it's still
 * going at its own step deadline, which comes first). By then what the hook
 * did is on the row, so the answer reads it back (`decisions:get`) and says
 * that. Any other throw goes to the gate as it is ("try again", and the
 * prompt opens): nothing it started is still running by then.
 *
 * Logs (`slack_prompt_failed`) name the install, the kind, a stage and a
 * code: never an id, the subject, a reqId or an error's message.
 */

export interface DecisionAnswerDeps {
  bus: HookBus;
  /** The web app's origin, for the Today link. */
  publicOrigin: string;
  /**
   * Start following the woken agent's turn into the prompt's thread (turn.ts
   * `followContinuation`): at most once per Allow, as soon as decisions has
   * handed the approval to the agent. Never awaited; a throw is logged.
   */
  follow: (c: ContinuationRequest) => void;
}

/** What the prompt says after an answer, and whether the agent's next turn is to be followed. */
export interface DecisionOutcome {
  /** A COPY line. */
  line: string;
  follow: boolean;
}

const APPROVE = 'decisions:approve';
const DISMISS = 'decisions:dismiss';
const GET = 'decisions:get';

/**
 * The statuses a decision can have, as decisions spells them
 * (`DECISION_STATUSES`): a closed copy, not an import. A status not in it
 * reads as one this build doesn't know.
 */
const STATUSES = ['pending', 'executed', 'approved-pending-agent', 'dismissed', 'stale', 'expired', 'failed'] as const;
type DecisionStatus = (typeof STATUSES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusOf(decision: Record<string, unknown>): DecisionStatus | null {
  const status = decision['status'];
  return typeof status === 'string' && (STATUSES as readonly string[]).includes(status)
    ? (status as DecisionStatus)
    : null;
}

/**
 * The line a prompt shows once decisions has answered an Allow or a Deny,
 * from `out` (decisions:approve's or decisions:dismiss's answer), and
 * whether the agent's next turn is to be followed. In this order:
 *
 *   no readable decision                       → promptClosed
 *   an `error` (it didn't do what it looks
 *   like: an identical call already allowed,
 *   a replay that threw)                       → decisionNotRun
 *   executed, handed to the agent with a
 *   stream (`path 'agent-executes'`)           → decisionAllowed, follow
 *   executed, made by the host (`executed`)    → decisionDone
 *   executed, any other way (a replay after
 *   the undo window, an earlier answer)        → decisionAllowed
 *   approved-pending-agent                     → decisionAllowedNextTime
 *   dismissed                                  → decisionDenied
 *   expired                                    → decisionExpired
 *   stale                                      → decisionChanged
 *   failed                                     → decisionFailed
 *   pending, or a status this build doesn't
 *   know                                       → decisionNotRun
 *
 * Every field is read with typeof: it is another plugin's answer. Pure.
 */
export function decisionOutcome(out: unknown, todayLink: string): DecisionOutcome {
  const shows = (line: string): DecisionOutcome => ({ line, follow: false });
  if (!isRecord(out) || !isRecord(out['decision'])) return shows(COPY.promptClosed);
  const error = out['error'];
  if (error !== null && error !== undefined) return shows(COPY.decisionNotRun(todayLink));
  const status = statusOf(out['decision']);
  switch (status) {
    case 'executed':
      if (out['path'] === 'agent-executes' && typeof out['streamReqId'] === 'string') {
        return { line: COPY.decisionAllowed, follow: true };
      }
      if (out['path'] === 'host-replays' && out['executed'] === true) return shows(COPY.decisionDone);
      return shows(COPY.decisionAllowed);
    case 'approved-pending-agent':
      return shows(COPY.decisionAllowedNextTime);
    case 'dismissed':
      return shows(COPY.decisionDenied);
    case 'expired':
      return shows(COPY.decisionExpired);
    case 'stale':
      return shows(COPY.decisionChanged(todayLink));
    case 'failed':
      return shows(COPY.decisionFailed(todayLink));
    case 'pending':
    case null:
      return shows(COPY.decisionNotRun(todayLink));
    default:
      return status satisfies never;
  }
}

/** A hook bus deadline: the bus stopped waiting, which says nothing about what the hook did. */
const isDeadline = (err: unknown): boolean => err instanceof PluginError && err.code === 'timeout';

export function createDecisionAnswer(d: DecisionAnswerDeps): SubjectAnswer {
  // Today: the web app's workspace root (channel-web `WORKSPACE_ROOT_PATH`).
  const todayLink = `${d.publicOrigin}/workspace`;

  return async (ctx, prompt, action, extra) => {
    const subject = prompt.subject;
    // The gate hands this answer decision prompts only.
    if (subject.kind !== 'decision') return { line: COPY.promptClosed, settle: true };
    const decisionId = subject.decisionId;
    const userId = prompt.userId;
    const failed = (stage: string, code: string): void => {
      try {
        ctx.logger.warn('slack_prompt_failed', {
          installId: extra.install.installId,
          kind: 'decision',
          stage,
          code,
        });
      } catch {
        // A log line never changes an answer.
      }
    };

    /**
     * `hook`'s answer, called joined: past the bus's deadline it fails only
     * once the hook has settled, and then what it did is read back from the
     * row. Any other failure is thrown to the gate.
     */
    const resolve = async (hook: string, stage: string, input: Record<string, unknown>): Promise<unknown> => {
      try {
        return await d.bus.callJoined<Record<string, unknown>, unknown>(hook, ctx, input);
      } catch (err) {
        if (!isDeadline(err) || !d.bus.hasService(GET)) throw err;
        failed(stage, logCode(err));
        const stored = await d.bus.call<{ decisionId: string; userId: string }, unknown>(GET, ctx, {
          decisionId,
          userId,
        });
        return { decision: isRecord(stored) ? stored['decision'] : null };
      }
    };

    if (action === 'allow') {
      if (!d.bus.hasService(APPROVE)) return { line: COPY.promptClosed, settle: true };
      const continuationReqId = makeReqId();
      const out = await resolve(APPROVE, 'approve', {
        decisionId,
        userId,
        continuationReqId,
        requestShownInFull: false,
      });
      const outcome = decisionOutcome(out, todayLink);
      if (outcome.follow && isRecord(out)) {
        if (out['streamReqId'] === continuationReqId) {
          startFollowing(d.follow, failed, {
            prompt,
            install: extra.install,
            botToken: extra.botToken,
            reqId: continuationReqId,
            pendingUntil: typeof out['pendingUntil'] === 'string' ? out['pendingUntil'] : null,
          });
        } else {
          // Some other turn's id: following it would take its events away from it.
          failed('follow', 'other-stream');
        }
      }
      return { line: outcome.line, settle: true };
    }

    if (action === 'deny') {
      if (!d.bus.hasService(DISMISS)) return { line: COPY.promptClosed, settle: true };
      const out = await resolve(DISMISS, 'dismiss', { decisionId, userId });
      // A Deny is never followed: no turn of the agent's is this answer's.
      return { line: decisionOutcome(out, todayLink).line, settle: true };
    }

    // No other button exists (blocks.ts `actionOf`); one this build doesn't know does nothing.
    return { line: COPY.promptClosed, settle: true };
  };
}

/**
 * Start following now (registering the turn's sink makes no Slack call),
 * never awaited: a throw, or a promise that rejects, is logged, and the
 * answer stands.
 */
function startFollowing(
  follow: DecisionAnswerDeps['follow'],
  failed: (stage: string, code: string) => void,
  c: ContinuationRequest,
): void {
  try {
    void Promise.resolve(follow(c) as unknown).catch((err: unknown) => failed('follow', logCode(err)));
  } catch (err) {
    failed('follow', logCode(err));
  }
}
