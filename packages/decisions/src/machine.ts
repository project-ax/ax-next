/**
 * Decision state machine.
 *
 * Ported verbatim from `packages/channel-web/mock/decision-machine.ts` (PR
 * #425), which was real logic behind a prototype rather than layout. Two edits
 * and only two, both named in the plan: `ActivityEvent` loses `day`/`time` and
 * gains an ISO `at`, and `ApproveResult.path` stays but nothing reads it until
 * AW-5. The logic is unchanged and its tests came across with it. (`path` is
 * still read by nothing outside this file's tests: AW-5's server decides the
 * path itself, and since TASK-277 it decides it from a LIVE session read that
 * a pure function has no way to make. See rule 4.)
 *
 * Pure and time-injected: every entry point takes `now` explicitly so the same
 * functions drive the service hooks, the client's optimistic transition, and
 * the test suite without any of them reaching for the clock.
 *
 * The four rules it exists to enforce:
 *
 *   1. FRESHNESS. A decision held at 7am and approved at 1pm may be approving
 *      a world that no longer exists. The guard re-checks the predicate that
 *      was captured at hold-time; if it moved, the decision RE-OPENS carrying
 *      what changed instead of executing. Silent staleness is the failure that
 *      would end trust in this surface, so "annoying but honest" wins.
 *
 *   2. IDEMPOTENCY. Approving twice sends once. A double click, a retried
 *      POST, or two open tabs must not put two emails in someone's inbox.
 *
 *   3. AUTHORED OUTCOMES. The approved and dismissed lines are both stored on
 *      the decision. Neither is derived from the other. (The design this came
 *      from built the dismissed line by regexing the approved one and got
 *      "You took over from Inbox — sent your reply to Priya" for a reply that
 *      was never sent.)
 *
 *   4. ATTENDANCE PICKS THE PATH — AS A GUESS. An attended decision was raised
 *      on a channel where an agent may still be warm, in which case the agent
 *      executes the call itself. An unattended one was raised after the turn
 *      ended, so the host replays the recorded call — verbatim, which is what
 *      lets the approval card promise WYSIWYG.
 *
 *      The `path` this file returns is OPTIMISTIC and nothing consumes it as a
 *      verdict. `decisions:approve` re-decides with a live session read at
 *      approve time (TASK-277), because a stored `attended` outlives the agent
 *      it refers to and routing on it alone stranded approvals that nobody
 *      would ever run. This function is pure — it can only compare what it is
 *      handed — so the guess stays here and the server owns the answer.
 */
import {
  AUTHORISING_STATUSES,
  type ActivityEvent,
  type Decision,
  type ExecutionPath,
  type ToolCall,
} from './types.js';

export type { ExecutionPath };

/** How long an approve/dismiss can be taken back. */
export const UNDO_WINDOW_MS = 10_000;

export interface ApproveWorld {
  now: string;
  /**
   * Current value of each freshness predicate kind, as the tool reports it
   * right now. The guard compares against what was captured at hold-time.
   */
  freshness: Record<string, string>;
  /** Optional human sentence per kind explaining what moved. */
  changed?: Record<string, string>;
}

export interface ApproveResult {
  decision: Decision;
  executed: boolean;
  /** null unless the decision actually executed. */
  path: ExecutionPath | null;
  /** The verbatim recorded call, handed to the host replay. Null if not executed. */
  replayCall: ToolCall | null;
  event: ActivityEvent | null;
}

export interface ResolveResult {
  decision: Decision;
  event: ActivityEvent | null;
}

export interface UndoResult {
  decision: Decision;
  undone: boolean;
}

/** Only these two statuses are still actionable by a human. */
function isOpen(d: Decision): boolean {
  return d.status === 'pending' || d.status === 'stale';
}

function expired(d: Decision, now: string): boolean {
  return Date.parse(now) >= Date.parse(d.expiresAt);
}

