import {
  makeAgentContext, reject, SafeToolError, safeToolMessage,
  type AgentContext, type HookBus, type ToolCall, type ToolDescriptor,
} from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore, OperationKey } from './store.js';
import {
  createRequestHash, updateRequestHash, deleteRequestHash, dispatchRequestHash,
  editableDefinition, parseStoredRoutine,
} from './definition.js';
import { AcceptedDispatchSchema } from './dispatch.js';
import { parseRoutineInput, routinePermissions, routineView } from './services.js';

const PLUGIN = '@ax/routines';
const names = Object.keys(C.RoutineToolInputSchemas) as C.RoutineToolName[];
export const ROUTINE_TOOL_HOOKS = names.map(name => `tool:execute:${name}`);
const activities: Record<C.RoutineToolName, string> = {
  routine_list: 'Reading routines', routine_get: 'Reading a routine', routine_create: 'Creating a routine',
  routine_update: 'Updating a routine', routine_delete: 'Deleting a routine', routine_fire_now: 'Starting a routine',
};
export const ROUTINE_TOOL_DESCRIPTORS: ToolDescriptor[] = names.map(name => ({
  name, description: C.RoutineToolDescriptions[name], inputSchema: C.RoutineToolJsonSchemas[name],
  executesIn: 'host', activityPhrase: activities[name],
}));
type Dependencies = { bus: HookBus; store: RoutinesStore };
type Invocation = Dependencies & { ctx: AgentContext; call: ToolCall };
type Prepared = { hook: string; input: unknown; receiptKey?: OperationKey };
function safeFailure(error: unknown): SafeToolError {
  return error instanceof SafeToolError ? new SafeToolError(error.toolCode, error.field) : new SafeToolError('unavailable', 'input');
}
function requireAllowed(allowed: boolean): void { if (!allowed) throw new SafeToolError('forbidden', 'input'); }

