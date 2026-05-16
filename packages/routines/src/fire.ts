import { makeAgentContext, PluginError, type HookBus } from '@ax/core';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import { renderTemplate } from './template.js';

export interface PendingFire {
  row: RoutineRow;
  conversationId: string;
  source: FireSource;
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
    const baseCtx = makeAgentContext({
      sessionId: `routine-${row.agentId}-${row.path}`,
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
        return { status: 'error', error: `${err.code}: ${err.message}`, conversationId: null };
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
          fallback: { title: row.name },
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
        });
        conversationId = conv.conversationId;
      }
    } catch (err) {
      if (err instanceof PluginError) {
        return { status: 'error', error: `${err.code}: ${err.message}`, conversationId: null };
      }
      throw err;
    }

    const reqId = makeReqId();
    const fireCtx = makeAgentContext({
      reqId,
      sessionId: baseCtx.sessionId,
      agentId: row.agentId,
      userId: row.authorUserId,
      conversationId,
    });

    deps.pending.set(reqId, {
      row, conversationId, source,
      onTurnEnd: async () => {},
    });

    const prompt =
      source === 'webhook' && payload !== undefined
        ? renderTemplate(row.promptBody, { payload })
        : row.promptBody;

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

    return { status: 'ok', conversationId, error: null };
  };
}
