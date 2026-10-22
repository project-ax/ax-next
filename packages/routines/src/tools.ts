import {
  makeAgentContext, reject, SafeToolError, safeToolMessage,
  type AgentContext, type HookBus, type ToolCall, type ToolDescriptor,
} from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore, OperationKey } from './store.js';
import {
  createRequestHash, updateRequestHash, deleteRequestHash, dispatchRequestHash,
  editableDefinition, parseStoredRoutine, validationError,
} from './definition.js';
import { AcceptedDispatchSchema } from './dispatch.js';
import { parseRoutineInput, reportRefused, routinePermissions, routineView } from './services.js';

const PLUGIN = '@ax/routines';
const names = Object.keys(C.RoutineToolInputSchemas) as C.RoutineToolName[];
export const ROUTINE_TOOL_HOOKS = names.map(name => `tool:execute:${name}`);
const activities: Record<C.RoutineToolName, string> = {
  routine_list: 'Reading routines', routine_get: 'Reading a routine', routine_create: 'Creating a routine',
  routine_update: 'Updating a routine', routine_delete: 'Deleting a routine', routine_fire_now: 'Starting a routine',
  routine_report: 'Reporting on a task',
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

/**
 * TASK-907. A check-in's report, tied to the run it came from by the session
 * alone. Every fact read here is host-set: the IPC listener takes the person,
 * agent, conversation and source off the session row the runner's token
 * resolves to, and the input names no task, run or conversation. Read-only, so
 * pre-call can run it too; `routines:report` checks the run again under its
 * locks before it writes. The one refusal tells the agent only that this isn't
 * a check-in; an info line tells the operator why (`reportRefused`).
 */
async function prepareReport({ store, ctx, call }: Pick<Invocation, 'store' | 'ctx' | 'call'>): Promise<Prepared> {
  const { notes, ...report } = parseRoutineInput(C.RoutineReportToolInputSchema, call.input);
  const conversationId = ctx.conversationId;
  if (ctx.source !== 'routine') throw reportRefused(ctx, 'tool', 'no-source');
  if (typeof conversationId !== 'string' || conversationId.length === 0) throw reportRefused(ctx, 'tool', 'no-conversation');
  const lookup = await store.findOpenDispatchByConversation({ agentId: ctx.agentId, conversationId });
  if (lookup.run === null) throw reportRefused(ctx, 'tool', lookup.reason);
  const { run } = lookup;
  const ids = { dispatchId: run.dispatchId, routineId: run.routineId };
  // `=== 'stay-on-top'`, not `!== 'repeat'`: a write path fails closed for a kind it doesn't know.
  if (run.kind !== 'stay-on-top') throw reportRefused(ctx, 'tool', 'wrong-kind', ids);
  if (run.ownerUserId !== ctx.userId) throw reportRefused(ctx, 'tool', 'wrong-owner', ids);
  // Parsed, an explicit `notes: undefined` is still a key. It means "left out", which keeps the saved notes.
  return { hook: 'routines:report', input: { agentId: ctx.agentId, dispatchId: run.dispatchId, ...report, ...(notes === undefined ? {} : { notes }) } };
}

/** Read-only validation. Ownership reconciliation belongs to management get/list, never preflight. */
async function prepare({ bus, store, ctx, call }: Invocation): Promise<Prepared> {
  if (C.routineToolKind(call?.name) === null) throw new SafeToolError('validation', 'input');
  const name = call.name as C.RoutineToolName;
  // Validate before touching policy/decisions or loading any private state.
  parseRoutineInput(C.RoutineToolInputSchemas[name], call.input);
  // A report is the run's own output, not routine management: it answers to the
  // check-in it ran in, never to agents:resolve or agents:can-manage-routines.
  if (name === 'routine_report') return prepareReport({ store, ctx, call });
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
  } else if (name === 'routine_delete' || name === 'routine_fire_now') {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineDeleteToolInputSchema, call.input) };
    const fire = name === 'routine_fire_now';
    prepared = { hook: fire ? 'routines:fire-now' : 'routines:delete', input,
      receiptKey: { ...scope, requestId: input.requestId, operation: fire ? 'dispatch' : 'delete', inputHash: fire ? dispatchRequestHash({ ...input, source: 'manual' }) : deleteRequestHash(input) } };
  } else {
    // Every tool has its own branch, so one this code doesn't know is refused,
    // never read as another tool's call (TASK-907). The `never` makes a new
    // tool without a branch a build error.
    const _unhandled: never = name;
    void _unhandled;
    throw new SafeToolError('validation', 'input');
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
      catch (error) { throw validationError(error); }
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

/**
 * TASK-907. `routines:list` and `routines:update` keep a task's agent notes (the
 * Tasks page reads them), but their tools leave them out: a list holds every
 * routine and reaches every chat, and "how's the support queue?" needs the report
 * alone; an edit's answer needs no notes at all. Only routine_get, read before
 * working on a task, carries them. The projection is explicit and the strict
 * output schemas then enforce it, so an agentNotes key can't ride along.
 */
function withoutAgentNotes({ task, ...routine }: C.RoutineView) {
  if (task === null) return { ...routine, task };
  const { agentNotes: _agentNotes, ...report } = task;
  return { ...routine, task: report };
}
/**
 * TASK-907. A task's state goes back only into its owner's chats. A check-in runs
 * as the task's owner, with what only they can reach, so its report and notes can
 * carry it; on a team agent, every other person's chats with that agent see
 * `task: null`. A view carries no owner, so the rows are read here, after the
 * service's read, and only when some view has state to hide. A routine gone by
 * then shows none. The `routines:*` services stay as they are: the Tasks page
 * decides its own visibility (TASK-909).
 */
async function ownersTasksOnly<V extends { routineId: string; task: object | null }>(store: RoutinesStore, ctx: AgentContext, views: V[]): Promise<V[]> {
  const withState = views.filter(view => view.task !== null);
  if (withState.length === 0) return views;
  const rows = withState.length === 1
    ? [await store.findOne({ agentId: ctx.agentId, routineId: withState[0]!.routineId })]
    : await store.list({ agentId: ctx.agentId });
  const owned = new Set(rows.flatMap(row => row !== null && row.ownerUserId === ctx.userId ? [row.routineId] : []));
  return views.map(view => view.task === null || owned.has(view.routineId) ? view : { ...view, task: null });
}
async function listToolOutput(store: RoutinesStore, ctx: AgentContext, output: unknown): Promise<C.RoutineListToolOutput> {
  const { routines } = C.RoutineListOutputSchema.parse(output);
  return C.RoutineListToolOutputSchema.parse({ routines: await ownersTasksOnly(store, ctx, routines.map(withoutAgentNotes)) });
}
async function getToolOutput(store: RoutinesStore, ctx: AgentContext, output: unknown): Promise<C.RoutineView> {
  const [view] = await ownersTasksOnly(store, ctx, [C.RoutineGetOutputSchema.parse(output)]);
  return view!;
}
/** Every answer routine_update gives leaves here: live, replayed by the service, or recovered from its receipt. */
async function updateToolOutput(store: RoutinesStore, ctx: AgentContext, output: unknown): Promise<C.RoutineUpdateToolOutput> {
  const [view] = await ownersTasksOnly(store, ctx, [withoutAgentNotes(C.RoutineUpdateOutputSchema.parse(output))]);
  return C.RoutineUpdateToolOutputSchema.parse(view);
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
        try {
          const output = await bus.call(prepared.hook, ctx, prepared.input);
          if (call.name === 'routine_list') return await listToolOutput(store, ctx, output);
          if (call.name === 'routine_get') return await getToolOutput(store, ctx, output);
          return output;
        }
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
      if (call.name !== 'routine_update') return output;
      // The edit has happened whatever the projection does; if it fails, it fails closed.
      try { return await updateToolOutput(store, ctx, output); }
      catch (error) { throw safeFailure(error); }
    });
    await bus.call('tool:register', makeAgentContext({ sessionId: 'init', agentId: PLUGIN, userId: 'system' }), descriptor);
  }
}