function event(
  d: Decision,
  kind: ActivityEvent['kind'],
  text: string,
  tag: string | null,
): ActivityEvent {
  return {
    id: `ev-${d.id}-${kind}`,
    agentId: d.agentId,
    // The prototype hardcoded `day: 'Today'` and `time: 'just now'`. Those are
    // display concerns: only the reader's browser knows what "today" means to
    // them. AW-10's renderer buckets by date from this instant.
    at: d.resolvedAt ?? d.createdAt,
    text,
    kind,
    tag,
    decisionId: d.id,
  };
}

export function approveDecision(d: Decision, world: ApproveWorld): ApproveResult {
  const inert: ApproveResult = {
    decision: d,
    executed: false,
    path: null,
    replayCall: null,
    event: null,
  };

  // Rule 2 — anything already resolved absorbs the click silently.
  if (!isOpen(d)) return inert;

  if (expired(d, world.now)) {
    return {
      ...inert,
      decision: { ...d, status: 'expired', resolvedAt: world.now },
    };
  }

  // Rule 1 — re-check the world before acting on a stale intention.
  if (d.freshness !== null) {
    const observed = world.freshness[d.freshness.kind];
    if (observed !== undefined && observed !== d.freshness.value) {
      return {
        ...inert,
        decision: {
          ...d,
          status: 'stale',
          staleReason:
            world.changed?.[d.freshness.kind] ??
            `The ${d.freshness.kind.replace(/-/g, ' ')} changed since this was drafted.`,
          // Re-capture, so approving again after the human has looked at the
          // new state executes rather than bouncing forever.
          //
          // AND DROP THE LABEL. The "checked against…" clause describes
          // HOLD-TIME. The instant the guard trips it is false, and repeating
          // it under an alert that says the opposite is worse than silence
          // (design §3.4). The renderer must not have to decide this — a stale
          // row simply has no clause to show.
          freshness: { ...d.freshness, value: observed, label: null },
        },
      };
    }
  }

  // Rule 4 — attended means an agent MIGHT still be alive to run its own call.
  // An optimistic guess from the stored channel, and deliberately not the last
  // word: `decisions:approve` re-decides against a live session read and may
  // send this to the host instead (TASK-277). Nothing outside this file's own
  // tests reads the value.
  const path: ExecutionPath =
    d.attendance === 'attended' ? 'agent-executes' : 'host-replays';

  const executed: Decision = {
    ...d,
    status: 'executed',
    staleReason: null,
    resolvedAt: world.now,
  };

  return {
    decision: executed,
    executed: true,
    path,
    replayCall: d.call,
    // Rule 3 — the authored line, linked back to the decision so the Activity
    // receipt can show what actually went out.
    event: event(executed, 'approved', d.approvedText, 'You approved'),
  };
}

export function dismissDecision(
  d: Decision,
  opts: { now: string },
): ResolveResult {
  if (!isOpen(d)) return { decision: d, event: null };

  const dismissed: Decision = {
    ...d,
    status: 'dismissed',
    resolvedAt: opts.now,
  };
  return {
    decision: dismissed,
    event: event(dismissed, 'dismissed', d.dismissedText, 'You took it over'),
  };
}

export function undoDecision(d: Decision, opts: { now: string }): UndoResult {
  // Undoable iff the decision carries a standing authorisation
  // (`AUTHORISING_STATUSES` — 'executed' or, since AW-5, 'approved-pending-agent':
  // a host that physically cannot replay a sandbox-only tool still parks a
  // real "yes" on the decision, waiting for the agent's next run, and a human
  // who said yes by mistake needs the same undo window as any other approval)
  // or a dismissal. Reusing the shared constant here, rather than repeating
  // the status list a third time, is the point of exporting it — `types.ts`
  // names this exact spot as one of the three places that have to agree.
  if (d.status !== 'dismissed' && !AUTHORISING_STATUSES.includes(d.status)) {
    return { decision: d, undone: false };
  }
  if (d.resolvedAt === null) return { decision: d, undone: false };
  if (Date.parse(opts.now) - Date.parse(d.resolvedAt) > UNDO_WINDOW_MS) {
    return { decision: d, undone: false };
  }
  return {
    decision: { ...d, status: 'pending', resolvedAt: null, staleReason: null },
    undone: true,
  };
}
