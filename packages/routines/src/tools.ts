import {
  makeAgentContext, reject, SafeToolError, safeToolMessage,
  type AgentContext, type HookBus, type ToolCall, type ToolDescriptor,
} from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore, OperationKey } from './store.js';
import {
  createRequestHashes, updateRequestHashes, deleteRequestHash, dispatchRequestHash,
  editableDefinition, isStopOnlyPatch, parseStoredRoutine, validateScheduleWrite, validationError,
} from './definition.js';
import { AcceptedDispatchSchema } from './dispatch.js';
import { parseRoutineInput, reportRefused, resolveRoutineAccess, routinePermissions, routineView } from './services.js';

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
/** TASK-907. The check-in a report is for, as `prepareReport` found it. */
type ReportRun = { dispatchId: string; routineId: string };
type Prepared = { hook: string; input: unknown; receiptKey?: OperationKey; run?: ReportRun };
function safeFailure(error: unknown): SafeToolError {
  return error instanceof SafeToolError ? new SafeToolError(error.toolCode, error.field) : new SafeToolError('unavailable', 'input');
}
/**
 * TASK-907. A report the hook couldn't write. The agent gets the closed
 * "unavailable" (`safeFailure`), and the operator this one warn line: the run,
 * its task and the hook's message. A failed write's message names only the run
 * and the SQLSTATE (store.ts, `reportWriteError`), and the hook's other
 * statements carry no report text, so no message can quote it. A refusal is a
 * `SafeToolError` with a line of its own (`reportRefused`).
 */
function reportFailed(ctx: AgentContext, run: ReportRun, error: unknown): void {
  ctx.logger.warn('routines_report_failed', {
    agentId: ctx.agentId, conversationId: ctx.conversationId, ...run, err: error instanceof Error ? error.message : 'not an Error',
  });
}
function requireAllowed(allowed: boolean): void { if (!allowed) throw new SafeToolError('forbidden', 'input'); }

/**
 * TASK-907. A check-in's report, tied to the run it came from by the session
 * alone. Every fact read here is host-set: the IPC listener takes the person,
 * agent, conversation and source off the session row the runner's token
 * resolves to, and the input names no task, run or conversation. Read-only, so
 * pre-call can run it too; `routines:report` checks the run again under its
 * locks before it writes. The one refusal tells the agent only that this isn't
 * a check-in; an info line tells the operator why (`reportRefused`). TASK-948:
 * `steps` on a check-in of a task with no checklist is a wrong call, refused
 * as a validation error naming the field. TASK-950: so is `done` true on a
 * check-in of a task that isn't get-done.
 */
