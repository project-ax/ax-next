import { SafeToolError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore } from './store.js';
import type { AcceptedDispatch, FireRow, OpenCheckInLookup, ReportRefusal, StoredRoutine } from './types.js';
import { credentialRef, editableDefinition, deleteRequestHash, updateRequestHash, parseStoredRoutine, validationError } from './definition.js';
import { drainRoutineCleanup } from './cleanup.js';

const PLUGIN = '@ax/routines';
export const ROUTINE_SERVICES = [
  'list', 'get', 'create', 'update', 'delete', 'fire-now', 'recent-fires', 'recent-fires-for-agent',
  'set-webhook-secret', 'list-defaults', 'get-default', 'upsert-default', 'delete-default',
  'set-agent-default-enabled', 'list-agent-defaults', 'report',
].map(name => `routines:${name}`);
type Agent = { id: string; ownerType: 'user' | 'team'; ownerId: string };
export function parseRoutineInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}
export async function resolveRoutineAccess(bus: HookBus, store: RoutinesStore, ctx: AgentContext, agentId: string) {
  const { agent } = await bus.callJoined<{ agentId: string; userId: string }, { agent: Agent }>('agents:resolve', ctx, { agentId, userId: ctx.userId });
  const { allowed } = await bus.callJoined<{ agentId: string }, { allowed: boolean }>('agents:can-manage-routines', ctx, { agentId });
  if (agent.ownerType === 'user') await store.reconcileOwners({ agents: [{ agentId, ownerUserId: agent.ownerId }] });
  return { agent, allowed };
}
export function routinePermissions(row: StoredRoutine, userId: string, allowed: boolean): C.RoutinePermissions {
  const own = allowed && row.ownerUserId === userId && row.definitionId === null;
  return { edit: own, stop: allowed && row.definitionId === null, fire: allowed && row.ownerUserId === userId, manageSecret: own };
}
export function routineView(row: StoredRoutine, userId: string, allowed: boolean): C.RoutineView {
  return { ...editableDefinition(row), agentId: row.agentId, routineId: row.routineId, revision: row.revision,
    origin: row.definitionId === null ? 'authored' : 'default', defaultRoutineId: row.definitionId,
    nextRunAt: row.nextRunAt?.toISOString() ?? null, lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus, lastError: row.lastError, lastWarning: row.lastWarning,
    permissions: routinePermissions(row, userId, allowed), task: taskView(row) };
}
/** TASK-907. A repeat routine shows no task state. Changing a kind clears it; this hides any a row holds anyway. */
function taskView(row: StoredRoutine): C.RoutineTaskView | null {
  if (row.kind === 'repeat' || row.task === null) return null;
  const { status, update, ask, reportedAt, agentNotes } = row.task;
  return { status, update, ask, reportedAt: reportedAt.toISOString(), agentNotes };
}
function requireAllowed(allowed: boolean): void { if (!allowed) throw new SafeToolError('forbidden', 'input'); }
/** TASK-907. Every reason a report is refused: the tool's lookup, the hook's own context check, and the store's under its locks. */
export type ReportRefusalReason = 'no-source' | 'no-conversation' | Extract<OpenCheckInLookup, { run: null }>['reason'] | 'wrong-kind' | 'wrong-owner' | ReportRefusal;
/**
 * TASK-907. A refused report, for the agent and for the operator. The agent gets
 * the closed "only during a task check-in" and nothing more; the operator gets
 * one info line with where it was refused (`tool`, the read-only lookup at
 * pre-call and execute, or `hook`, routines:report), a fixed reason and ids.
 * Never the report's text.
 */