/** Read-only validation. Ownership reconciliation belongs to management get/list, never preflight. */
async function prepare({ bus, store, ctx, call }: Invocation): Promise<Prepared> {
  if (C.routineToolKind(call?.name) === null) throw new SafeToolError('validation', 'input');
  const name = call.name as C.RoutineToolName;
  // Validate before touching policy/decisions or loading any private state.
  parseRoutineInput(C.RoutineToolInputSchemas[name], call.input);
  const { agent } = await bus.call<unknown, { agent: { ownerType: 'user' | 'team'; ownerId: string } }>(
    'agents:resolve', ctx, { agentId: ctx.agentId, userId: ctx.userId });
  const { allowed } = await bus.call<unknown, { allowed: boolean }>('agents:can-manage-routines', ctx, { agentId: ctx.agentId });
  if (name === 'routine_list') return { hook: 'routines:list', input: { agentId: ctx.agentId } };
  if (name === 'routine_get') return { hook: 'routines:get', input: { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineGetToolInputSchema, call.input) } };
  requireAllowed(allowed === true);
  let prepared: Prepared & { receiptKey: OperationKey };
  const scope = { agentId: ctx.agentId, actorUserId: ctx.userId };
  if (name === 'routine_create') {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineCreateToolInputSchema, call.input) };
    prepared = { hook: 'routines:create', input, receiptKey: { ...scope, requestId: input.requestId, operation: 'create', inputHash: createRequestHash(input) } };
  } else if (name === 'routine_update') {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineUpdateToolInputSchema, call.input) };
    prepared = { hook: 'routines:update', input, receiptKey: { ...scope, requestId: input.requestId, operation: 'update', inputHash: updateRequestHash(input) } };
  } else {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineDeleteToolInputSchema, call.input) };
    const fire = name === 'routine_fire_now';
    prepared = { hook: fire ? 'routines:fire-now' : 'routines:delete', input,
      receiptKey: { ...scope, requestId: input.requestId, operation: fire ? 'dispatch' : 'delete', inputHash: fire ? dispatchRequestHash({ ...input, source: 'manual' }) : deleteRequestHash(input) } };
  }
  // Completed exact operations may have removed the row or advanced its revision.
  // Access above remains live even on this path; receipts are never returned raw.
  const receipt = await store.findOperationReceipt(prepared.receiptKey);
  if (receipt !== null) {
    if (name === 'routine_create' || name === 'routine_update') {
      const row = parseStoredRoutine(receipt);
      const stopOnly = name === 'routine_update' && Object.keys((prepared.input as C.RoutineUpdateInput).patch).length === 1 && (prepared.input as C.RoutineUpdateInput).patch.enabled === false;
      requireAllowed(row.ownerUserId === ctx.userId || stopOnly);
    } else if (name === 'routine_fire_now') requireAllowed(AcceptedDispatchSchema.parse(receipt).row.ownerUserId === ctx.userId);
    return prepared;
  }
  let next: C.RoutineDefinition | undefined;
  let routineId: string | undefined;
  if (name === 'routine_create') next = (prepared.input as C.RoutineCreateInput).definition;
  else {
    const input = prepared.input as C.RoutineDeleteInput;
    routineId = input.routineId;
    const row = await store.findOne(input);
    if (!row) throw new SafeToolError('not-found', 'routineId');
    // Personal ownership changes mint a new revision on routine_get. Do not
    // mutate here or approve a proposal against the old owner/revision.
    if (row.revision !== input.expectedRevision || (agent.ownerType === 'user' && row.ownerUserId !== agent.ownerId))
      throw new SafeToolError('revision-conflict', 'expectedRevision');
    const permissions = routinePermissions(row, ctx.userId, allowed);
    if (name === 'routine_fire_now') {
      requireAllowed(permissions.fire);
      if (!row.enabled) throw new SafeToolError('disabled', 'enabled');
    } else if (name === 'routine_delete') requireAllowed(permissions.stop);
    else {
      const patch = (prepared.input as C.RoutineUpdateInput).patch;
      requireAllowed(permissions.edit || (permissions.stop && Object.keys(patch).length === 1 && patch.enabled === false));
      try { next = C.applyRoutinePatch(editableDefinition(row), patch); }
      catch { throw new SafeToolError('validation', 'input'); }
    }
  }
  if (next?.trigger.kind === 'webhook') {
    const duplicate = await store.findWebhook({ agentId: ctx.agentId, path: next.trigger.path });
    if (duplicate && duplicate.routineId !== routineId) throw new SafeToolError('webhook-path-conflict', 'trigger.path');
  }
  return prepared;
}
export async function preflightRoutineCall(input: Invocation): Promise<void> { await prepare(input); }

const executionBindingSchema = z.object({
  authorizationId: z.string().min(1), requestId: z.string().min(1), fingerprint: z.string().min(1),
  outcome: z.literal('succeeded').nullable(),
}).strict();
type Recovery = { kind: 'committed'; output: unknown } | { kind: 'failed' } | { kind: 'pending' } | { kind: 'absent' };
async function recover(store: RoutinesStore, ctx: AgentContext, key: OperationKey, succeeded: boolean): Promise<Recovery> {
  const receipt = await store.findOperationReceipt(key);
  if (receipt === null) return { kind: 'absent' };
  if (key.operation === 'create' || key.operation === 'update') return { kind: 'committed', output: routineView(parseStoredRoutine(receipt), ctx.userId, true) };
  if (key.operation === 'delete') return { kind: 'committed', output: C.RoutineDeleteOutputSchema.parse(receipt) };
  if (succeeded) return { kind: 'committed', output: { status: 'ok' } };
  const accepted = AcceptedDispatchSchema.parse(receipt);
  const outcome = await store.getDispatchOutcome({ agentId: ctx.agentId, dispatchId: accepted.dispatchId });
  if (!outcome) return { kind: 'pending' };
  return outcome.status === 'error' ? { kind: 'failed' } : { kind: 'committed', output: { status: 'ok' } };
}

