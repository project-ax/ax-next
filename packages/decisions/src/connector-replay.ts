/**
 * An approved connector call, made by the HOST (TASK-1046).
 *
 * A person said yes to a held connector call (`mcp.<toolNamespace>.<tool>`)
 * and no live agent is there to make it. `@ax/mcp-client`'s
 * `connectors:call-tool` makes it: it re-derives the decision owner's access to
 * the connector, spends that connector's own credentials, and sends one guarded
 * `tools/call`. This file is the decisions half, and it does two things the
 * hook does not.
 *
 * 1. THE POLICY RE-CHECK. The hook carries no proof that anyone approved
 *    anything and runs no tool-policy check of its own, so this is the gate
 *    between the yes and the call. Right before the call, under the decision's
 *    ctx, `tool-policy:evaluate` is asked again. `deny` refuses: a Deny saved
 *    after the hold beats the yes given to the hold. A throw or an answer we
 *    cannot read refuses too (fails CLOSED). `hold` and `allow` proceed — `hold`
 *    is the very question the person just answered.
 *
 * 2. THE OUTCOME. The hook answers a closed code, and each code becomes a row
 *    the person can trust:
 *      succeeded  → executed; the receipt is the row's `approvedText`;
 *      failed     → our authored sentence for that one code (never the
 *                   service's text), under "Nothing was completed";
 *      failed/tool-error → the tool RAN and said it did not work (review
 *                   F3): `outcomeUnknown` + `toolError`, written abandoned
 *                   under its closed code, "it may have done part of it";
 *      unknown    → `outcomeUnknown`, which `settleReplay` writes as abandoned:
 *                   "we cannot tell you whether it finished".
 *    `unknown` also covers ANY throw from the hook call — the bus's own
 *    `timeout` and `invalid-return` included — and any answer outside the
 *    contract. The call may have gone out, so "nothing was completed" would be
 *    the lie that makes a person approve it again and post twice.
 *
 * The hook is called at most once and never retried. The row was claimed
 * before this runs (`replay_claimed_at`), so exactly-once rides the existing
 * claim → replay → settle machinery; a crash mid-call is the stranded-flight
 * reclaim's to give up on, never to re-run.
 *
 * Logs carry the decision id, the tool key and a closed code. Never the
 * input, never an error's message, never anything the hook returned.
 *
 * Type-only import of `replay.ts`: that module calls this one, and keeping the
 * edge back type-only means there is no runtime import cycle between the two.
 */
import type { AgentContext, HookBus } from '@ax/core';
import { z } from 'zod';
import {
  CONNECTOR_CALL_TOOL_HOOK,
  ConnectorCallOutcomeSchema,
  type ConnectorCallToolInput,
} from './host-executor.js';
import { PLUGIN_NAME } from './pre-call.js';
import type { ReplayOutcome } from './replay.js';
import {
  CONNECTOR_CALL_DETAIL,
  CONNECTOR_POLICY_DENIED_DETAIL,
  CONNECTOR_POLICY_UNREADABLE_DETAIL,
} from './templates.js';
import type { Decision } from './types.js';

/** The one field of `tool-policy:evaluate`'s answer this reads (invariant 2: no import). */
const PolicyVerdictView = z.object({ verdict: z.enum(['allow', 'hold', 'deny']) }).passthrough();

/** The verdict right now, or null when it cannot be read. Never throws. */
async function currentVerdict(
  bus: HookBus,
  ctx: AgentContext,
  decision: Decision,
): Promise<'allow' | 'hold' | 'deny' | null> {
  try {
    const answer = await bus.call<
      { call: { name: string; input: unknown }; agentId: string },
      unknown
    >('tool-policy:evaluate', ctx, {
      call: { name: decision.call.name, input: decision.call.input },
      agentId: decision.agentId,
    });
    const parsed = PolicyVerdictView.safeParse(answer);
    return parsed.success ? parsed.data.verdict : null;
  } catch {
    // Unreadable, and the reason is not logged: a thrown message is not ours.
    return null;
  }
}

/** Sent, and no reliable answer: it may have happened. */
function outcomeUnknown(
  ctx: AgentContext,
  decision: Decision,
  reason: 'timeout' | 'interrupted' | 'threw' | 'unreadable',
): ReplayOutcome {
  ctx.logger.warn('decision_connector_replay_unknown', {
    plugin: PLUGIN_NAME,
    decisionId: decision.id,
    tool: decision.call.name,
    reason,
  });
  return { executed: false, path: null, error: null, outcomeUnknown: true };
}

/**
 * Make the decision's recorded connector call on the host, once. Never throws:
 * every outcome comes back as a value, because the caller has a claimed row to
 * settle either way.
 */
export async function replayConnectorCall(args: {
  bus: HookBus;
  ctx: AgentContext;
  decision: Decision;
}): Promise<ReplayOutcome> {
  const { bus, ctx, decision } = args;

  const verdict = await currentVerdict(bus, ctx, decision);
  if (verdict === 'deny' || verdict === null) {
    ctx.logger.warn('decision_connector_replay_refused', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
      reason: verdict === 'deny' ? 'policy-deny' : 'policy-unreadable',
    });
    return {
      executed: false,
      path: null,
      error: verdict === 'deny' ? CONNECTOR_POLICY_DENIED_DETAIL : CONNECTOR_POLICY_UNREADABLE_DETAIL,
    };
  }

  let answer: unknown;
  try {
    // The recorded call, verbatim: the same `input` object the person read on
    // the card, never a parsed or re-serialised copy. Under the decision's
    // owner and agent — the hook re-derives access from exactly these two.
    answer = await bus.call<ConnectorCallToolInput, unknown>(CONNECTOR_CALL_TOOL_HOOK, ctx, {
      userId: decision.ownerUserId,
      agentId: decision.agentId,
      toolKey: decision.call.name,
      input: decision.call.input,
    });
  } catch {
    return outcomeUnknown(ctx, decision, 'threw');
  }

  const parsed = ConnectorCallOutcomeSchema.safeParse(answer);
  if (!parsed.success) return outcomeUnknown(ctx, decision, 'unreadable');
  const result = parsed.data;

  if (result.outcome === 'succeeded') {
    ctx.logger.info('decision_replayed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
    });
    return { executed: true, path: 'host-replays', error: null };
  }
  if (result.outcome === 'failed') {
    ctx.logger.error('decision_replay_failed', {
      plugin: PLUGIN_NAME,
      decisionId: decision.id,
      tool: decision.call.name,
      reason: result.reason,
    });
    // Review F3: the tool ran and answered that it did not work, so it may
    // have done part of the work. Never a detail under "Nothing was
    // completed"; the row is written abandoned, under its own closed code.
    if (result.reason === 'tool-error') {
      return { executed: false, path: null, error: null, outcomeUnknown: true, toolError: true };
    }
    return { executed: false, path: null, error: CONNECTOR_CALL_DETAIL[result.reason] };
  }
  return outcomeUnknown(ctx, decision, result.reason);
}
