/**
 * The `tool:pre-call` gate.
 *
 * THE FAILURE MODE THIS FILE IS BUILT AROUND: `HookBus.fire` catches a
 * subscriber's throw, logs it, and CONTINUES to the next subscriber. For a
 * subscriber whose entire job is to stop tool calls, a throw is therefore a
 * SILENT ALLOW — the worst possible outcome, and one that leaves no trace on
 * the surface a human looks at. So every path through this module ends in an
 * explicit return value, and the whole body is wrapped in a catch that fails
 * closed. Nothing here is allowed to throw past `decide`.
 *
 * Order of operations, and why:
 *
 *   1. Consume a standing approval FIRST. An approved call is never
 *      re-adjudicated — the human already decided, and re-running policy could
 *      only ever second-guess them. Consuming is atomic and one-shot.
 *   2. Then evaluate policy.
 *   3. Only then raise a hold — REUSING the question already standing for this
 *      call, if there is one, rather than writing a second row (TASK-254).
 *
 * Step 1 before step 2 is also what makes the attended path honest without
 * trusting the model. The authorisation is keyed on the call FINGERPRINT, so
 * the warm agent re-issuing its held call gets through only if the call is
 * byte-identical to the one the human read. Change one character and it holds
 * again.
 */
import {
  hold,
  isRejection,
  reject,
  type AgentContext,
  type HookBus,
  type Rejection,
  type ToolCall,
} from '@ax/core';
import { callFingerprint } from './fingerprint.js';
import { captureFreshness } from './freshness.js';
import type { DecisionStore } from './store.js';
import {
  decisionText,
  denialSentence,
  holdNote,
  GATE_FAILURE_SENTENCE,
} from './templates.js';
import type { Attendance, Decision, DecisionRaisedPayload } from './types.js';

export const PLUGIN_NAME = '@ax/decisions';

/** Mirrors `@ax/tool-policy`'s `EvaluateResult` without importing it (invariant 2). */
export interface PolicyAnswer {
  verdict: 'allow' | 'hold' | 'deny';
  ruleId: string | null;
  capability: string | null;
  /**
   * Whether the matched rule says approving this call cannot be taken back.
   * Optional HERE and only here: the field is required on `@ax/tool-policy`'s
   * side, but this is a structural mirror of a payload that crosses a bus, and
   * an older producer that does not send it must degrade to `false` — claiming
   * irreversibility we were not told about would defer replays nobody asked to
   * defer.
   */
  irreversible?: boolean | undefined;
}

export interface PreCallDeps {
  /**
   * Wraps `bus.call('tool-policy:evaluate', ...)`. May reject — a missing
   * service, a timeout or a schema drift all surface here, and all of them
   * mean "we do not know whether this call is allowed", which fails closed.
   */
  evaluate: (ctx: AgentContext, call: ToolCall) => Promise<PolicyAnswer>;
  store: DecisionStore;
  now: () => Date;
  /** Host-generated. Never derived from anything the model wrote. */
  idGen: () => string;
  ttlMs: number;
  /**
   * Whether anyone is expected to answer. AW-6 makes this a property of the
   * conversation's CHANNEL rather than of the turn, which means a bus round
   * trip — hence the promise. It is one indexed row read (see
   * `attendance.ts`), and it rides inside the 10 s pre-call ceiling alongside
   * the policy call and the row write.
   *
   * Required now: there is no sensible in-process default. AW-4's
   * `ctx.source === 'routine'` guess is gone, because the honest fallback for
   * "we cannot tell" is `unattended`, and a resolver that owns the failure
   * paths is the only thing that can say so consistently.
   */
  attendanceFor: (ctx: AgentContext) => Attendance | Promise<Attendance>;
  /** Fires `decisions:raised`. Optional so the unit tests need no bus. */
  bus?: HookBus | undefined;
}

export type PreCallSubscriber = (
  ctx: AgentContext,
  call: ToolCall,
) => Promise<undefined | Rejection>;

