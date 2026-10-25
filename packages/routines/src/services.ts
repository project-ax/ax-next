import { SafeToolError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore } from './store.js';
import type { AcceptedDispatch, FireRow, OpenCheckInLookup, ReportRefusal, StoredReading, StoredRoutine } from './types.js';
import { credentialRef, editableDefinition, deleteRequestHash, updateRequestHash, parseStoredRoutine, validationError } from './definition.js';
import { drainRoutineCleanup } from './cleanup.js';
import { advanceToNextActiveWindow } from './active-hours.js';

const PLUGIN = '@ax/routines';
export const ROUTINE_SERVICES = [
  'list', 'get', 'create', 'update', 'delete', 'fire-now', 'recent-fires', 'recent-fires-for-agent',
  'set-webhook-secret', 'list-defaults', 'get-default', 'upsert-default', 'delete-default',
  'set-agent-default-enabled', 'list-agent-defaults', 'report', 'clear-notes', 'tasks-for-conversations',
  'reply', 'recent-replies', 'set-steps', 'set-finish-by', 'complete', 'reopen', 'duplicate',
].map(name => `routines:${name}`);
/** TASK-931. How many replies `routines:recent-replies` reads when the caller names no limit (the contract's default). */
const RECENT_REPLIES_DEFAULT_LIMIT = 20;
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
  // The tick skips a run outside the active hours and re-arms it at the next window's start (tick.ts), so that's when it will run (TASK-910).
  const nextRunAt = row.nextRunAt === null || row.activeHours === null ? row.nextRunAt : advanceToNextActiveWindow(row.nextRunAt, row.activeHours);
  return { ...editableDefinition(row), agentId: row.agentId, routineId: row.routineId, revision: row.revision,
    origin: row.definitionId === null ? 'authored' : 'default', defaultRoutineId: row.definitionId,
    nextRunAt: nextRunAt?.toISOString() ?? null, lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus, lastError: row.lastError, lastWarning: row.lastWarning,
    permissions: routinePermissions(row, userId, allowed), task: taskView(row, userId),
    noRecentUpdate: noRecentUpdateView(row, userId), steps: stepsView(row, userId), finishBy: finishByView(row),
    done: doneView(row, userId) };
}
/**
 * TASK-907. A task's state goes only to its owner. A check-in runs as the owner,
 * with what only they can reach, so its report and agent notes can carry that, and
 * sharing a task is a later feature (design §14, question 8). Whoever can see the
 * routine still sees the routine. Decided here, where every view is made (list,
 * get, create, update, their replays, the tools' recovery), so no caller (a tool,
 * the Settings routes, the Tasks page) needs a rule of its own for these. It covers
 * `task`, its missed check-ins (`noRecentUpdate`, TASK-930: `noRecentUpdateView`), a
 * "get-done" task's steps (TASK-948: `stepsView`), when a get-done task was marked
 * done (TASK-950: `doneView`) and `report` only: a fire's
 * `renderedPrompt` is not gated here (a task run's check-in message never lands
 * there: fire.ts stores `renderedPrompt: null` for task runs, TASK-908). A repeat
 * routine shows none either: changing a kind clears it, and this hides any a row
 * holds anyway. TASK-952: a report's reading is part of `task` and of `report`,
 * so it follows the same rule. TASK-950: so is a report's claim that the task is
 * done (`doneClaimed`), which only a "get-done" task makes: `=== 'get-done'`, an
 * explicit allowlist, so a row of any other kind that holds one shows none.
 * TASK-951: a "get-done" task's finish date isn't task state, so this rule
 * doesn't cover it (`finishByView`).
 */
function taskView(row: StoredRoutine, userId: string): C.RoutineTaskView | null {
  if (row.ownerUserId !== userId || row.kind === 'repeat' || row.task === null) return null;
  const { status, update, ask, reading, doneClaimed, reportedAt, agentNotes } = row.task;
  return {
    status, update, ask, reading: readingView(reading), doneClaimed: row.kind === 'get-done' && doneClaimed,
    reportedAt: reportedAt.toISOString(), agentNotes,
  };
}
/**
 * TASK-950. When a person marked a "get-done" task done, under `taskView`'s rule:
 * only its owner sees it. The store says Done only while it holds (`doneOf`: off,
 * and finished by its owner), and `=== 'get-done'` is an explicit allowlist, so a
 * row of any other kind that holds a completion shows none. Only the time: who
 * marked it is always the owner, so `byUserId` stays here.
 */
