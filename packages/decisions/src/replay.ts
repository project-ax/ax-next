/**
 * The host replay: doing the thing a human just approved.
 *
 * A held call that was raised on the UNATTENDED path — a routine tick, a
 * webhook — has no agent left to run it. The turn ended when the hold ended it.
 * So the host runs the recorded call itself, byte for byte, which is the whole
 * reason the approval card can promise that what you approved is what happens.
 *
 * THE CONSTRAINT, STATED OUT LOUD: the host can only replay a call whose tool
 * has a host-side executor. `tool.execute-host` dispatches to a dynamic
 * `tool:execute:<name>` service hook, and a tool whose descriptor says
 * `executesIn: 'sandbox'` has no such hook — and no sandbox to run in, because
 * the turn is over. We do NOT try, and we do NOT fabricate a receipt. The
 * approval stands at the gate and the agent performs it the next time it runs.
 * (`skill_propose` is exactly this case; `request_capability` is the
 * host-executed one.)
 *
 * WHY THE DYNAMIC HOOK NAME IS OK HERE. `bus.call('tool:execute:' + name)` is
 * the documented dynamic-service-hook exception — the same one
 * `packages/ipc-core/src/handlers/tool-execute-host.ts` takes, for the same
 * reason: a manifest cannot list a hook name that depends on data. The name is
 * built from `decision.call.name`, which is MODEL-AUTHORED, so this is a
 * capability question and not a formatting one. It is safe for one narrow
 * reason: `hasService` is an exact-match lookup in a map the HOST populated at
 * boot, so the worst a hostile name can do is miss. It cannot traverse, glob or
 * escalate, and a miss parks the decision instead of running anything.
 */
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import type { DecisionStore } from './store.js';
import { sanitizeFailureDetail } from './templates.js';
import { PLUGIN_NAME } from './pre-call.js';
import type { Decision } from './types.js';

export interface ReplayOutcome {
  /** True only when a host executor actually returned. */
  executed: boolean;
  /** `'host-replays'` when the host ran it; null when nothing ran. */
  path: 'host-replays' | null;
  /** Sanitised failure detail. Audit trail — never a receipt. */
  error: string | null;
  /** Present only when the host cannot replay this tool at all. */
  status?: 'approved-pending-agent';
}

/**
 * The context the replay runs under.
 *
 * Built from the DECISION's `(ownerUserId, agentId, conversationId)` — never
 * from the approving request's context. They are usually the same person, but
 * "usually" is not a security property: hooks downstream of a host tool route
 * by `(userId, agentId)`, and firing with the wrong one lands the work in
 * somebody else's workspace. This repo has been bitten by exactly that on
 * `workspace:apply`.
 *
 * `sessionId` is derived from the decision id, which is host-generated
 * (`dec_<32 hex>`) and never derived from anything the model wrote — so nothing
 * model-authored reaches a log line through it.
 *
 * `workspace` is set EXPLICITLY to the host's own working directory rather than
 * left to `makeAgentContext`'s default, so that the value is a stated choice
 * and not an accident. It differs from the ctx a runner-originated
 * `tool.execute-host` call carries, which gets the session's workspace root
 * from the IPC listener — there is no session here, because the turn ended.
 * `process.cwd()` is the same value host-side plugins already see on their
 * host-initiated paths (see @ax/memory-strata's agent-tier-sync note). A host
 * executor that needs a PER-AGENT workspace must resolve it through the
 * `workspace:*` hooks, which route on `(userId, agentId)` — both of which are
 * correct here.
 */
export function replayContext(decision: Decision): AgentContext {
  return makeAgentContext({
    sessionId: `decision-replay-${decision.id}`,
    agentId: decision.agentId,
    userId: decision.ownerUserId,
    workspace: { rootPath: process.cwd() },
    ...(decision.conversationId !== '' ? { conversationId: decision.conversationId } : {}),
    // The turn that raised this hold is over; whatever runs now runs on the
    // host's own initiative, on a person's say-so. `routine` is the existing
    // vocabulary for "not a live human turn".
    source: 'routine',
  });
}

/**
 * Replay a decision's recorded call on the host.
 *
 * Never throws. Every outcome — ran, could not run, tried and failed — comes
 * back as a value, because the caller has a durable row to update either way
 * and an exception here would leave it saying "approved" with nothing behind
 * it.
 */
