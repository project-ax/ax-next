import { createTestHarness, startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '@ax/agents';
import { makeAgentContext, type AgentContext, type HookBus, PluginError } from '@ax/core';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import { createRoutinesPlugin } from '../../plugin.js';
import { createRoutinesStore } from '../../store.js';
import type { RoutinesDatabase } from '../../migrations.js';
import { drainRoutineCleanup } from '../../cleanup.js';
export type RoutineHarness = {
  bus: HookBus; owner: AgentContext; teamAdmin: AgentContext; teamMember: AgentContext;
  agentId: string; teamAgentId: string; credentialCalls: Array<{ operation: string; ref: string }>;
  failNextCredentialDelete(): void; drainCleanup(): Promise<void>; close(): Promise<void>;
  db: Kysely<RoutinesDatabase>; invokeCalls: string[]; setTeamFailure(mode: 'missing' | 'outage' | null): void; holdCredentialSet(): { started: Promise<void>; release(): void };
};
export async function createRoutineHarness(options: { credentialTimeoutMs?: number; dispatch?: boolean } = {}): Promise<RoutineHarness> {
  const container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  const credentialCalls: RoutineHarness['credentialCalls'] = [];
  let failDelete = false;
  let teamFailure: 'missing' | 'outage' | null = null;
  const invokeCalls: string[] = [];
  let gate: Promise<void> | undefined;
  let started: (() => void) | undefined;
  const harness = await createTestHarness({
    services: {
      'teams:is-member': async (_ctx, raw) => {
        if (teamFailure) throw new PluginError({ plugin: 'teams', code: teamFailure === 'missing' ? 'no-service' : 'unavailable', message: 'Team lookup unavailable' });
        const { userId, teamId } = raw as { userId: string; teamId: string };
        return { member: teamId === 'team-1' && ['owner', 'admin', 'member'].includes(userId), role: userId === 'member' ? 'member' : 'admin' };
      },
      'auth:require-user': async ctx => ({ user: { id: ctx.userId, email: `${ctx.userId}@example.test`, displayName: ctx.userId, isAdmin: ctx.userId === 'admin', createdAt: new Date() } }),
      'auth:get-user': async (_ctx, raw) => { const { userId } = raw as { userId: string }; return { id: userId, email: `${userId}@example.test`, displayName: userId, isAdmin: userId === 'admin' }; },
      'http:register-route': async () => ({ unregister() {} }),
      'conversations:find-or-create': async () => ({ conversation: { conversationId: 'conversation' }, created: true }),
      'conversations:create': async () => ({ conversationId: 'conversation' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'agent:invoke': async ctx => { invokeCalls.push(ctx.reqId); return { kind: 'complete', messages: [] }; },
      'credentials:get': async () => 'test-secret',
      'credentials:delete': async (_ctx, raw) => {
        credentialCalls.push({ operation: 'delete', ref: (raw as { ref: string }).ref });
        if (failDelete) { failDelete = false; throw new Error('unavailable'); }
      },
      'workspace:apply': async () => { throw new Error('Workspace storage is unavailable'); },
    },
    plugins: [{
      manifest: { name: '@test/credential-effects', version: '0.0.0', registers: ['credentials:set', 'test:credential-write'], calls: [], subscribes: [] },
      async init({ bus }) {
        bus.registerService('credentials:set', '@test/credential-effects', (ctx, raw) => bus.call('test:credential-write', ctx, raw));
        bus.registerService('test:credential-write', '@test/credential-effects', async (_ctx, raw) => {
          started?.(); await gate; credentialCalls.push({ operation: 'set', ref: (raw as { ref: string }).ref });
        }, { timeoutMs: options.credentialTimeoutMs ?? 120_000 });
      },
    }, createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }), createAgentsPlugin(), createRoutinesPlugin({ tickIntervalMs: 3_600_000 }, undefined, options.dispatch ? {
      dispatch: async accepted => {
        const runCtx = makeAgentContext({ userId: accepted.row.ownerUserId, agentId: accepted.row.agentId, sessionId: 'routine', reqId: accepted.reqId });
        await liveBus.call('agent:invoke', runCtx, {});
        await liveStore.finishDispatch({ dispatchId: accepted.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: accepted.row.promptBody, warning: null } });
        return { status: 'ok' };
      },
    } : {})],
  });
  const ctx = (userId: string) => makeAgentContext({ userId, agentId: 'test', sessionId: 'test' });
  const owner = ctx('owner'), teamAdmin = ctx('admin'), teamMember = ctx('member');
  async function create(team: boolean) {
    const result = await harness.bus.call<unknown, { agent: { id: string } }>('agents:create', owner, {
      actor: { userId: owner.userId, isAdmin: false }, input: { displayName: team ? 'Team' : 'Personal', model: 'anthropic/claude-opus-4-7', allowedTools: [], mcpConfigIds: [], visibility: team ? 'team' : 'personal', ...(team ? { teamId: 'team-1' } : {}) },
    }); return result.agent.id;
  }
  const agentId = await create(false), teamAgentId = await create(true);
  const { db } = await harness.bus.call<unknown, { db: Kysely<RoutinesDatabase> }>('database:get-instance', owner, {});
  const liveBus = harness.bus; const liveStore = createRoutinesStore(db);
  return { invokeCalls, setTeamFailure(mode) { teamFailure = mode; }, bus: harness.bus, owner, teamAdmin, teamMember, agentId, teamAgentId, credentialCalls, db,
    failNextCredentialDelete() { failDelete = true; },
    holdCredentialSet() { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; }); return { started: entered, release }; },
    drainCleanup: () => drainRoutineCleanup({ bus: harness.bus, store: createRoutinesStore(db) }),
    async close() { await harness.close(); await stopPostgresContainer(container); },
  };
}
