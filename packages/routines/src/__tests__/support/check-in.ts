import { makeAgentContext, SYSTEM_PROMPT_LANDED_HOOK, type AgentContext, type HookBus } from '@ax/core';
import type { RoutineView } from '@ax/routines-contract';
import { ROUTINES_AUGMENT_PROVIDER } from '../../brief.js';
import { createRoutineHarness, type RoutineHarness } from './routine-harness.js';

// TASK-908: a task check-in, end to end through the real routines, agents,
// tool-policy and decisions plugins and Postgres, with an agent:invoke stub that
// does what the orchestrator does with a routine's invoke, in its order.

/**
 * The task the TASK-907 canary checks in on: a stay-on-top task with its whole
 * brief. Parse it with `RoutineDefinitionSchema` to create it.
 */
export const TASK_DEFINITION = {
  name: 'Support queue', promptBody: 'Keep the support queue empty.', trigger: { kind: 'interval', every: '15m' },
  kind: 'stay-on-top', goodWhen: 'No ticket waits longer than an hour.',
} as const;

/**
 * The context a tool call from a check-in's runner reaches the host with, as
 * the IPC listener mints it: a fresh reqId, and the session's own person,
 * agent, conversation and source. `over` stands in for a session that differs.
 */
export function routineRunner(ctx: AgentContext, over: { userId?: string; conversationId?: string } = {}): AgentContext {
  const conversationId = over.conversationId ?? ctx.conversationId;
  return makeAgentContext({
    userId: over.userId ?? ctx.userId, agentId: ctx.agentId, sessionId: 'check-in', source: 'routine',
    ...(conversationId === undefined ? {} : { conversationId }),
  });
}

/** The agent's turn in a check-in. */
export type CheckInBody = (ctx: AgentContext, bus: HookBus) => Promise<void>;
export type CheckInOptions = {
  /**
   * What `chat:system-prompt-landed` lists. Left out, it is what the
   * orchestrator would send: the routines provider when its answer had a
   * non-empty `brief`; `[]` otherwise.
   * `null` skips the event, as a spawn path that forgot it would.
   */
  landed?: readonly string[] | null;
  /** Who presses Check now. Default: the harness's owner. */
  asOwner?: AgentContext;
};
/**
 * What one check-in saw: the user message its invoke got, the invoke's ctx, and
 * the routines provider's answer (undefined when no such provider is registered).
 */
export type CheckIn = { message: string; ctx: AgentContext; brief: unknown };
export type CheckInHarness = RoutineHarness & {
  /**
   * One check-in of `view`, started with Check now. It resolves once the
   * invoke returns, with what the check-in saw, and rethrows a failure inside
   * `body` (fire.ts would otherwise swallow a failed assertion there). The
   * harness answers every conversations:create with the same id, so only one
   * check-in may be open at a time.
   */
  checkIn(view: RoutineView, requestId: string, body: CheckInBody, opts?: CheckInOptions): Promise<CheckIn>;
};

type HarnessOptions = NonNullable<Parameters<typeof createRoutineHarness>[0]>;
type Seen = CheckIn & { failure: { error: unknown } | null };
type Waiting = { body: CheckInBody; opts: CheckInOptions; seen(outcome: Seen): void };

/** The user message fire.ts sends: `{ message: { role: 'user', content } }`. */
function messageOf(input: unknown): string {
  const content = (input as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== 'string') throw new Error('agent:invoke got no user message');
  return content;
}

function hasBrief(answer: unknown): boolean {
  const brief = (answer as { brief?: unknown } | undefined)?.brief;
  return typeof brief === 'string' && brief.length > 0;
}

/**
 * The orchestrator's order for a fresh spawn: call the routines provider with
 * the invoke's own ctx, fire `chat:system-prompt-landed`, and end the turn
 * `terminated` with `system-prompt:<reason>` on a veto, before any turn runs.
 * Otherwise the turn runs and ends the way a runner ends it. A provider that
 * throws fails the check-in loudly here, where the orchestrator would drop its
 * block: no test expects one to throw.
 */
async function orchestrate(ctx: AgentContext, bus: HookBus, input: unknown, turn: Waiting | undefined): Promise<unknown> {
  const opts = turn?.opts ?? {};
  let message = '';
  let brief: unknown;
  let failure: { error: unknown } | null = null;
  try {
    message = messageOf(input);
    const registered = bus.hasService(ROUTINES_AUGMENT_PROVIDER);
    if (registered) brief = await bus.call(ROUTINES_AUGMENT_PROVIDER, ctx, {});
    if (opts.landed !== null) {
      const providers = opts.landed ?? (hasBrief(brief) ? [ROUTINES_AUGMENT_PROVIDER] : []);
      const landed = await bus.fire(SYSTEM_PROMPT_LANDED_HOOK, ctx, { reqId: ctx.reqId, providers: [...providers] });
      if (landed.rejected) return { kind: 'terminated', reason: `system-prompt:${landed.reason}` };
    }
    try { await (turn?.body ?? (async () => {}))(ctx, bus); }
    catch (error) { failure = { error }; }
    await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
    return { kind: 'complete' };
  } catch (error) {
    failure ??= { error };
    throw error;
  } finally {
    turn?.seen({ message, ctx, brief, failure });
  }
}

/** A routine harness whose agent:invoke does what the orchestrator does, plus `checkIn`. */
export async function createCheckInHarness(options: Omit<HarnessOptions, 'invoke'> = {}): Promise<CheckInHarness> {
  let waiting: Waiting | undefined;
  const h = await createRoutineHarness({
    ...options,
    // An invoke nobody's `checkIn` waits for (the tick's, say) gets the same treatment and an empty turn.
    invoke: (ctx, bus, input) => {
      const turn = waiting;
      waiting = undefined;
      return orchestrate(ctx, bus, input, turn);
    },
  });
  async function checkIn(view: RoutineView, requestId: string, body: CheckInBody, opts: CheckInOptions = {}): Promise<CheckIn> {
    if (waiting !== undefined) throw new Error('One check-in at a time: the harness gives every run the same conversation.');
    const seen = new Promise<Seen>(resolve => { waiting = { body, opts, seen: resolve }; });
    try {
      const started = await h.bus.call<unknown, { status: string }>('routines:fire-now', opts.asOwner ?? h.owner, {
        agentId: view.agentId, routineId: view.routineId, expectedRevision: view.revision, requestId,
      });
      // 'error' means the run failed before its invoke, so nothing will ever take `waiting`.
      if (started.status !== 'ok') throw new Error(`The check-in failed before its turn started (fire-now answered ${started.status}).`);
    } catch (error) {
      waiting = undefined;
      throw error;
    }
    const outcome = await seen;
    if (outcome.failure !== null) throw outcome.failure.error;
    return { message: outcome.message, ctx: outcome.ctx, brief: outcome.brief };
  }
  return { ...h, checkIn };
}