export async function replayOnApprove(args: {
  bus: HookBus;
  ctx: AgentContext;
  decision: Decision;
}): Promise<ReplayOutcome> {
  const { bus, ctx, decision } = args;
  const hookName = `tool:execute:${decision.call.name}`;

  if (!bus.hasService(hookName)) {
    ctx.logger.info('decision_replay_parked', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
    });
    return { executed: false, path: null, error: null, status: 'approved-pending-agent' };
  }

  try {
    // The recorded call, verbatim — the same `{id, name, input}` object the
    // human read on the card. Nothing is re-derived, re-serialised or
    // "normalised" on the way in; that is what makes the card WYSIWYG.
    await bus.call<Decision['call'], unknown>(hookName, ctx, decision.call);
    ctx.logger.info('decision_replayed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
    });
    return { executed: true, path: 'host-replays', error: null };
  } catch (err) {
    // H1: an action that did not happen must never leave a trace saying it
    // did. We record the failure and return it; the caller writes the AUTHORED
    // failure line as the receipt and never `approvedText`.
    ctx.logger.error('decision_replay_failed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return {
      executed: false,
      path: null,
      // `HookBus.call` already wraps whatever a host executor throws in a
      // `PluginError`, so in practice this is always the Error branch. The
      // `String(err)` fallback covers anything thrown around the call rather
      // than by it, and is the reason this function is total.
      error: sanitizeFailureDetail(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Run the replay AND persist what happened — two halves that must not come
 * apart.
 *
 * It used to be three: a `decisions:executed` fire carried the receipt to
 * whoever was listening. Nobody ever was, and TASK-279 replaced the event with
 * a read — `receiptFor` derives the same sentence from the row this function
 * writes. So persisting the outcome IS emitting the receipt now, and the class
 * of bug where the write loses its race and the emit goes out anyway has
 * nothing left to happen in.
 *
 * Shared by the two callers that replay a call: `decisions:approve` for a
 * reversible one, and the sweep for an irreversible one whose undo window has
 * closed. Keeping them on one code path is what stops the deferred case from
 * quietly growing a different set of receipts.
 *
 * The decision is already CLAIMED (status `executed`) when this runs. That
 * ordering is deliberate: claim first, then act. Acting first and recording
 * afterwards means a crash in between leaves an action that happened sitting
 * behind a row that says it did not — and a human clicking approve again would
 * do it twice.
 */
export async function settleReplay(args: {
  store: DecisionStore;
  bus: HookBus;
  ctx: AgentContext;
  decision: Decision;
  /** Time seam, so a test never has to race a clock. */
  now?: (() => Date) | undefined;
}): Promise<ReplayOutcome> {
  const { store, bus, ctx, decision } = args;
  const now = args.now ?? (() => new Date());
  const outcome = await replayOnApprove({ bus, ctx, decision });

  if (outcome.executed) {
    // `replayed_at` is what takes the row out of the standing-authorisation
    // set — an identical agent call must not cash in the same yes, and an undo
    // must not put it back on the queue for a second run. It is also, now, the
    // thing that makes the receipt exist: `receiptFor` reads this stamp.
    //
    // This one write is unconditional on status (see `markReplayed`), so a null
    // here means the ROW IS GONE, not that we lost a race. Say so out loud: a
    // call that went out with no row left to record it is worth finding in a
    // log — and it is the one case where the receipt is genuinely lost, because
    // there is nothing left to derive it from.
    warnIfLost(
      ctx,
      decision,
      'markReplayed',
      await store.markReplayed(decision.id, now().toISOString()),
    );
    return outcome;
  }

  if (outcome.status === 'approved-pending-agent') {
    // Two ways to land here, and neither is the ordinary one — the approve path
    // normally picks this status BEFORE it claims, so the row is already parked
    // by the time anything runs:
    //
    //   * a deferred replay whose executor went away between the approval and
    //     the moment the undo window closed;
    //   * an ATTENDED approval for a sandbox-only tool whose delivery failed,
    //     so `decisions:approve` fell back to the replay (TASK-277). Here the
    //     executor never existed at all rather than going away — the attended
    //     branch had no reason to check for one, because it was not expecting
    //     to make the call itself.
    //
    // Either way the approval stands and the agent will perform it.
    //
    // A LOST write here used to be a live bug (TASK-281): the park could lose
    // to a concurrent undo and the `pending-agent` receipt went out anyway, so
    // the feed claimed an approval the person had just taken back. There is no
    // emit left. The row the undo wrote is `pending`, and a `pending` row has
    // no receipt — the actor that moved the row owns what it says.
    warnIfLost(ctx, decision, 'parkForAgent', await store.parkForAgent(decision.id));
    return outcome;
  }

  warnIfLost(
    ctx,
    decision,
    'markFailed',
    await store.markFailed(decision.id, { error: outcome.error }),
  );
  return outcome;
}

/**
 * A conditional write that changed nothing means the row moved underneath us.
 * Nothing here can un-run the call, so there is no recovery to attempt — and
 * since the receipt is READ off the row, whatever moved it owns what the row
 * now says. That is the correct outcome, but it is still worth a line: a call
 * the host actually made, recorded nowhere, is impossible to reconstruct later
 * from silence.
 */
function warnIfLost(
  ctx: AgentContext,
  decision: Decision,
  write: string,
  saved: Decision | null,
): void {
  if (saved !== null) return;
  ctx.logger.warn('decision_replay_write_lost', {
    plugin: PLUGIN_NAME,
    decisionId: decision.id,
    write,
  });
}