async function prepareReport({ store, ctx, call }: Pick<Invocation, 'store' | 'ctx' | 'call'>): Promise<Prepared> {
  const { notes, steps, done, ...report } = parseRoutineInput(C.RoutineReportToolInputSchema, call.input);
  const conversationId = ctx.conversationId;
  if (ctx.source !== 'routine') throw reportRefused(ctx, 'tool', 'no-source');
  if (typeof conversationId !== 'string' || conversationId.length === 0) throw reportRefused(ctx, 'tool', 'no-conversation');
  const lookup = await store.findOpenDispatchByConversation({ agentId: ctx.agentId, conversationId }).catch((error: unknown) => {
    // No run to name yet, so this line carries the ids the lookup was given, which the host set, and the database's
    // own words: a select over those two ids, so nothing in the message can quote the report. The agent still gets
    // the closed "unavailable" (`safeFailure`). Pre-call and the call each run this lookup, so each leaves a line.
    ctx.logger.warn('routines_report_failed', {
      stage: 'lookup', agentId: ctx.agentId, conversationId, err: error instanceof Error ? error.message : 'not an Error',
    });
    throw error;
  });
  if (lookup.run === null) throw reportRefused(ctx, 'tool', lookup.reason);
  const { run } = lookup;
  const ids = { dispatchId: run.dispatchId, routineId: run.routineId };
  // `TASK_KINDS`, not `!== 'repeat'`: an explicit allowlist, so a write path refuses a kind it doesn't know.
  if (!C.isTaskKind(run.kind)) throw reportRefused(ctx, 'tool', 'wrong-kind', ids);
  if (run.ownerUserId !== ctx.userId) throw reportRefused(ctx, 'tool', 'wrong-owner', ids);
  // TASK-948. A checklist is a "get-done" task's alone. Steps on any other task's check-in are a wrong
  // call, not a race, so they're refused here, before anything is written, naming the field: the agent
  // can send the report again without them. (The race, a kind change landing after this read, is the
  // store's: under its row lock it skips every step change for a task that is no longer get-done.)
  if (steps !== undefined && run.kind !== 'get-done') throw new SafeToolError('validation', 'steps');
  // TASK-950. The same for a claim that the task is done: only a get-done task finishes, so the agent hears
  // which field to drop before anything is written. (The race is the store's again: under its row lock it
  // writes no claim for a task that is no longer get-done, and the report still lands.)
  if (done === true && run.kind !== 'get-done') throw new SafeToolError('validation', 'done');
  // Parsed, an explicit `notes: undefined` is still a key. It means "left out", which keeps the saved notes.
  return {
    hook: 'routines:report', run: ids,
    input: {
      agentId: ctx.agentId, dispatchId: run.dispatchId, ...report, ...(notes === undefined ? {} : { notes }),
      ...(steps === undefined ? {} : { steps }), ...(done === undefined ? {} : { done }),
    },
  };
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
  const { allowed, stopOthers } = await bus.call<unknown, { allowed: boolean; stopOthers?: boolean }>('agents:can-manage-routines', ctx, { agentId: ctx.agentId });
  if (name === 'routine_list') return { hook: 'routines:list', input: { agentId: ctx.agentId } };
  if (name === 'routine_get') return { hook: 'routines:get', input: { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineGetToolInputSchema, call.input) } };
  requireAllowed(allowed === true);
  let prepared: Prepared & { receiptKey: OperationKey };
  const scope = { agentId: ctx.agentId, actorUserId: ctx.userId };
  if (name === 'routine_create') {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineCreateToolInputSchema, call.input) };
    const hashes = createRequestHashes(input);
    prepared = { hook: 'routines:create', input, receiptKey: { ...scope, requestId: input.requestId, operation: 'create', inputHash: hashes[0]!, compatibleInputHashes: hashes.slice(1) } };
  } else if (name === 'routine_update') {
    const input = { agentId: ctx.agentId, ...parseRoutineInput(C.RoutineUpdateToolInputSchema, call.input) };
    const hashes = updateRequestHashes(input);
    prepared = { hook: 'routines:update', input, receiptKey: { ...scope, requestId: input.requestId, operation: 'update', inputHash: hashes[0]!, compatibleInputHashes: hashes.slice(1) } };
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
      const stopOnly = name === 'routine_update' && isStopOnlyPatch((prepared.input as C.RoutineUpdateInput).patch);
      const permissions = routinePermissions(row, ctx.userId, allowed, stopOthers === true);
      requireAllowed(permissions.edit || (stopOnly && permissions.stop));
    } else if (name === 'routine_fire_now') requireAllowed(AcceptedDispatchSchema.parse(receipt).row.ownerUserId === ctx.userId);
    return prepared;
  }
  let next: C.RoutineDefinition | undefined;
  let routineId: string | undefined;
  if (name === 'routine_create') {
    next = (prepared.input as C.RoutineCreateInput).definition;
    validateScheduleWrite(next);
  }
  else {
    const input = prepared.input as C.RoutineDeleteInput;
    routineId = input.routineId;
    const row = await store.findOne(input);
    if (!row) throw new SafeToolError('not-found', 'routineId');
    // TASK-930: only a person resumes a paused task (design §3.6, §7), ax's pause after five check-ins without a
    // report included; Always Allow no longer covers it (closes TASK-906 decisions row 25). This runs at pre-call,
    // before any hold, so a resume can't ride a brief edit onto a card that doesn't draw `enabled`, and again at
    // execute, so a call pre-call saw differently is refused too. Every pause mints a new revision, so a resume read
    // against the row before one fails revision-conflict in updateAuthored. A receipt replay returned above and can
    // only replay an edit that already happened. `!== 'repeat'`: a kind this code doesn't know is refused.
    if (name === 'routine_update' && row.kind !== 'repeat' && !row.enabled && (prepared.input as C.RoutineUpdateInput).patch.enabled === true)
      throw new SafeToolError('forbidden', 'enabled');
    // Personal ownership changes mint a new revision on routine_get. Do not
    // mutate here or approve a proposal against the old owner/revision.
    if (row.revision !== input.expectedRevision || (agent.ownerType === 'user' && row.ownerUserId !== agent.ownerId))
      throw new SafeToolError('revision-conflict', 'expectedRevision');
    const permissions = routinePermissions(row, ctx.userId, allowed, stopOthers === true);
    if (name === 'routine_fire_now') {
      requireAllowed(permissions.fire);
      if (!row.enabled) throw new SafeToolError('disabled', 'enabled');
    } else if (name === 'routine_delete') requireAllowed(permissions.stop);
    else {
      const patch = (prepared.input as C.RoutineUpdateInput).patch;
      requireAllowed(permissions.edit || (permissions.stop && isStopOnlyPatch(patch)));
      try { next = C.applyRoutinePatch(editableDefinition(row), patch); }
      catch (error) { throw validationError(error); }
      validateScheduleWrite(next, row, patch);
    }
  }
  if (next?.webhook !== undefined && next.webhook !== null) {
    const duplicate = await store.findWebhook({ agentId: ctx.agentId, path: next.webhook.path });
    if (duplicate && duplicate.routineId !== routineId) throw new SafeToolError('webhook-path-conflict', 'webhook.path');
  }
  return prepared;
}
export async function preflightRoutineCall(input: Invocation): Promise<void> { await prepare(input); }