function doneView(row: StoredRoutine, userId: string): C.RoutineDoneView | null {
  if (row.done === null || row.ownerUserId !== userId || row.kind !== 'get-done') return null;
  return { at: row.done.at.toISOString() };
}
/** TASK-952. A report's reading as a view shows it: field by field, never a spread, so nothing the store reads reaches the view unnamed. */
function readingView(reading: StoredReading | null): C.RoutineReadingView | null {
  return reading === null ? null : { value: reading.value, label: reading.label };
}
/**
 * TASK-948. A "get-done" task's checklist, under `taskView`'s rule: only its
 * owner sees it. `=== 'get-done'`, an explicit allowlist: no other kind has a
 * checklist, so a stay-on-top row that holds steps (a hand edit) shows none,
 * and so does a kind this code doesn't know. Each step is projected field by
 * field, so whatever else a stored step holds stays here.
 */
function stepsView(row: StoredRoutine, userId: string): C.RoutineStepView[] {
  if (row.ownerUserId !== userId || row.kind !== 'get-done') return [];
  return row.steps.map(({ id, text, done, addedBy }) => ({ id, text, done, addedBy }));
}
/**
 * TASK-951. A "get-done" task's finish date, or null. `=== 'get-done'`, an
 * explicit allowlist, as for `stepsView`: no other kind has one, so a row of
 * another kind that holds a date (a hand edit, or a change of kind made by code
 * from before schema version 12, which didn't clear it) shows none, and so does
 * a kind this code doesn't know. Not under `taskView`'s rule: a person set the
 * date, it holds no agent text, and it is about the work rather than what only
 * the owner can reach, so whoever can see the routine sees it (TASK-951
 * decisions row 19). The store has already read it through the contract's rule.
 */
function finishByView(row: StoredRoutine): string | null {
  return row.kind === 'get-done' ? row.finishBy : null;
}
/**
 * TASK-930. A task's check-ins in a row that ended without a report, under
 * `taskView`'s rule: only its owner sees them, and a repeat routine shows none.
 * Host-written (a count, a closed code, an instant), never agent text. Projected
 * field by field, so the stored pause time stays here: `autoPaused` says ax's
 * pause still holds, so a task running again (resumed by code from before the
 * reset, or by hand) isn't shown as paused, whatever its row's pause time says.
 */
