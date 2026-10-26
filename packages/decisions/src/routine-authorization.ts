import { randomUUID } from 'node:crypto';
import {
  PluginError,
  SafeToolError,
  safeToolMessage,
  type AgentContext,
  type HookBus,
  type SafeToolCode,
  type ToolCall,
} from '@ax/core';
import {
  routineToolKind,
  RoutineToolInputSchemas,
  touchesTaskBrief,
  type RoutineToolName,
} from '@ax/routines-contract';
import { z } from 'zod';
import { callFingerprint } from './fingerprint.js';
import { replayContext } from './replay.js';
import type { DecisionStore } from './store.js';
import {
  AuthorizeRoutineCallInputSchema,
  AuthorizeRoutineCallOutputSchema,
  SettleRoutineCallInputSchema,
  type Decision,
} from './types.js';

/** Invocation binding only. Durable authority is in DecisionStore. Use a fresh context per call. */
export const ROUTINE_EXECUTION_CONTEXT = 'decisions:routine-execution';
export const routineExecutionBindingSchema = z
  .object({
    authorizationId: z.string().min(1),
    requestId: z.string().min(1),
    fingerprint: z.string().min(1),
    outcome: z.literal('succeeded').nullable(),
  })
  .strict();
const consentSchema = z.object({ enabled: z.boolean(), revision: z.string().min(1) });
const grantSchema = consentSchema.extend({ delivered: z.literal(true) });
const policySchema = z.object({ verdict: z.enum(['allow', 'hold', 'deny']) });
export const ROUTINE_GRANT_FAILED = 'Routine permission changed. Approve a new request.';

export function eligibleRoutineConsent(name: string): boolean {
  return name === 'routine_create' || name === 'routine_update';
}
/**
 * TASK-941 — a routine write Always Allow can never lift: delete, fire now, and a create or
 * update that `touchesTaskBrief` marks. The same two facts tool-policy relaxes on, read here
 * only to word the hold note (`holdNote`'s `alwaysAsks`). Never an authority. Never throws:
 * `touchesTaskBrief` catches its own errors and answers true.
 */
export function routineConsentNeverCovers(call: { name: string; input: unknown }): boolean {
  return (
    routineToolKind(call.name) === 'write' &&
    (!eligibleRoutineConsent(call.name) || touchesTaskBrief(call))
  );
}
export function checkedRoutineCall(call: ToolCall): ToolCall {
  if (routineToolKind(call.name) !== 'write') throw new SafeToolError('forbidden', 'input');
  if (!RoutineToolInputSchemas[call.name as RoutineToolName].safeParse(call.input).success) {
    throw new SafeToolError('validation', 'input');
  }
  return call;
}
async function currentPolicy(bus: HookBus, ctx: AgentContext, call: ToolCall) {
  if (!bus.hasService('tool-policy:evaluate')) throw new SafeToolError('unavailable', 'input');
  const parsed = policySchema.safeParse(
    await bus.call('tool-policy:evaluate', ctx, {
      agentId: ctx.agentId,
      call: { name: call.name, input: call.input },
    }),
  );
  if (!parsed.success) throw new SafeToolError('unavailable', 'input');
  if (parsed.data.verdict === 'deny') throw new SafeToolError('forbidden', 'input');
  if (!bus.hasService('agents:can-manage-routines'))
    throw new SafeToolError('unavailable', 'input');
  const access = await bus.call<unknown, { allowed: boolean }>('agents:can-manage-routines', ctx, {
    agentId: ctx.agentId,
  });
  if (access.allowed !== true) throw new SafeToolError('forbidden', 'input');
  return parsed.data;
}
export async function approvalConsentRevision(
  bus: HookBus,
  ctx: AgentContext,
  decision: Decision,
  scope: unknown,
): Promise<string | null> {
  if (scope !== 'once' && scope !== 'agent-routines')
    throw new SafeToolError('validation', 'input');
  if (scope === 'agent-routines' && !eligibleRoutineConsent(decision.call.name))
    throw new SafeToolError('forbidden', 'input');
  if (routineToolKind(decision.call.name) !== 'write') return null;
  checkedRoutineCall(decision.call);
  if (callFingerprint(decision.call) !== decision.callFingerprint)
    throw new SafeToolError('forbidden', 'input');
  // The current policy and management service are both required; consent get checks access too.
  await currentPolicy(bus, ctx, decision.call);
  if (scope === 'once') return null;
  const consent = consentSchema.parse(
    await bus.call('tool-policy:get-routine-consent', ctx, { agentId: decision.agentId }),
  );
  return consent.revision;
}

