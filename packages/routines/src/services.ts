import { SafeToolError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import * as C from '@ax/routines-contract';
import type { RoutinesStore } from './store.js';
import type { AcceptedDispatch, FireRow, OpenCheckInLookup, ReportRefusal, StoredRoutine } from './types.js';
import { credentialRef, editableDefinition, deleteRequestHash, updateRequestHash, parseStoredRoutine, validationError } from './definition.js';
import { drainRoutineCleanup } from './cleanup.js';
import { advanceToNextActiveWindow } from './active-hours.js';

const PLUGIN = '@ax/routines';
export const ROUTINE_SERVICES = [
  'list', 'get', 'create', 'update', 'delete', 'fire-now', 'recent-fires', 'recent-fires-for-agent',
  'set-webhook-secret', 'list-defaults', 'get-default', 'upsert-default', 'delete-default',
  'set-agent-default-enabled', 'list-agent-defaults', 'report', 'clear-notes', 'tasks-for-conversations',
  'reply', 'recent-replies',
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
    noRecentUpdate: noRecentUpdateView(row, userId) };
}
/**
 * TASK-907. A task's state goes only to its owner. A check-in runs as the owner,
 * with what only they can reach, so its report and agent notes can carry that, and
 * sharing a task is a later feature (design §14, question 8). Whoever can see the
 * routine still sees the routine. Decided here, where every view is made (list,
 * get, create, update, their replays, the tools' recovery), so no caller (a tool,
 * the Settings routes, the Tasks page) needs a rule of its own for these. It covers
 * `task`, its missed check-ins (`noRecentUpdate`, TASK-930: `noRecentUpdateView`) and
 * `report` only: a fire's `renderedPrompt` is not gated here (a task run's
 * check-in message never lands there: fire.ts stores `renderedPrompt: null` for task
 * runs, TASK-908). A repeat routine shows none either: changing a kind clears it, and
 * this hides any a row holds anyway.
 */
function taskView(row: StoredRoutine, userId: string): C.RoutineTaskView | null {
  if (row.ownerUserId !== userId || row.kind === 'repeat' || row.task === null) return null;
  const { status, update, ask, reportedAt, agentNotes } = row.task;
  return { status, update, ask, reportedAt: reportedAt.toISOString(), agentNotes };
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
 * where the task's state goes: only to the routine's owner (`taskView`). The owners
 * are read only when some run has a report, and a run whose routine is gone shows none.
 */
async function fireViews(store: RoutinesStore, agentId: string, userId: string, fires: FireRow[]): Promise<C.RoutineFireView[]> {
  const reported = [...new Set(fires.flatMap(fire => fire.report === null ? [] : [fire.routineId]))];
  const owners = reported.length === 0 ? new Map<string, string>() : await store.routineOwners({ agentId, routineIds: reported });
  return fires.map(({ id: _id, firedAt, report, ...fire }) => {
    // Fails closed: a report shows only when an owner is found and it is this person.
    // A deleted routine has no row, so it has no owner, and its runs' reports show to no one.
    const owner = owners.get(fire.routineId);
    return { ...fire, firedAt: firedAt.toISOString(), report: owner !== undefined && owner === userId ? report : null };
  });
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
   * TASK-931. What a stored reply does next, decided on the routine as `addReply` read it under its
   * row lock. The order is the point: `not-allowed` comes before `paused`, so "when you resume the
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
    return { fires: await fireViews(store, input.agentId, ctx.userId, fires) };
  });
  register('recent-fires-for-agent', C.RoutineRecentFiresForAgentInputSchema, C.RoutineRecentFiresForAgentOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const { before } = input;
    const fires = await store.recentFiresForAgent({ agentId: input.agentId, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(before === undefined ? {} : { before: new Date(before) }) });
    return { fires: await fireViews(store, input.agentId, ctx.userId, fires) };
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
  // run's row lock. It writes nothing when it refuses. It tries the write once. A failed write
  // throws an error naming only the run and the SQLSTATE (store.ts, reportWriteError); its other
  // statements (the fence, the locked reads, the commit) carry no report text, so their errors
  // can't quote it either. The tool logs a failure as one routines_report_failed warn line and
  // answers the closed "unavailable", a 503, which the runner's IPC client retries up to its 5xx
  // cap: a retry runs the whole report again, and a report that lands just replaces the run's report.
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
    let checkIn: C.RoutineReplyCheckIn;
    try {
      checkIn = await replyCheckIn(ctx, a.allowed, outcome.row, outcome.replyId, send);
    } catch (err) {
      // The reply was stored (and is still there unless the routine was deleted meanwhile), but its
      // check-in step failed: say so so a stored reply with no check-in behind it can be found. Ids
      // and the closed tool code only; the error's message may carry anything.
      ctx.logger.warn('routines_reply_check_in_failed', {
        agentId: input.agentId, routineId: input.routineId, replyId: outcome.replyId,
        toolCode: err instanceof SafeToolError ? err.toolCode : 'unknown',
      });
      throw err;
    }
    ctx.logger.info('routines_reply_added', { agentId: input.agentId, routineId: input.routineId, checkIn, replayed: outcome.outcome === 'replayed' });
    return { replyId: outcome.replyId, checkIn };
  }));
  // TASK-931. A task's replies, newest first, for its owner only: taskView's rule, not `allowed`'s,
  // so an owner who no longer manages the agent's tasks still reads their own. agents:resolve runs
  // first, as for every read. Then only the routine's owner column is read (as fireViews does), so a
  // row another read couldn't parse can't fail this one. Anyone else, and a routine that's gone, gets
  // none, all alike. Each reply goes out field by field. Neither a tool nor an IPC action.
  register('recent-replies', C.RoutineRecentRepliesInputSchema, C.RoutineRecentRepliesOutputSchema, async (ctx, input) => {
    await access(ctx, input.agentId);
    const owner = (await store.routineOwners({ agentId: input.agentId, routineIds: [input.routineId] })).get(input.routineId);
    // Fails closed: replies go out only when an owner is found and it is this person.
    if (owner === undefined || owner !== ctx.userId) return { replies: [] };
    const replies = await store.recentReplies({ agentId: input.agentId, routineId: input.routineId, limit: input.limit ?? RECENT_REPLIES_DEFAULT_LIMIT });
    return { replies: replies.map(reply => ({ replyId: reply.replyId, authorUserId: reply.authorUserId, text: reply.text, sentAt: reply.sentAt.toISOString() })) };
  });
}
