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
 *   3. Only then write a row and hold.
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
   * How long the human has. Injected so AW-6 can make it a property of the
   * channel rather than a constant.
   */
  attendanceFor?: (ctx: AgentContext) => Attendance;
  /** Fires `decisions:raised`. Optional so the unit tests need no bus. */
  bus?: HookBus | undefined;
}

/**
 * Attendance, v1. `web | routine` is the only axis that exists — there is no
 * Slack channel package (design §3.3's correction) — so a routine-minted
 * context is unattended and everything else is attended.
 *
 * This is deliberately NOT a synonym for "was this a routine" in the long run:
 * AW-6 replaces it with the conversation's own channel + park budget. The
 * value names the *property*, `attended`/`unattended`, so that swap adds a
 * channel rather than a new attendance value.
 */
export function defaultAttendanceFor(ctx: AgentContext): Attendance {
  return ctx.source === 'routine' ? 'unattended' : 'attended';
}

export type PreCallSubscriber = (
  ctx: AgentContext,
  call: ToolCall,
) => Promise<undefined | Rejection>;

export function createPreCallSubscriber(deps: PreCallDeps): PreCallSubscriber {
  const attendanceFor = deps.attendanceFor ?? defaultAttendanceFor;

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
      attendance: attendanceFor(ctx),
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
      // AW-7 adds the producers. Until one exists, claiming to have checked
      // anything would be a promise the storage does not keep.
      freshness: null,
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
      replayError: null,
    };

    await deps.store.create(decision);

    // Fire-and-forget: a slow SSE subscriber must not push us past the
    // `tool.pre-call` 10 s ceiling, which the runner turns into a deny.
    if (deps.bus !== undefined) {
      const payload: DecisionRaisedPayload = {
        decisionId: decision.id,
        agentId: decision.agentId,
        conversationId: decision.conversationId,
        // `summary` and not `call.name`: a renderer keying off the tool name
        // breaks the day a connector-backed tool is renamed upstream. And
        // deliberately not `call.input` — raw model output on a trust surface.
        summary: decision.summary,
      };
      void deps.bus.fire('decisions:raised', ctx, payload).catch((err: unknown) => {
        ctx.logger.error('decisions_raised_fire_failed', {
          plugin: PLUGIN_NAME,
          decisionId: decision.id,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
    }

    return hold({
      decisionId: decision.id,
      note: holdNote({
        decisionId: decision.id,
        capability: answer.capability,
        toolName: call.name,
      }),
      source: PLUGIN_NAME,
    });
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
