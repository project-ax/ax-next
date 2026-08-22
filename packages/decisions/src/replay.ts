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
import {
  sanitizeFailureDetail,
  FAILED_RECEIPT,
  PENDING_AGENT_RECEIPT,
} from './templates.js';
import { PLUGIN_NAME } from './pre-call.js';
import type { Decision, DecisionExecutedPayload } from './types.js';

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
 * Run the replay AND persist what happened AND emit the receipt — three halves
 * that must not come apart.
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
    // Stamp it BEFORE the receipt. `replayed_at` is what takes the row out of
    // the standing-authorisation set — an identical agent call must not cash in
    // the same yes, and an undo must not put it back on the queue for a second
    // run. Emitting the receipt first would leave a window where both are true.
    //
    // This one write is unconditional on status (see `markReplayed`), so a null
    // here means the ROW IS GONE, not that we lost a race. Say so out loud: a
    // receipt about to be emitted for a decision that no longer exists is worth
    // finding in a log.
    warnIfLost(ctx, decision, 'markReplayed', await store.markReplayed(decision.id, now().toISOString()));
    // The authored line written when the human was asked — and the only one of
    // the four that claims the thing happened.
    await emitExecuted(bus, ctx, decision, 'executed', decision.approvedText);
    return outcome;
  }

  if (outcome.status === 'approved-pending-agent') {
    // Only reachable here when the executor went away between the approval and
    // the deferred replay; the approve path picks this status before it claims.
    // Either way the approval stands and the agent will perform it.
    warnIfLost(ctx, decision, 'parkForAgent', await store.parkForAgent(decision.id));
    await emitExecuted(bus, ctx, decision, 'pending-agent', PENDING_AGENT_RECEIPT);
    return outcome;
  }

  warnIfLost(
    ctx,
    decision,
    'markFailed',
    await store.markFailed(decision.id, { error: outcome.error }),
  );
  await emitExecuted(bus, ctx, decision, 'failed', FAILED_RECEIPT);
  return outcome;
}

/**
 * A conditional write that changed nothing means the row moved underneath us.
 * Nothing here can un-run the call, so there is no recovery to attempt — but a
 * receipt whose row does not match it is exactly the kind of drift that is
 * impossible to reconstruct later from silence.
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

/**
 * Fire `decisions:executed`.
 *
 * `HookBus.fire` resolves rather than throws when a subscriber blows up, so a
 * broken Activity feed cannot take the replay down with it. A subscriber
 * REJECTION is deliberately ignored: this hook reports something that has
 * already happened, and there is nothing left to veto.
 */
export async function emitExecuted(
  bus: HookBus,
  ctx: AgentContext,
  decision: Decision,
  outcome: DecisionExecutedPayload['outcome'],
  receipt: string,
): Promise<void> {
  const payload: DecisionExecutedPayload = {
    decisionId: decision.id,
    agentId: decision.agentId,
    conversationId: decision.conversationId,
    outcome,
    // HOST-AUTHORED, chosen per outcome. Never `call.input`, and never one
    // outcome's line rewritten into another's (design H1).
    receipt,
  };
  try {
    await bus.fire('decisions:executed', ctx, payload);
  } catch (err) {
    ctx.logger.error('decisions_executed_fire_failed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
