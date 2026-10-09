import { createTestHarness, startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createToolPolicyPlugin } from '@ax/tool-policy';
import { createDecisionsPlugin } from '@ax/decisions';
import { createAgentsPlugin } from '@ax/agents';
import { bootstrap, makeAgentContext, type AgentContext, type HookBus, type ToolDescriptor, PluginError } from '@ax/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import type { HttpRegisterRouteInput } from '@ax/http-server';
import { createRoutinesPlugin } from '../../plugin.js';
import { createRoutinesStore } from '../../store.js';
import type { RoutinesDatabase } from '../../migrations.js';
import { drainRoutineCleanup } from '../../cleanup.js';
export type RoutineHarness = {
  routes: HttpRegisterRouteInput[];
  shutdownRoutines(): Promise<void>;
  shutdownKernel(): Promise<void>;
  restart(): Promise<RoutineHarness>; setAttended(value: boolean): void; descriptors: ToolDescriptor[]; advance(ms: number): void; bus: HookBus; owner: AgentContext; teamAdmin: AgentContext; teamMember: AgentContext;
  agentId: string; teamAgentId: string; credentialCalls: Array<{ operation: string; ref: string }>;
  cleanupWarnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  failNextCredentialDelete(): void; drainCleanup(): Promise<void>; close(): Promise<void>;
  db: Kysely<RoutinesDatabase>; invokeCalls: string[]; setTeamFailure(mode: 'missing' | 'outage' | null): void; holdCredentialSet(): { started: Promise<void>; release(): void };
};
export async function createRoutineHarness(options: { authenticatedUserId?: string; shutdownTimeoutMs?: number; onShutdownError?: (name: string, error: unknown) => void; credentialTimeoutMs?: number; invokeTimeoutMs?: number; dispatch?: boolean;
  invoke?: (ctx: AgentContext, bus: HookBus) => Promise<unknown>;
  reuse?: { container: StartedPostgreSqlContainer; agentId: string; teamAgentId: string; clock: number } } = {}): Promise<RoutineHarness> {
  const container = options.reuse?.container ?? await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  let clock = options.reuse?.clock ?? Date.parse('2026-10-09T12:00:00Z');
  let attended = true;
  const descriptors: ToolDescriptor[] = [];
  const routes: HttpRegisterRouteInput[] = [];
  const credentialCalls: RoutineHarness['credentialCalls'] = [];
  const cleanupWarnings: RoutineHarness['cleanupWarnings'] = [];
  let failDelete = false;
  let teamFailure: 'missing' | 'outage' | null = null;
  const invokeCalls: string[] = [];
  let gate: Promise<void> | undefined;
  let started: (() => void) | undefined;
  const routinesPlugin = createRoutinesPlugin({ tickIntervalMs: 3_600_000 }, undefined, options.dispatch ? {
      dispatch: async accepted => {
        const runCtx = makeAgentContext({ userId: accepted.row.ownerUserId, agentId: accepted.row.agentId, sessionId: 'routine', reqId: accepted.reqId });
        await liveBus.call('agent:invoke', runCtx, {});
        await liveStore.finishDispatch({ dispatchId: accepted.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: accepted.row.promptBody, warning: null } });
        return { status: 'ok' };
      },
    } : {});
  const harness = await createTestHarness({
    services: {
      'connectors:live-ids': async (_ctx, raw) => ({ live: (raw as { connectorIds: string[] }).connectorIds }),
      'tool:register': async (_ctx, raw) => { descriptors.push(raw as ToolDescriptor); return { ok: true }; },
      'conversations:get-metadata': async () => ({ activeSessionId: attended ? 'live' : null, origin: attended ? 'web' : 'routine' }),
      'session:queue-work': async () => ({}),
      'teams:is-member': async (_ctx, raw) => {
        if (teamFailure) throw new PluginError({ plugin: 'teams', code: teamFailure === 'missing' ? 'no-service' : 'unavailable', message: 'Team lookup unavailable' });
        const { userId, teamId } = raw as { userId: string; teamId: string };
        return { member: teamId === 'team-1' && ['owner', 'admin', 'member'].includes(userId), role: userId === 'member' ? 'member' : 'admin' };
      },
      'auth:require-user': async ctx => { const userId = options.authenticatedUserId ?? ctx.userId; return { user: { id: userId, email: `${userId}@example.test`, displayName: userId, isAdmin: userId === 'admin', createdAt: new Date() } }; },
      'auth:get-user': async (_ctx, raw) => { const { userId } = raw as { userId: string }; return { id: userId, email: `${userId}@example.test`, displayName: userId, isAdmin: userId === 'admin' }; },
      'http:register-route': async (_ctx, raw) => { routes.push(raw as HttpRegisterRouteInput); return { unregister() {} }; },
      'conversations:find-or-create': async () => ({ conversation: { conversationId: 'conversation' }, created: true }),
      'conversations:create': async () => ({ conversationId: 'conversation' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'credentials:get': async () => 'test-secret',
      'credentials:delete': async (ctx, raw) => {
        credentialCalls.push({ operation: 'delete', ref: (raw as { ref: string }).ref });
        if (failDelete) {
          failDelete = false;
          // Capture only this deliberately failed job's expected diagnostic.
          // Unexpected warnings still use the production logger.
          const warn = ctx.logger.warn.bind(ctx.logger);
          ctx.logger.warn = (message, fields) => {
            if (message === 'routines_credential_cleanup_pending') cleanupWarnings.push({ message, fields });
            else warn(message, fields);
          };
          throw new Error('unavailable');
        }
      },
      'workspace:apply': async () => { throw new Error('Workspace storage is unavailable'); },
    },
  });
  const kernel = await bootstrap({ bus: harness.bus, config: {},
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    ...(options.onShutdownError === undefined ? {} : { onShutdownError: options.onShutdownError }),
    plugins: [{
      manifest: { name: '@test/credential-effects', version: '0.0.0', registers: ['credentials:set', 'test:credential-write', 'agent:invoke'], calls: [], subscribes: [] },
      async init({ bus }) {
        bus.registerService('agent:invoke', '@test/credential-effects', async ctx => {
          invokeCalls.push(ctx.reqId);
          if (options.invoke) return options.invoke(ctx, bus);
          await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
          return { kind: 'complete' };
        }, { timeoutMs: options.invokeTimeoutMs ?? 120_000 });
        bus.registerService('credentials:set', '@test/credential-effects', (ctx, raw) => bus.call('test:credential-write', ctx, raw));
        bus.registerService('test:credential-write', '@test/credential-effects', async (_ctx, raw) => {
          started?.(); await gate; credentialCalls.push({ operation: 'set', ref: (raw as { ref: string }).ref });
        }, { timeoutMs: options.credentialTimeoutMs ?? 120_000 });
      },
    }, createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }), createToolPolicyPlugin(), createAgentsPlugin(), createDecisionsPlugin({ now: () => new Date(clock), sweepIntervalMs: 0, attendanceFor: () => attended ? 'attended' : 'unattended' }), routinesPlugin],
  });
  const ctx = (userId: string) => makeAgentContext({ userId, agentId: 'test', sessionId: 'test' });
  const owner = ctx('owner'), teamAdmin = ctx('admin'), teamMember = ctx('member');
  async function create(team: boolean) {
    const result = await harness.bus.call<unknown, { agent: { id: string } }>('agents:create', owner, {
      actor: { userId: owner.userId, isAdmin: false }, input: { displayName: team ? 'Team' : 'Personal', model: 'anthropic/claude-opus-4-7', allowedTools: [], mcpConfigIds: [], visibility: team ? 'team' : 'personal', ...(team ? { teamId: 'team-1' } : {}) },
    }); return result.agent.id;
  }
  const agentId = options.reuse?.agentId ?? await create(false), teamAgentId = options.reuse?.teamAgentId ?? await create(true);
  const { db } = await harness.bus.call<unknown, { db: Kysely<RoutinesDatabase> }>('database:get-instance', owner, {});
  const liveBus = harness.bus; const liveStore = createRoutinesStore(db);
  return { routes, shutdownRoutines: async () => { await routinesPlugin.shutdown?.(); }, shutdownKernel: () => kernel.shutdown(), async restart() { await kernel.shutdown(); await harness.close(); return createRoutineHarness({ ...options, reuse: { container, agentId, teamAgentId, clock } }); }, setAttended(value) { attended = value; }, descriptors, advance(ms) { clock += ms; }, cleanupWarnings, invokeCalls, setTeamFailure(mode) { teamFailure = mode; }, bus: harness.bus, owner, teamAdmin, teamMember, agentId, teamAgentId, credentialCalls, db,
    failNextCredentialDelete() { failDelete = true; },
    holdCredentialSet() { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; }); return { started: entered, release }; },
    drainCleanup: () => drainRoutineCleanup({ bus: harness.bus, store: createRoutinesStore(db) }),
    async close() { await kernel.shutdown(); await harness.close(); await stopPostgresContainer(container); },
  };
}