const executionBindingSchema = z.object({
  authorizationId: z.string().min(1), requestId: z.string().min(1), fingerprint: z.string().min(1),
  outcome: z.literal('succeeded').nullable(),
}).strict();
type Recovery = { kind: 'committed'; output: unknown } | { kind: 'failed' } | { kind: 'pending' } | { kind: 'absent' };
async function recover(bus: HookBus, store: RoutinesStore, ctx: AgentContext, key: OperationKey, succeeded: boolean, stopOnly = false): Promise<Recovery> {
  const receipt = await store.findOperationReceipt(key);
  if (receipt === null) return { kind: 'absent' };
  if (key.operation === 'create' || key.operation === 'update') {
    const access = await resolveRoutineAccess(bus, store, ctx, ctx.agentId);
    const row = parseStoredRoutine(receipt);
    const permissions = routinePermissions(row, ctx.userId, access.allowed, access.stopOthers);
    if (!permissions.edit && !(key.operation === 'update' && stopOnly && permissions.stop)) return { kind: 'failed' };
    return { kind: 'committed', output: routineView(row, ctx.userId, access.allowed, access.stopOthers) };
  }
  if (key.operation === 'delete') return { kind: 'committed', output: C.RoutineDeleteOutputSchema.parse(receipt) };
  if (succeeded) return { kind: 'committed', output: { status: 'ok' } };
  const accepted = AcceptedDispatchSchema.parse(receipt);
  const outcome = await store.getDispatchOutcome({ agentId: ctx.agentId, dispatchId: accepted.dispatchId });
  if (!outcome) return { kind: 'pending' };
  return outcome.status === 'error' ? { kind: 'failed' } : { kind: 'committed', output: { status: 'ok' } };
}

