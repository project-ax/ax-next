import { makeAgentContext, PluginError, type HookBus } from '@ax/core';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import { renderTemplate } from './template.js';
import type { RecordFireInput } from './store.js';

export interface PendingFire {
  row: RoutineRow;
  conversationId: string;
  source: FireSource;
  renderedPrompt: string;
  onTurnEnd: (turn: { contentBlocks?: unknown[] }) => Promise<void>;
}
export type PendingFires = Map<string, PendingFire>;

export interface FireDeps {
  bus: HookBus;
  pending: PendingFires;
  /**
   * Writes the fire's one row when the invoke fails before its turn ends
   * (TASK-679). The rule that keeps it to ONE row: whoever removes the
   * `pending` entry for a reqId writes that fire's row — the chat:turn-end
   * subscriber (`ok` / `silenced`) or the invoke-failure path here (`error`).
   * `Map#delete` returns true to exactly one of them.
   */
  recordFire: (input: RecordFireInput) => Promise<unknown>;
  /**
   * How long after an invoke settles `complete` to wait for its turn end
   * before giving up and recording the fire as an error. Default 60s. The
   * turn end normally arrives BEFORE the invoke settles; the grace only
   * absorbs callback ordering, and the backstop means a turn end that never
   * matches (a runner bug, a lost reqId) can't make a fire vanish from the
   * log or leave its pending entry behind forever.
   */
  turnEndGraceMs?: number;
}

const DEFAULT_TURN_END_GRACE_MS = 60_000;

let nextReqIdCounter = 0;
function makeReqId(): string {
  nextReqIdCounter += 1;
  return `req-routine-${Date.now().toString(36)}-${nextReqIdCounter}`;
}