function noRecentUpdateView(row: StoredRoutine, userId: string): C.RoutineNoRecentUpdateView | null {
  if (row.ownerUserId !== userId || row.kind === 'repeat' || row.noRecentUpdate === null) return null;
  const { inARow, reason, at, autoPausedAt } = row.noRecentUpdate;
  return { inARow, reason, at: at.toISOString(), autoPaused: autoPausedAt !== null && !row.enabled };
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
/**
 * TASK-907. A run's report is its task's state as that run left it, so it goes
 * where the task's state goes: only to the routine's owner (`taskView`).
 * TASK-936: that owner comes with each row, read in the statement that listed
 * the run (`FireRow.routineOwnerUserId`), and that statement lists a live
 * routine's runs only when they ran as its owner. So who ran a run and who may
 * read its report come from one read, and can't disagree across a change of
 * owner. The owner is dropped here, so it never reaches a view.
 */
function fireViews(userId: string, fires: FireRow[]): C.RoutineFireView[] {
  return fires.map(({ id: _id, firedAt, report, routineOwnerUserId, ...fire }) => ({
    ...fire, firedAt: firedAt.toISOString(),
    // Fails closed: a report shows only when the run's routine has an owner and it is this person.
    // A deleted routine has no row, so it has no owner, and its runs' reports show to no one.
    // Field by field, never a spread, so nothing the store reads reaches the view unnamed.
    report: routineOwnerUserId !== null && routineOwnerUserId === userId && report !== null
      ? { status: report.status, update: report.update, ask: report.ask, reading: readingView(report.reading) } : null,
  }));
}
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
  /**
   * TASK-931. What a stored reply does next, decided on the routine as the store left it under its
   * row lock: `addReply`'s, for `routines:reply`, and TASK-950's `reopenTask`'s, for `routines:reopen`
   * (Not yet and Reopen are replies too), reopened or with its claim taken back when the reply was
   * new. The order is the point: `not-allowed` comes before `paused`, so "when you resume the
   * task" is only said to someone who may resume it (for a task's owner, `fire` is
   * agents:can-manage-routines' answer). The check-in is keyed on the reply, not on the caller's
   * requestId, so one reply starts at most one check-in and never shares a receipt with a Check now
   * press. A replayed reply runs this again: a retry after the reply was stored but before its
   * check-in was accepted starts that check-in, and a retry after it was accepted replays the
   * receipt. That convergence covers failures before the accept commits, not after: a host restart
   * between the accept and the run's setup records that run as interrupted, a retry answers
   * `replayed`, and nothing reads the reply until the next check-in (as for Check now). The reply
   * stays stored. `started` means accepted, not finished: `send`'s answer isn't read, and a
   * check-in that fails during setup is a recorded failed run.
   */
  async function replyCheckIn(ctx: AgentContext, allowed: boolean, row: StoredRoutine, replyId: string, send: (accepted: AcceptedDispatch) => Promise<unknown>): Promise<C.RoutineReplyCheckIn> {
    if (!routinePermissions(row, ctx.userId, allowed).fire) return 'not-allowed';
    if (!row.enabled) return 'paused';
    const key = { agentId: row.agentId, routineId: row.routineId };
    let result: Awaited<ReturnType<RoutinesStore['acceptDispatch']>>;
    try {
      result = await store.acceptDispatch({ ...key, expectedRevision: row.revision, actorUserId: ctx.userId, source: 'manual', requestId: `reply:${replyId}`, now: now() });
    } catch (err) {
      // The receipt's hash covers the revision: this reply's check-in was accepted before, at an earlier one.
      if (err instanceof SafeToolError && err.toolCode === 'request-conflict') return 'replayed';
      throw err;
    }
    if (result === null) {
      // The routine changed between the reply's write and this accept. The reply is stored either
      // way, so the answer follows the routine as it is now, in the same order as above.
      const fresh = await store.findOne(key);
      if (fresh === null) throw new SafeToolError('not-found', 'routineId');
      if (!routinePermissions(fresh, ctx.userId, allowed).fire) return 'not-allowed';
      if (!fresh.enabled) return 'paused';
      // Still running, at a new revision: a resend replays the reply and starts its check-in then.
      throw new SafeToolError('unavailable', 'input');
    }
    if (result.replayed) return 'replayed';
    await send(result.accepted);
    return 'started';
  }
  /**
   * `replyCheckIn` for a reply the store just stored or found, for `routines:reply` and (TASK-950)
   * `routines:reopen`. When the step throws, the reply is stored (and still there unless the routine
   * was deleted meanwhile) with no check-in behind it, so one warn line says so and it can be found.
   * Ids and the closed tool code only: the error's message may carry anything.
   */
  async function storedReplyCheckIn(ctx: AgentContext, allowed: boolean, key: C.RoutineKey, stored: { row: StoredRoutine; replyId: string }, send: (accepted: AcceptedDispatch) => Promise<unknown>): Promise<C.RoutineReplyCheckIn> {
    try {
      return await replyCheckIn(ctx, allowed, stored.row, stored.replyId, send);
    } catch (err) {
      ctx.logger.warn('routines_reply_check_in_failed', {
        agentId: key.agentId, routineId: key.routineId, replyId: stored.replyId,
        toolCode: err instanceof SafeToolError ? err.toolCode : 'unknown',
      });
      throw err;
    }
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
    await access(ctx, input.agentId);
    const fires = await store.recentFires({ agentId: input.agentId, routineId: input.routineId, ...(input.limit === undefined ? {} : { limit: input.limit }) });
    return { fires: fireViews(ctx.userId, fires) };
  });
  register('recent-fires-for-agent', C.RoutineRecentFiresForAgentInputSchema, C.RoutineRecentFiresForAgentOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const { before } = input;
    const fires = await store.recentFiresForAgent({ agentId: input.agentId, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(before === undefined ? {} : { before: new Date(before) }) });
    return { fires: fireViews(ctx.userId, fires) };
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
  // context's conversation, and a check-in of a task (any task kind, TASK_KINDS) its actor owns,
  // all under the run's row lock. It writes nothing when it refuses. TASK-948: the store applies a
  // report's step changes under the same lock (and skips them all for a task that isn't get-done).
  // The answer counts them, and one info line, routines_report_steps, carries the counts and ids,
  // never a step's text. It tries the write once. A failed write throws an error naming only the
  // run and the SQLSTATE (store.ts, reportWriteError); its other statements (the fence, the locked
  // reads, the commit) carry no report text, so their errors can't quote it either. The tool logs a
  // failure as one routines_report_failed warn line and answers the closed "unavailable", a 503,
  // which the runner's IPC client retries up to its 5xx cap: a retry runs the whole report again. A
  // report that lands just replaces the run's report, and its step changes find their work done (an
  // add whose text is already on the list is skipped), so only the counts differ. TASK-950: `done`
  // true is the agent's claim that a get-done task is finished. The input schema refuses it without
  // "needs-you"; the store writes it beside the report, for a get-done task only, and any later report
  // without it takes it back. It goes to the store on its own, never inside `report`, which is the
  // run's three fields. Once a person has marked the task done, the store refuses every report
  // (`'done'`, through reportRefused like the others), so a check-in still running then can't write
  // onto the finished task.
  register('report', C.RoutineReportInputSchema, C.RoutineReportOutputSchema, async (ctx, input) => {
    const { agentId, dispatchId, notes, reading, steps, done, ...report } = input;
    const conversationId = ctx.conversationId;
    if (ctx.source !== 'routine') throw reportRefused(ctx, 'hook', 'no-source', { dispatchId });
    if (typeof conversationId !== 'string' || conversationId.length === 0) throw reportRefused(ctx, 'hook', 'no-conversation', { dispatchId });
    if (agentId !== ctx.agentId) throw reportRefused(ctx, 'hook', 'not-bound', { dispatchId });
    // TASK-952: a reading left out or sent as null is none this time. TASK-950: so is a claim left out or false.
    const outcome = await store.recordReport({
      agentId, dispatchId, conversationId, actorUserId: ctx.userId, report,
      ...(notes === undefined ? {} : { notes }), reading: reading ?? null, ...(steps === undefined ? {} : { steps }),
      ...(done === true ? { done: true } : {}), now: now(),
    });
    if (outcome === 'recorded') return { recorded: true as const };
    if (typeof outcome === 'string') throw reportRefused(ctx, 'hook', outcome, { dispatchId });
    const { applied, skipped } = outcome;
    ctx.logger.info('routines_report_steps', { agentId, dispatchId, applied, skipped });
    return { recorded: true as const, steps: { applied, skipped } };
  });
  // TASK-910. The person clears a task's agent notes on its task page. Only the task's owner may,
  // whether or not they still manage the agent's tasks: the owner is the only person the notes are
  // shown to (taskView), and clearing removes agent-written text, so it can't add reach. So there's
  // no `allowed` check, but agents:resolve still runs first and refuses an agent the caller can't
  // reach. The store decides ownership under the routine's row lock, and after it answers no run
  // accepted at or before the clear can write notes again. Neither a tool nor an IPC action, so no
  // model can call it. The log line carries ids only: the notes are the agent's text.
  register('clear-notes', C.RoutineClearNotesInputSchema, C.RoutineClearNotesOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const outcome = await store.clearAgentNotes({ ...input, actorUserId: ctx.userId, now: now() });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    ctx.logger.info('routines_notes_cleared', { agentId: input.agentId, routineId: input.routineId });
    return { cleared: true as const };
  });
  // TASK-951. The person sets or removes a "get-done" task's finish date on its task page. Only the
  // task's owner may, whether or not they still manage the agent's tasks: the date changes only how
  // the agent words its status at its check-ins, so it adds no reach. So there's no `allowed` check,
  // but agents:resolve still runs first and refuses an agent the caller can't reach. The input
  // schema checked the date before anything ran. The store then decides the owner and the kind
  // under the agent fence and the routine's row lock, so a task that stopped being get-done before
  // the write (a change of kind committed first) is not-found, and it never moves the revision: an
  // edit, Check now or Pause held against the current one still lands. Neither a tool nor an IPC
  // action, so no model can set it. The log line carries ids and a flag only, never the date.
  register('set-finish-by', C.RoutineSetFinishByInputSchema, C.RoutineSetFinishByOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const outcome = await store.setFinishBy({ agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, finishBy: input.finishBy });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    ctx.logger.info('routines_finish_by_set', { agentId: input.agentId, routineId: input.routineId, cleared: outcome.finishBy === null });
    return { finishBy: outcome.finishBy };
  });
  // TASK-932. Which of these conversations are check-ins of the caller's own tasks, so Today can name the
  // task an approval was held in. A label, never an authorization: approve and dismiss go through
  // @ax/decisions as before. agents:resolve runs first, as for every read; the store then answers only
  // for routines ctx.userId owns (taskView's rule, not `allowed`'s), so another person's task names
  // never leave, and a conversation that isn't a check-in, isn't theirs or that several runs shared is
  // simply absent, all alike. Neither a tool nor an IPC action, so no model can call it.
  register('tasks-for-conversations', C.RoutineTasksForConversationsInputSchema, C.RoutineTasksForConversationsOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    return { checkIns: await store.tasksForConversations({ agentId: input.agentId, actorUserId: ctx.userId, conversationIds: input.conversationIds }) };
  });
  // TASK-931. A task's owner writes to their agent about the task, on its task page. Only the owner
  // may, on a team agent too: the store decides that under the agent fence and the routine's row
  // lock, after agents:resolve has refused anyone who can't reach the agent. The text was checked by
  // the input schema before anything ran. The reply is stored first; a check-in starts only when
  // the task runs and the caller may start its check-ins (replyCheckIn), keyed on the reply, so a
  // retry can't start two. The whole hook runs inside admitDispatch, like fire-now, so a shutting-down
  // host refuses it before anything is written. Neither a tool nor an IPC action: a reply reaches a
  // model only in a check-in message. The log lines carry ids and closed words, never the text: one
  // per reply, and a warn when a stored reply's check-in step throws.
  register('reply', C.RoutineReplyInputSchema, C.RoutineReplyOutputSchema, (ctx, input) => admitDispatch(async () => {
    const a = await access(ctx, input.agentId);
    const send = dispatch;
    if (!send) throw new SafeToolError('unavailable', 'input');
    const outcome = await store.addReply({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, requestId: input.requestId, text: input.text, now: now(),
    });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    const checkIn = await storedReplyCheckIn(ctx, a.allowed, input, outcome, send);
    ctx.logger.info('routines_reply_added', { agentId: input.agentId, routineId: input.routineId, checkIn, replayed: outcome.outcome === 'replayed' });
    return { replyId: outcome.replyId, checkIn };
  }));
  // TASK-950. Mark done: a person finishes a "get-done" task. Only its owner, while they manage the
  // agent's tasks: `edit`, from routinePermissions (its one definition) over the row as agents:resolve
  // left it. The store decides owner and kind again under the routine's row lock and throws its
  // refusals, which pass through as they are. It starts nothing, so it runs outside admitDispatch. The
  // same requestId again answers from its receipt and writes nothing. Neither a tool nor an IPC
  // action: only a person marks a task done. The log line carries ids only.
  register('complete', C.RoutineCompleteInputSchema, C.RoutineCompleteOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId);
    const row = await rowFor(input);
    await store.completeTask({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, requestId: input.requestId,
      mayEdit: routinePermissions(row, ctx.userId, a.allowed).edit, now: now(),
    });
    ctx.logger.info('routines_task_completed', { agentId: input.agentId, routineId: input.routineId });
    return { done: true as const };
  });
  // TASK-950. Not yet, and Reopen on a Done task: the task's owner tells their agent what's left. It is
  // a reply (`routines:reply`'s rules, its text checked by the input schema before anything ran), and
  // reopening a Done task also needs `edit`, read here as for complete and decided again by the store
  // under the row lock before the reply is stored, so a refused Reopen stores nothing. A new reply takes
  // back the agent's claim and, on a Done task, runs it again; then the reply's own check-in step runs
  // (`storedReplyCheckIn`, keyed on the reply). Inside admitDispatch, like reply, so a shutting-down host
  // refuses it before anything is written. Neither a tool nor an IPC action. The log lines carry ids and
  // closed words, never the text.
  register('reopen', C.RoutineReopenInputSchema, C.RoutineReopenOutputSchema, (ctx, input) => admitDispatch(async () => {
    const a = await access(ctx, input.agentId);
    const send = dispatch;
    if (!send) throw new SafeToolError('unavailable', 'input');
    const row = await rowFor(input);
    const outcome = await store.reopenTask({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, requestId: input.requestId, text: input.text,
      mayEdit: routinePermissions(row, ctx.userId, a.allowed).edit, now: now(),
    });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    const checkIn = await storedReplyCheckIn(ctx, a.allowed, input, outcome, send);
    ctx.logger.info('routines_task_reopened', { agentId: input.agentId, routineId: input.routineId, wasDone: outcome.wasDone, checkIn });
    return { replyId: outcome.replyId, checkIn };
  }));
  // TASK-931. A task's replies, newest first, for its owner only: taskView's rule, not `allowed`'s,
  // so an owner who no longer manages the agent's tasks still reads their own. agents:resolve runs
  // first, as for every read (and moves a user-owned agent's routines to its owner). Then the store
  // reads, in one statement, only the replies the caller wrote on a routine they own now: anyone
  // else, and a routine that's gone, gets none, all alike, and once a routine moves to a new owner
  // (reconcileOwners) the earlier owner's replies reach no one. It compares the routine's owner
  // column only, so a row another read couldn't parse can't fail this one. Each reply goes out field
  // by field. Neither a tool nor an IPC action.
  register('recent-replies', C.RoutineRecentRepliesInputSchema, C.RoutineRecentRepliesOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const replies = await store.recentReplies({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, limit: input.limit ?? RECENT_REPLIES_DEFAULT_LIMIT,
    });
    return { replies: replies.map(reply => ({ replyId: reply.replyId, authorUserId: reply.authorUserId, text: reply.text, sentAt: reply.sentAt.toISOString() })) };
  });
  // TASK-949. A task's owner changes its steps on its task page. Only the owner may, whether or not they still
  // manage the agent's tasks (clear-notes' rule, TASK-910; replies', TASK-931): the steps are shown to no one else
  // (stepsView), and changing them adds no reach, since the next check-in still runs under the agent's own approval
  // rules. agents:resolve runs first, and the input schema has checked every change's text before anything ran; the
  // store decides ownership under the routine's row lock, and a retry under the same requestId changes nothing.
  // `forbidden` is someone else's task, or a Done task's steps (TASK-950: a Done task's steps are its record, so
  // the store refuses every change to them under the same lock, a replay included).
  // Neither a tool nor an IPC action, so no model can call it. Each step goes out field by field, and the log line
  // carries ids, counts and whether the store answered from the receipt (`replayed`, as routines_reply_added does;
  // it stays out of the answer), never a step's text.
  register('set-steps', C.RoutineSetStepsInputSchema, C.RoutineSetStepsOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const outcome = await store.setSteps({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId, requestId: input.requestId, ops: input.ops,
    });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    ctx.logger.info('routines_steps_set', { agentId: input.agentId, routineId: input.routineId, ops: input.ops.length, skipped: outcome.skipped, replayed: outcome.replayed });
    return { steps: outcome.steps.map(({ id, text, done, addedBy }) => ({ id, text, done, addedBy })), skipped: outcome.skipped };
  });
  // TASK-953. A person copies their own task on its task page. Who may is routines:create's rule (someone who may
  // manage the agent's tasks; the copy is the agent's owner's on a personal agent, else the caller's), plus `edit` on
  // the source, so only its owner copies it, and never a default. Both are checked before the store is asked, and the
  // store decides the owner again under the agent fence and the source's row lock, whatever this read saw. Neither a
  // tool nor an IPC action, so no model can call it. No approval: the person is the copy's author, pressing Duplicate
  // themselves, and the copy stays paused until a person resumes it. The answer is the copy's id, field by field, and
  // the log line carries ids and whether the store answered from the receipt (`replayed`, as routines_steps_set does;
  // it stays out of the answer), never the task's name or steps.
  register('duplicate', C.RoutineDuplicateInputSchema, C.RoutineDuplicateOutputSchema, async (ctx, input) => {
    const a = await access(ctx, input.agentId); requireAllowed(a.allowed);
    requireAllowed(routinePermissions(await rowFor({ agentId: input.agentId, routineId: input.routineId }), ctx.userId, a.allowed).edit);
    const outcome = await store.duplicateAuthored({
      agentId: input.agentId, routineId: input.routineId, actorUserId: ctx.userId,
      ownerUserId: a.agent.ownerType === 'user' ? a.agent.ownerId : ctx.userId, requestId: input.requestId, now: now(),
    });
    if (outcome === 'not-found') throw new SafeToolError('not-found', 'routineId');
    if (outcome === 'forbidden') throw new SafeToolError('forbidden', 'input');
    ctx.logger.info('routines_task_duplicated', { agentId: input.agentId, routineId: input.routineId, copyId: outcome.routineId, replayed: outcome.replayed });
    return { routineId: outcome.routineId };
  });
}