export function reportRefused(ctx: AgentContext, stage: 'tool' | 'hook', reason: ReportRefusalReason, ids: { dispatchId?: string; routineId?: string } = {}): SafeToolError {
  const conversation = typeof ctx.conversationId === 'string' && ctx.conversationId.length > 0 ? { conversationId: ctx.conversationId } : {};
  ctx.logger.info('routines_report_refused', { stage, reason, agentId: ctx.agentId, ...conversation, ...ids });
  return new SafeToolError('not-in-check-in', 'input');
}
function fireView({ id: _id, firedAt, ...row }: FireRow): C.RoutineFireView { return { ...row, firedAt: firedAt.toISOString() }; }
export function registerRoutineServices({ bus, store, now, dispatch, admitDispatch = effect => effect() }: {
  bus: HookBus; store: RoutinesStore; now: () => Date;
  admitDispatch?: <T>(effect: () => Promise<T>) => Promise<T>;
  dispatch?: (accepted: AcceptedDispatch) => Promise<C.RoutineFireNowOutput>;
}): void {
  function register<I, O>(name: string, input: z.ZodType<I, z.ZodTypeDef, unknown>, returns: z.ZodType<O, z.ZodTypeDef, unknown>, handler: (ctx: AgentContext, input: I) => Promise<O>) {
    bus.registerService(`routines:${name}`, PLUGIN, (ctx, raw) => handler(ctx, parseRoutineInput(input, raw)), { returns });
  }
  const access = (ctx: AgentContext, agentId: string) => resolveRoutineAccess(bus, store, ctx, agentId);
  async function rowFor(input: C.RoutineKey) {
    const row = await store.findOne(input);
    if (!row) throw new SafeToolError('not-found', 'routineId');
    return row;
  }
  async function admin(ctx: AgentContext) {
    const result = await bus.call<{ userId: string }, { isAdmin: boolean } | null>('auth:get-user', ctx, { userId: ctx.userId });
    requireAllowed(result?.isAdmin === true);
  }
  register('list', C.RoutineListInputSchema, C.RoutineListOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId);
    return { routines: (await store.list(input)).map(row => routineView(row, ctx.userId, a.allowed)) };
  });
  register('get', C.RoutineGetInputSchema, C.RoutineGetOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); return routineView(await rowFor(input), ctx.userId, a.allowed);
  });
  register('create', C.RoutineCreateInputSchema, C.RoutineCreateOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    const row = await store.createAuthored({ ...input, actorUserId: ctx.userId, ownerUserId: a.agent.ownerType === 'user' ? a.agent.ownerId : ctx.userId, now: now() });
    return routineView(row, ctx.userId, a.allowed);
  });
  register('update', C.RoutineUpdateInputSchema, C.RoutineUpdateOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    const receipt = await store.findOperationReceipt({ ...input, actorUserId: ctx.userId, operation: 'update', inputHash: updateRequestHash(input) });
    const row = receipt ? parseStoredRoutine(receipt) : await rowFor(input);
    const own = routinePermissions(row, ctx.userId, a.allowed).edit;
    const stopOnly = Object.keys(input.patch).length === 1 && input.patch.enabled === false;
    requireAllowed(own || (stopOnly && row.definitionId === null));
    if (receipt) return routineView(row, ctx.userId, a.allowed);
    const updated = await store.updateAuthored({ ...input, actorUserId: ctx.userId, now: now(), stopOnly: !own });
    await drainRoutineCleanup({ bus, store });
    return routineView(updated, ctx.userId, a.allowed);
  });
  register('delete', C.RoutineDeleteInputSchema, C.RoutineDeleteOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    const receipt = await store.findOperationReceipt({ ...input, actorUserId: ctx.userId, operation: 'delete', inputHash: deleteRequestHash(input) });
    if (receipt) return C.RoutineDeleteOutputSchema.parse(receipt);
    requireAllowed(routinePermissions(await rowFor(input), ctx.userId, a.allowed).stop);
    const result = await store.deleteAuthored({ ...input, actorUserId: ctx.userId, now: now() });
    await drainRoutineCleanup({ bus, store }); return result;
  });
  register('fire-now', C.RoutineFireNowInputSchema, C.RoutineFireNowOutputSchema, (ctx, input) => admitDispatch(async () => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    const row = await store.findOne(input);
    if (row) {
      requireAllowed(routinePermissions(row, ctx.userId, a.allowed).fire);
      // Revision conflicts are distinct from the effective-enabled rejection.
      // Matching accepted receipts are checked transactionally by acceptDispatch.
    }
    if (!dispatch) throw new SafeToolError('unavailable', 'input');
    const result = await store.acceptDispatch({ ...input, actorUserId: ctx.userId, source: 'manual', now: now() });
    if (!result) {
      if (!row) throw new SafeToolError('not-found', 'routineId');
      if (row.revision !== input.expectedRevision) throw new SafeToolError('revision-conflict', 'expectedRevision');
      throw new SafeToolError('disabled', 'enabled');
    }
    requireAllowed(routinePermissions(result.accepted.row, ctx.userId, a.allowed).fire);
    // 'ok' acknowledges the durable dispatch; replay never claims the turn completed.
    return result.replayed ? { status: 'ok' as const } : dispatch(result.accepted);
  }));
  register('recent-fires', C.RoutineRecentFiresInputSchema, C.RoutineRecentFiresOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId); return { fires: (await store.recentFires({ agentId: input.agentId, routineId: input.routineId, ...(input.limit === undefined ? {} : { limit: input.limit }) })).map(fireView) };
  });
  register('recent-fires-for-agent', C.RoutineRecentFiresForAgentInputSchema, C.RoutineRecentFiresForAgentOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const { before } = input;
    return { fires: (await store.recentFiresForAgent({ agentId: input.agentId, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(before === undefined ? {} : { before: new Date(before) }) })).map(fireView) };
  });
  register('set-webhook-secret', C.RoutineSecretInputSchema, C.RoutineSecretOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId);
    requireAllowed(routinePermissions(await rowFor(input), ctx.userId, a.allowed).manageSecret);
    return store.withLockedWebhookSecret(input, async () => {
      const target = { scope: 'agent', ownerId: input.agentId, ref: credentialRef(input) };
      if (input.operation === 'set') await bus.callJoined('credentials:set', ctx, { ...target, kind: 'api-key', payload: input.secret });
      else await bus.callJoined('credentials:delete', ctx, target);
    });
  });
  register('list-defaults', C.RoutineListDefaultsInputSchema, C.RoutineListDefaultsOutputSchema, async ctx => {
    await admin(ctx); return { defaults: (await store.listDefaults()).map(row => ({ defaultRoutineId: row.defaultRoutineId, name: row.name, description: row.description, trigger: row.trigger as Extract<C.RoutineTrigger, { kind: 'interval' }>, enabled: row.enabled, updatedAt: row.updatedAt.toISOString() })) };
  });
  register('get-default', C.RoutineGetDefaultInputSchema, C.RoutineGetDefaultOutputSchema, async (ctx, input) => {
    await admin(ctx); const row = await store.getDefault(input.defaultRoutineId);
    if (!row) throw new SafeToolError('not-found', 'routineId');
    return { ...row, trigger: row.trigger as Extract<C.RoutineTrigger, { kind: 'interval' }>, updatedAt: row.updatedAt.toISOString() };
  });
  register('upsert-default', C.RoutineUpsertDefaultInputSchema, C.RoutineUpsertDefaultOutputSchema, async (ctx, input) => { await admin(ctx); return store.upsertDefault(input); });
  register('delete-default', C.RoutineDeleteDefaultInputSchema, C.RoutineDeleteDefaultOutputSchema, async (ctx, input) => { await admin(ctx); await store.deleteDefault(input.defaultRoutineId); return {}; });
  register('set-agent-default-enabled', C.RoutineSetAgentDefaultEnabledInputSchema, C.RoutineSetAgentDefaultEnabledOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    // Defaults run under the personal agent owner and are never materialized for teams.
    requireAllowed(a.agent.ownerType === 'user');
    await store.setAgentDefaultEnabled({ ...input, ownerUserId: a.agent.ownerId }); return {};
  });
  register('list-agent-defaults', C.RoutineListAgentDefaultsInputSchema, C.RoutineListAgentDefaultsOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const disabled = new Set(await store.disabledDefaultIdsForAgent(input.agentId));
    return { defaults: (await store.listDefaults()).map(row => ({ defaultRoutineId: row.defaultRoutineId, name: row.name, enabled: !disabled.has(row.defaultRoutineId) })) };
  });
  // TASK-907. A check-in's report is the run's own output, not routine management, so there's no
  // access check here. The hook checks the whole binding itself, whoever calls it: a routine run's
  // context, for the run's own agent; then the store requires the run to be open, bound to that
  // context's conversation, and a check-in of a stay-on-top task its actor owns, all under the
  // run's row lock. It writes nothing when it refuses. A database failure stays an internal error
  // that names only the run. The hook tries the write once, but the tool answers the failure as the
  // closed "unavailable", a 503, which the runner's IPC client retries up to its 5xx cap: a retry
  // runs the whole report again, and a report that lands just replaces the run's report.
  register('report', C.RoutineReportInputSchema, C.RoutineReportOutputSchema, async (ctx, input) => {
    const { agentId, dispatchId, notes, ...report } = input;
    const conversationId = ctx.conversationId;
    if (ctx.source !== 'routine') throw reportRefused(ctx, 'hook', 'no-source', { dispatchId });
    if (typeof conversationId !== 'string' || conversationId.length === 0) throw reportRefused(ctx, 'hook', 'no-conversation', { dispatchId });
    if (agentId !== ctx.agentId) throw reportRefused(ctx, 'hook', 'not-bound', { dispatchId });
    const outcome = await store.recordReport({ agentId, dispatchId, conversationId, actorUserId: ctx.userId, report, ...(notes === undefined ? {} : { notes }), now: now() });
    if (outcome !== 'recorded') throw reportRefused(ctx, 'hook', outcome, { dispatchId });
    return { recorded: true as const };
  });
}
