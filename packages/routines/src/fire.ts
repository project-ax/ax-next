import { makeAgentContext, PluginError, type HookBus } from '@ax/core';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import { renderTemplate } from './template.js';

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
}

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
    const reqId = makeReqId();
    const sessionId = `routine-${row.agentId}-${row.path}-${reqId}`;
    const baseCtx = makeAgentContext({
      reqId,
      sessionId,
      agentId: row.agentId,
      userId: row.authorUserId,
    });

    try {
      await deps.bus.call<
        { agentId: string; userId: string },
        { agent: { id: string; ownerId?: string; workspaceRef?: string | null } }
      >('agents:resolve', baseCtx, { agentId: row.agentId, userId: row.authorUserId });
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

    let conversationId: string;
    try {
      if (row.conversation === 'shared') {
        const out = await deps.bus.call<
          unknown,
          { conversation: { conversationId: string }; created: boolean }
        >('conversations:find-or-create', baseCtx, {
          userId: row.authorUserId,
          agentId: row.agentId,
          externalKey: row.path,
          fallback: { title: row.name, hidden: true },
        });
        conversationId = out.conversation.conversationId;
      } else {
        const conv = await deps.bus.call<
          unknown,
          { conversationId: string }
        >('conversations:create', baseCtx, {
          userId: row.authorUserId,
          agentId: row.agentId,
          title: `${row.name} @ ${new Date().toISOString()}`,
          hidden: true,
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
      userId: row.authorUserId,
      conversationId,
      // Mark this as a routine-originated (non-user) turn. Subscribers that
      // must not act on internally-generated turns key off ctx.source — notably
      // @ax/memory-strata, which skips its chat:end memory extraction so a
      // scheduled fire doesn't pollute the agent's memory. See AgentContext.source.
      source: 'routine',
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

    void deps.bus.call('agent:invoke', fireCtx, {
      message: { role: 'user', content: prompt },
    }).catch((err) => {
      const pf = deps.pending.get(reqId);
      if (pf !== undefined) {
        deps.pending.delete(reqId);
        process.stderr.write(
          `[ax/routines] agent:invoke failed for ${row.agentId}/${row.path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

    return { status: 'ok', conversationId, error: null, renderedPrompt: prompt };
  };
}