/** Only stored, released approved intent mints the narrow grant capability. */
export async function deliverRoutineConsents(
  store: DecisionStore,
  bus: HookBus,
  now: Date,
): Promise<void> {
  for (const decision of await store.claimRoutineConsent(now.toISOString(), 25)) {
    if (
      decision.approvalScope !== 'agent-routines' ||
      decision.consentDeliveryState !== 'pending' ||
      !eligibleRoutineConsent(decision.call.name) ||
      decision.consentExpectedRevision === null ||
      decision.routineReleaseAt === null ||
      Date.parse(decision.routineReleaseAt) > now.getTime()
    )
      continue;
    const ctx = replayContext(decision);
    ctx.state.set('decisions:routine-consent-grant', {
      decisionId: decision.id,
      agentId: decision.agentId,
      userId: decision.ownerUserId,
      toolName: decision.call.name,
      expectedRevision: decision.consentExpectedRevision,
    });
    try {
      const output = grantSchema.parse(
        await bus.call('tool-policy:grant-routine-consent', ctx, {
          decisionId: decision.id,
          expectedRevision: decision.consentExpectedRevision,
        }),
      );
      await store.finishRoutineConsent(decision.id, 'delivered', output.enabled);
    } catch (error) {
      if (error instanceof PluginError && error.code === 'consent-revision-conflict') {
        await store.finishRoutineConsent(decision.id, 'failed', false);
      }
      // Outage or lost acknowledgement remains pending. The policy ledger makes retry safe.
    } finally {
      ctx.state.delete('decisions:routine-consent-grant');
    }
  }
}

export function registerRoutineAuthorization(
  bus: HookBus,
  store: DecisionStore,
  now: () => Date,
): void {
  bus.registerService(
    'decisions:authorize-routine-call',
    '@ax/decisions',
    async (ctx, raw) => {
      const input = AuthorizeRoutineCallInputSchema.safeParse(raw);
      if (!input.success) throw new SafeToolError('validation', 'input');
      const call = checkedRoutineCall({ ...input.data.call, input: input.data.call.input });
      const answer = await currentPolicy(bus, ctx, call);
      let consent = false;
      if (eligibleRoutineConsent(call.name) && answer.verdict === 'allow') {
        const result = consentSchema.safeParse(
          await bus.call('tool-policy:get-routine-consent', ctx, { agentId: ctx.agentId }),
        );
        if (!result.success) throw new SafeToolError('unavailable', 'input');
        consent = result.data.enabled;
      }
      const fingerprint = callFingerprint(call);
      const requestId = (call.input as { requestId: string }).requestId;
      const authority = await store.claimRoutineAuthority({
        agentId: ctx.agentId,
        userId: ctx.userId,
        fingerprint,
        requestId,
        authorizationId: randomUUID(),
        nowIso: now().toISOString(),
        expiresAt: new Date(now().getTime() + 48 * 60 * 60 * 1000).toISOString(),
        consent,
      });
      ctx.state.set(ROUTINE_EXECUTION_CONTEXT, { ...authority, fingerprint });
      return { authorizationId: authority.authorizationId, requestId: authority.requestId };
    },
    { returns: AuthorizeRoutineCallOutputSchema },
  );
  bus.registerService(
    'decisions:settle-routine-call',
    '@ax/decisions',
    async (ctx, raw) => {
      const input = SettleRoutineCallInputSchema.safeParse(raw);
      const binding = routineExecutionBindingSchema.safeParse(ctx.state.get(ROUTINE_EXECUTION_CONTEXT));
      if (
        !input.success ||
        !binding.success ||
        binding.data.authorizationId !== input.data.authorizationId
      ) {
        throw new SafeToolError('forbidden', 'input');
      }
      const failure =
        input.data.outcome === 'failed'
          ? new SafeToolError((input.data.failureCode ?? 'unavailable') as SafeToolCode, 'input')
              .toolCode
          : null;
      await store.settleRoutineAuthority({
        ...binding.data,
        agentId: ctx.agentId,
        userId: ctx.userId,
        outcome: input.data.outcome,
        failureCode: failure,
        nowIso: now().toISOString(),
      });
      return { settled: true };
    },
    { returns: z.object({ settled: z.literal(true) }).strict() },
  );
}

export function routineFailureText(decision: Decision): string {
  if (decision.consentDeliveryState === 'failed') return ROUTINE_GRANT_FAILED;
  return safeToolMessage(
    decision.routineFailureCode ?? 'unavailable',
    decision.routineFailureField ?? 'input',
  );
}
