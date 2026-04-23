import type { ChatContext, ChatOutcome, Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/audit-log';

export function auditLogPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['storage:set'],
      subscribes: ['chat:end'],
    },
    init({ bus }) {
      bus.subscribe<{ outcome: ChatOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx: ChatContext, payload) => {
          const record = {
            reqId: ctx.reqId,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            userId: ctx.userId,
            outcome: payload.outcome,
            timestamp: new Date().toISOString(),
          };
          const value = new TextEncoder().encode(JSON.stringify(record));
          await bus.call('storage:set', ctx, { key: `chat:${ctx.reqId}`, value });
          return undefined;
        },
      );
    },
  };
}