export function createPreCallSubscriber(deps: PreCallDeps): PreCallSubscriber {

  async function decide(ctx: AgentContext, call: ToolCall): Promise<undefined | Rejection> {
    const fingerprint = callFingerprint(call);

    // 1. A standing approval, if there is one. Consumed atomically; a failure
    //    here is NOT fatal — we simply have no approval to honour and fall
    //    through to policy, which holds again. Fails toward asking.
    try {
      const approved = await deps.store.takeApproval(
        ctx.agentId,
        fingerprint,
        deps.now().toISOString(),
      );
      if (approved !== null) {
        ctx.logger.info('decision_authorisation_consumed', {
          plugin: PLUGIN_NAME,
          decisionId: approved.id,
          tool: call.name,
        });
        return undefined;
      }
    } catch (err) {
      ctx.logger.error('decision_take_approval_failed', {
        plugin: PLUGIN_NAME,
        tool: call.name,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // 2. Policy.
    const answer = await deps.evaluate(ctx, call);
    if (answer.verdict === 'allow') return undefined;
    if (answer.verdict !== 'hold') {
      // `deny`, or a verdict we do not recognise. Both mean "this does not
      // run", and the unrecognised case deliberately lands HERE rather than in
      // the hold branch below: a verdict we cannot read must never become a
      // question a human is invited to answer yes to. (The bus's `returns`
      // enum already rejects an unknown verdict before we see it — this is the
      // in-process path, and the belt to that pair of braces.)
      return reject({
        reason: denialSentence({ capability: answer.capability, toolName: call.name }),
        source: PLUGIN_NAME,
      });
    }

    // 3. Hold: record the call, then stop.
    const now = deps.now();
    const decisionId = deps.idGen();
    const text = decisionText({ capability: answer.capability, toolName: call.name });
    const decision: Decision = {
      id: decisionId,
      agentId: ctx.agentId,
      ownerUserId: ctx.userId,
      // Empty when the hold happened outside a persistent conversation (a
      // canary, an admin probe). The row is still valid and still resolvable
      // from the Today queue — only the in-thread card has nowhere to land,
      // which is the honest outcome for a turn that had no thread.
      conversationId: ctx.conversationId ?? '',
      // Always `action` today. `PolicyRule` carries no `kind`, and inferring
      // "grant" from a rule id inside THIS package would duplicate rule
      // identity across a boundary nothing can lint. See templates.ts.
      kind: 'action',
      attendance: await deps.attendanceFor(ctx),
      status: 'pending',
      // The call, verbatim. `input` is model-authored and stays exactly as the
      // model wrote it — that is what makes the replay byte-faithful — and it
      // is never read back into any of the prose fields.
      call,
      callFingerprint: fingerprint,
      ruleId: answer.ruleId,
      // Captured HERE, at hold time, and never re-read at approval time: the
      // policy that governs an approval is the policy that was in force when
      // the human was asked. AW-5 defers an irreversible call's replay by the
      // undo window so the undo is a real grace period.
      irreversible: answer.irreversible === true,
      // AW-7: ask the tool for something we can re-read when a human finally
      // answers. `captureFreshness` is TOTAL and fails OPEN — a tool with no
      // producer, or a producer that throws, yields `null` here, and `null`
      // claims nothing: the row renders no "checked against…" clause, so the
      // surface never asserts a guard it does not have. The alternative —
      // letting a broken producer turn a hold into a deny — would let one tool
      // take the whole approval surface down.
      freshness: await captureFreshness(deps.bus, ctx, call),
      summary: text.summary,
      detail: text.detail,
      // Never synthesised out of model output.
      preview: null,
      primaryLabel: text.primaryLabel,
      secondaryLabel: text.secondaryLabel,
      ghostLabel: text.ghostLabel,
      approvedText: text.approvedText,
      dismissedText: text.dismissedText,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + deps.ttlMs).toISOString(),
      resolvedAt: null,
      staleReason: null,
      consumedAt: null,
      replayDueAt: null,
      replayClaimedAt: null,
      replayedAt: null,
      replayAbandonedAt: null,
      replayError: null,
    };

    // ONE QUESTION PER CALL (TASK-254). If this person already has an OPEN
    // decision for this agent and this call shape, the row built above is
    // discarded and we hold on theirs. The attendance read and the freshness
    // capture that went into building it are then wasted — both are reads, and
    // peeking for the standing row before doing them would be exactly the
    // non-atomic read-then-create this delegates to the store to avoid.
    //
    // The gate used to write a row every time it held, and only the
    // AUTHORISING statuses are covered by the partial unique index — so two
    // PENDING rows for one call were reachable by the most ordinary route
    // there is: the agent tries again. What that costs is worse than the
    // duplicate card it looks like. On the host-replay path the first approval
    // stamps `replayed_at`, which takes the row OUT of that index and frees
    // the slot, so approving the second card claimed cleanly and SENT THE CALL
    // A SECOND TIME — two rows both reading `executed`, nothing refused,
    // nothing to see afterwards. On the paths where the call has not gone out
    // yet the index did refuse, and since TASK-253 that refusal is reported
    // rather than swallowed — but a person being asked the same question twice
    // and told "no" to the second is still the bug, just an audible one.
    //
    // Collapsing here rather than teaching the approval path to cope is what
    // makes both of those unreachable from a duplicate hold: there is one
    // card, one answer, and one execution. The store makes it atomic; the
    // read-then-create this looks like would be a TOCTOU, and two identical
    // `tool:pre-call` events genuinely race.
    const { decision: raised, created } = await deps.store.createOrReuseOpen(decision);

    const note = holdNote({ capability: answer.capability, toolName: call.name });

    if (!created) {
      // The row we hold on is the one already on the queue — a DIFFERENT id
      // from the one minted above, and possibly raised in another of this
      // person's threads.
      //
      // WHICH COSTS THE SECOND THREAD ITS NARRATION when the two threads have
      // different attendance. The row carries the attendance of the thread
      // that RAISED it, and `decisions:approve` routes on that: a hold raised
      // by a routine and reused by a live web thread is replayed by the host,
      // so the warm agent watching the second thread is never told its call
      // went through. The call still runs exactly once and the person still
      // sees exactly one card on the Today queue, which is not per-thread —
      // what is lost is the in-thread telling, and it is lost in the direction
      // `attendance.ts` argues for. Pinned in `decisions.canary.test.ts`.
      ctx.logger.info('decision_hold_reused', {
        plugin: PLUGIN_NAME,
        decisionId: raised.id,
        tool: call.name,
      });
      // And deliberately NO `decisions:raised`. That event means "a new
      // question is waiting" and the SSE subscriber turns it into a card;
      // firing it for a question already on the queue draws the same card
      // twice, which is the visible half of the bug being fixed.
      return hold({ decisionId: raised.id, note, source: PLUGIN_NAME });
    }

    // Fire-and-forget: a slow SSE subscriber must not push us past the
    // `tool.pre-call` 10 s ceiling, which the runner turns into a deny.
    if (deps.bus !== undefined) {
      const payload: DecisionRaisedPayload = {
        decisionId: raised.id,
        agentId: raised.agentId,
        conversationId: raised.conversationId,
        // `summary` and not `call.name`: a renderer keying off the tool name
        // breaks the day a connector-backed tool is renamed upstream. And
        // deliberately not `call.input` — raw model output on a trust surface.
        summary: raised.summary,
      };
      void deps.bus.fire('decisions:raised', ctx, payload).catch((err: unknown) => {
        ctx.logger.error('decisions_raised_fire_failed', {
          plugin: PLUGIN_NAME,
          decisionId: raised.id,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }

    return hold({ decisionId: raised.id, note, source: PLUGIN_NAME });
  }

  return async (ctx, call) => {
    try {
      const result = await decide(ctx, call);
      // A subscriber must return `undefined` or a `Rejection`. Anything else
      // would be treated as a MODIFIED PAYLOAD by `HookBus.fire` and replace
      // the tool call — so the one thing worse than allowing by accident is
      // rewriting the call by accident.
      if (result === undefined || isRejection(result)) return result;
      throw new Error('pre-call subscriber produced a non-rejection value');
    } catch (err) {
      ctx.logger.error('decisions_pre_call_failed', {
        plugin: PLUGIN_NAME,
        tool: call?.name,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      // FAIL CLOSED. Letting this throw would hand the call to the next
      // subscriber and, with nothing else voting, straight through to the
      // tool.
      return reject({ reason: GATE_FAILURE_SENTENCE, source: PLUGIN_NAME });
    }
  };
}