export function createFireRoutine(deps: FireDeps) {
  return async (
    row: RoutineRow,
    source: FireSource,
    payload?: unknown,
  ): Promise<FireResult> => {
    // sessionId must be unique per fire: session:create rejects duplicates
    // (even when the prior session is terminated), so reusing a stable
    // `routine-<agentId>-<path>` id makes every fire after the first fail
    // downstream. Mint reqId first and fold it into sessionId — keeps the
    // routine-scoped prefix for log readability while guaranteeing
    // uniqueness. See #86.
    // TASK-397 — the identity every step below runs as is `row.ownerUserId`:
    // the routine's OWNER, derived from the agent, NOT the author of the last
    // edit to `.ax/routines/<name>.md`. The bound is unchanged from when this
    // read `row.authorUserId`: `agents:resolve` still gates the fire, so
    // execution stays inside the set already authorised for this agent. What
    // changed is which member of that set is used, and that it no longer
    // moves when a different authorised person writes the file.
    const reqId = makeReqId();
    const sessionId = `routine-${row.agentId}-${row.path}-${reqId}`;
    const baseCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
    });

    try {
      await deps.bus.call<
        { agentId: string; userId: string },
        { agent: { id: string; ownerId?: string; workspaceRef?: string | null } }
      >('agents:resolve', baseCtx, { agentId: row.agentId, userId: row.ownerUserId });
    } catch (err) {
      if (err instanceof PluginError) {
        return {
          status: 'error',
          error: `${err.code}: ${err.message}`,
          conversationId: null,
          renderedPrompt: null,
          // TASK-680 — `agents:resolve` answers `not-found` only when the
          // agent row does not exist (a present-but-not-yours agent is
          // `forbidden`). The tick treats this as terminal and prunes the
          // agent's routines; every other failure stays retryable. The
          // hookName check matters: a `not-found` raised by something the
          // resolve calls on the way (a team-membership lookup, say) and
          // propagated through it says nothing about the agent, and pruning
          // a live agent's routines is not recoverable.
          ...(err.code === 'not-found' && err.hookName === 'agents:resolve'
            ? { agentGone: true }
            : {}),
        };
      }
      throw err;
    }

    let conversationId: string;
    try {
      if (row.conversation === 'shared') {
        const out = await deps.bus.call<
          unknown,
          { conversation: { conversationId: string }; created: boolean }
        >('conversations:find-or-create', baseCtx, {
          userId: row.ownerUserId,
          agentId: row.agentId,
          externalKey: row.path,
          // AW-6: `origin: 'routine'` is what makes a tool call held inside a
          // scheduled fire resolve as UNATTENDED — the host replays the
          // approved call itself, because by the time anyone answers, the turn
          // that raised it is long over and there is no warm agent to hand it
          // back to.
          fallback: { title: row.name, hidden: true, origin: 'routine' },
        });
        conversationId = out.conversation.conversationId;
      } else {
        const conv = await deps.bus.call<
          unknown,
          { conversationId: string }
        >('conversations:create', baseCtx, {
          userId: row.ownerUserId,
          agentId: row.agentId,
          title: `${row.name} @ ${new Date().toISOString()}`,
          hidden: true,
          // AW-6: see the shared-conversation branch above.
          origin: 'routine',
        });
        conversationId = conv.conversationId;
      }
    } catch (err) {
      if (err instanceof PluginError) {
        return {
          status: 'error',
          error: `${err.code}: ${err.message}`,
          conversationId: null,
          renderedPrompt: null,
        };
      }
      throw err;
    }

    const fireCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.ownerUserId,
      conversationId,
      // Mark this as a routine-originated (non-user) turn. A subscriber that
      // must not act on internally-generated turns would key off ctx.source.
      // None in-tree does since @ax/memory-strata's deletion (TASK-608);
      // @ax/memory stores routine turns too, but with no conversation, so a
      // routine run never counts as one the person had (TASK-616). See
      // AgentContext.source.
      source: 'routine',
      // Human-authored label for a status line ("Right now this agent is…").
      // Must be set here, at the moment the turn starts: @ax/routines only
      // writes its fire row (the conversationId→routine join) at
      // chat:turn-end, i.e. AFTER the turn it would describe, so there is no
      // way to recover which routine is mid-flight once work has begun.
      triggerLabel: row.name,
    });

    // Phase D: render whenever payload is provided, regardless of source.
    // fire-now can carry a payload with source='manual' (Task 2 plan).
    const prompt =
      payload !== undefined
        ? renderTemplate(row.promptBody, { payload })
        : row.promptBody;

    deps.pending.set(reqId, {
      row, conversationId, source,
      renderedPrompt: prompt,
      onTurnEnd: async () => {},
    });

    // The invoke settles AFTER its turn in the ordinary case, so on success
    // the chat:turn-end subscriber has already taken the pending entry and
    // written the row. Only when the entry is still ours — the invoke threw,
    // came back `terminated` without a turn ever ending, or came back
    // `complete` and no turn end claimed it within the grace — is this the
    // fire's one row, and then it is an error: a fire that never produced a
    // turn must not vanish from the log (routines design §5.2, "errors are
    // visible").
    const settleWithoutTurn = async (error: string): Promise<void> => {
      if (!deps.pending.delete(reqId)) return;
      process.stderr.write(
        `[ax/routines] agent:invoke failed for ${row.agentId}/${row.path}: ${error}\n`,
      );
      try {
        await deps.recordFire({
          agentId: row.agentId, path: row.path,
          triggerSource: source,
          conversationId,
          status: 'error', error,
          renderedPrompt: prompt,
        });
      } catch (err) {
        process.stderr.write(
          `[ax/routines] recording failed fire for ${row.agentId}/${row.path} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };

    void deps.bus.call<unknown, { kind?: string; reason?: unknown } | undefined>(
      'agent:invoke', fireCtx, {
        message: { role: 'user', content: prompt },
      },
    ).then(
      (outcome) => {
        if (outcome?.kind === 'terminated') {
          return settleWithoutTurn(`terminated: ${String(outcome.reason ?? 'unknown')}`);
        }
        if (deps.pending.has(reqId)) {
          const timer = setTimeout(() => {
            void settleWithoutTurn('the run finished without reporting a result');
          }, deps.turnEndGraceMs ?? DEFAULT_TURN_END_GRACE_MS);
          timer.unref?.();
        }
        return undefined;
      },
      (err: unknown) => settleWithoutTurn(err instanceof Error ? err.message : String(err)),
    );

    // TASK-679: the row for this fire is written when the turn settles, not
    // here — see FireResult.recordedAtTurnEnd.
    return {
      status: 'ok', conversationId, error: null, renderedPrompt: prompt,
      recordedAtTurnEnd: true,
    };
  };
}