export async function registerRoutineTools({ bus, store }: Dependencies & { now: () => Date }): Promise<void> {
  bus.subscribe<ToolCall>('tool:pre-call', PLUGIN, async (ctx, call) => {
    if (C.routineToolKind(call.name) === null) return;
    try { await preflightRoutineCall({ bus, store, ctx, call }); }
    catch (error) {
      const safe = safeFailure(error);
      return reject({ source: PLUGIN, reason: safeToolMessage(safe.toolCode, safe.field) });
    }
  }, { priority: -100 });
  for (const descriptor of ROUTINE_TOOL_DESCRIPTORS) {
    bus.registerService<ToolCall, unknown>(`tool:execute:${descriptor.name}`, PLUGIN, async (parent, call) => {
      // Never accept another tool's authorization at this endpoint: delete and
      // fire deliberately have identical input shapes.
      if (call?.name !== descriptor.name) throw new SafeToolError('validation', 'input');
      const ctx: AgentContext = { ...parent, state: new Map(parent.state) };
      ctx.state.delete('decisions:routine-execution');
      ctx.state.delete('decisions:routine-consent-grant');
      let prepared: Prepared;
      try { prepared = await prepare({ bus, store, ctx, call }); }
      catch (error) { throw safeFailure(error); }
      if (!prepared.receiptKey) {
        try { return await bus.call(prepared.hook, ctx, prepared.input); }
        catch (error) { throw safeFailure(error); }
      }
      let authorization: { authorizationId: string; requestId: string };
      let binding: z.output<typeof executionBindingSchema>;
      try {
        authorization = await bus.call('decisions:authorize-routine-call', ctx, { call });
        binding = executionBindingSchema.parse(ctx.state.get('decisions:routine-execution'));
        if (authorization.requestId !== prepared.receiptKey.requestId || binding.authorizationId !== authorization.authorizationId || binding.requestId !== authorization.requestId)
          throw new SafeToolError('forbidden', 'requestId');
      } catch (error) { throw safeFailure(error); }
      // This signal is invocation-local coordination, never durable authority.
      // Key by authority so parallel calls sharing the original host ctx cannot
      // overwrite each other's unknown outcomes. Nothing is sent over IPC.
      const pendingKey = `routines:pending-effect:${authorization.authorizationId}`;
      const pending = (): never => {
        parent.state.set(pendingKey, { authorizationId: authorization.authorizationId, requestId: authorization.requestId,
          fingerprint: binding.fingerprint, agentId: ctx.agentId, userId: ctx.userId });
        throw new SafeToolError('unavailable', 'input');
      };
      const settle = async (outcome: 'succeeded' | 'failed', failure?: SafeToolError) => {
        try {
          await bus.callJoined('decisions:settle-routine-call', ctx, {
            authorizationId: authorization.authorizationId, outcome, ...(failure ? { failureCode: failure.toolCode } : {}),
          });
          parent.state.delete(pendingKey);
        } catch { pending(); }
      };
      let output: unknown;
      let effectError: unknown;
      let knownFailure = false;
      try {
        // An active dispatch replay must prove its outcome. Merely accepting it
        // again would turn an uncertain/failed external call into false success.
        const previous = prepared.receiptKey.operation === 'dispatch'
          ? await recover(store, ctx, prepared.receiptKey, binding.outcome === 'succeeded') : { kind: 'absent' as const };
        if (previous.kind === 'pending') pending();
        if (previous.kind === 'failed') { knownFailure = true; throw new SafeToolError('unavailable', 'input'); }
        if (previous.kind === 'committed') output = previous.output;
        else output = await bus.callJoined(prepared.hook, ctx, prepared.input);
        if (output !== null && typeof output === 'object' && ('error' in output || ('status' in output && output.status === 'error'))) {
          knownFailure = true;
          throw new SafeToolError('unavailable', 'input');
        }
      } catch (error) { effectError = error; }
      if (effectError !== undefined) {
        const safe = safeFailure(effectError);
        let recovered: Recovery;
        try { recovered = await recover(store, ctx, prepared.receiptKey, binding.outcome === 'succeeded'); }
        catch { return pending(); }
        if (recovered.kind === 'committed' && !knownFailure) output = recovered.output;
        else if (knownFailure || recovered.kind === 'failed' || recovered.kind === 'absent') {
          // Joined effects have finished. A successful empty receipt lookup
          // proves no durable effect, regardless of the provider's error class.
          await settle('failed', safe);
          throw safe;
        } else return pending();
      }
      await settle('succeeded');
      return output;
    });
    await bus.call('tool:register', makeAgentContext({ sessionId: 'init', agentId: PLUGIN, userId: 'system' }), descriptor);
  }
}