/**
 * TASK-907. `routines:list` and `routines:update` keep a task's agent notes for
 * its owner (the Tasks page reads them), but their tools leave them out: a list
 * holds every routine and reaches every chat, and "how's the support queue?"
 * needs the report alone; an edit's answer needs no notes at all. TASK-948: the
 * same for a "get-done" task's steps, so these answers stay small: up to 50
 * steps of 200 characters per task would otherwise ride along in every chat's
 * list. Only routine_get, read before working on a task, carries both. The
 * projection is explicit and the strict output schemas then enforce it, so an
 * agentNotes or steps key can't ride along. Who sees a task's state at all is
 * the services' rule (`routineView`): anyone but the owner gets `task: null`
 * and no steps before it gets here. TASK-951: a "get-done" task's finish date
 * stays in both answers. It's one short date a person set, not agent text, and
 * it tells the agent how much time is left when it says how a task is going.
 * TASK-955: so does the zone the date was set from, a zone id the contract's
 * rule accepted.
 */
function listToolView({ task, steps: _steps, ...routine }: C.RoutineView) {
  if (task === null) return { ...routine, task };
  const { agentNotes: _agentNotes, ...report } = task;
  return { ...routine, task: report };
}
function listToolOutput(output: unknown): C.RoutineListToolOutput {
  const { routines } = C.RoutineListOutputSchema.parse(output);
  return C.RoutineListToolOutputSchema.parse({ routines: routines.map(listToolView) });
}
/**
 * Every answer routine_update gives leaves here: live, replayed by the service, or
 * recovered from its receipt. It runs after the edit has settled, so it reads
 * nothing (TASK-907), and it can't refuse a view a producer makes: the live and
 * replayed answers passed the service's `returns` schema, which is the first
 * parse here, and a recovered one is routineView over a receipt that passed
 * StoredRoutineSchema (the same definition rules, and ids the host made). The
 * strict check differs from that schema only by the agent notes and the steps
 * the projection takes out (`listToolView`).
 */
function updateToolOutput(output: unknown): C.RoutineUpdateToolOutput {
  return C.RoutineUpdateToolOutputSchema.parse(listToolView(C.RoutineUpdateOutputSchema.parse(output)));
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
          return call.name === 'routine_list' ? listToolOutput(output) : output;
        }
        catch (error) {
          if (prepared.run !== undefined && !(error instanceof SafeToolError)) reportFailed(ctx, prepared.run, error);
          throw safeFailure(error);
        }
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
      const stopOnly = prepared.receiptKey.operation === 'update' && isStopOnlyPatch((prepared.input as C.RoutineUpdateInput).patch);
      try {
        // An active dispatch replay must prove its outcome. Merely accepting it
        // again would turn an uncertain/failed external call into false success.
        const previous = prepared.receiptKey.operation === 'dispatch'
          ? await recover(bus, store, ctx, prepared.receiptKey, binding.outcome === 'succeeded') : { kind: 'absent' as const };
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
        try { recovered = await recover(bus, store, ctx, prepared.receiptKey, binding.outcome === 'succeeded', stopOnly); }
        catch { return pending(); }
        if (recovered.kind === 'committed' && !knownFailure) output = recovered.output;
        else if (knownFailure || recovered.kind === 'failed' || recovered.kind === 'absent') {
          // Joined effects have finished. A failed effect, absent receipt or
          // current row-authority refusal must preserve the closed error.
          await settle('failed', safe);
          throw safe;
        } else return pending();
      }
      await settle('succeeded');
      if (call.name !== 'routine_update') return output;
      // The edit has happened, and nothing from here can say otherwise: the answer is a projection
      // that reads nothing and can't refuse a real view (updateToolOutput). The catch only keeps a
      // raw error from escaping if that ever stopped being true.
      try { return updateToolOutput(output); }
      catch (error) { throw safeFailure(error); }
    });
    await bus.call('tool:register', makeAgentContext({ sessionId: 'init', agentId: PLUGIN, userId: 'system' }), descriptor);
  }
}
