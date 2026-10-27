import { createHash } from 'node:crypto';
import { createTestHarness, startTestContainer, stopPostgresContainer } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createToolPolicyPlugin } from '@ax/tool-policy';
import { createDecisionsPlugin } from '@ax/decisions';
import { createAgentsPlugin } from '@ax/agents';
import { registerBlobPutFacade, bootstrap, makeAgentContext, type AgentContext, type HookBus, type ToolDescriptor, PluginError } from '@ax/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Kysely } from 'kysely';
import type { HttpRegisterRouteInput } from '@ax/http-server';
import { createRoutinesPlugin } from '../../plugin.js';
import { createRoutinesStore } from '../../store.js';
import type { RoutinesDatabase } from '../../migrations.js';
import { drainRoutineCleanup } from '../../cleanup.js';
import { systemClock, type Clock } from '../../clock.js';
export type RoutineHarness = {
  routes: HttpRegisterRouteInput[];
  shutdownRoutines(): Promise<void>;
  shutdownKernel(): Promise<void>;
  restart(): Promise<RoutineHarness>; setAttended(value: boolean): void; descriptors: ToolDescriptor[]; advance(ms: number): void; bus: HookBus; owner: AgentContext; teamAdmin: AgentContext; teamMember: AgentContext;
  agentId: string; teamAgentId: string; credentialCalls: Array<{ operation: string; ref: string }>;
  cleanupWarnings: Array<{ message: string; fields: Record<string, unknown> | undefined }>;
  failNextCredentialDelete(): void; drainCleanup(): Promise<void>; close(): Promise<void>;
  db: Kysely<RoutinesDatabase>; invokeCalls: string[]; setTeamFailure(mode: 'missing' | 'outage' | null): void; setTeamRole(userId: string, role: 'admin' | 'member' | null): void; holdCredentialSet(): { started: Promise<void>; release(): void };
};

/** Materialize the seeded defaults for the harness agents, as a later tick would. */
export async function materializePersonalDefaults(harness: RoutineHarness): Promise<void> {
  const { agents } = await harness.bus.call<unknown, { agents: Array<{ agentId: string; ownerUserId: string }> }>(
    'agents:list-personal-owners', harness.owner, {},
  );
  await createRoutinesStore(harness.db).materializeMissing({ agents, now: new Date('2026-10-09T12:00:00Z') });
}

export async function createRoutineHarness(options: { clock?: Clock; strictCredentials?: boolean; authenticatedUserId?: string; shutdownTimeoutMs?: number; onShutdownError?: (name: string, error: unknown) => void; credentialTimeoutMs?: number; invokeTimeoutMs?: number; dispatch?: boolean;
  /** Stands in for agent:invoke. `input` is what the caller sent: fire.ts sends the run's user message (TASK-908). */
  invoke?: (ctx: AgentContext, bus: HookBus, input: unknown) => Promise<unknown>;
  reuse?: { container: StartedPostgreSqlContainer; agentId: string; teamAgentId: string; clock: number; secrets?: Map<string, Uint8Array>; blobs?: Map<string, Uint8Array> } } = {}): Promise<RoutineHarness> {
  const container = options.reuse?.container ?? await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  let clock = options.reuse?.clock ?? Date.parse('2026-10-09T12:00:00Z');
  let attended = true;
  // The fixture vault, like production credentials, survives a host restart.
  const secrets = options.reuse?.secrets ?? new Map<string, Uint8Array>();
  const blobs = options.reuse?.blobs ?? new Map<string,Uint8Array>();
  const descriptors: ToolDescriptor[] = [];
  const routes: HttpRegisterRouteInput[] = [];
  const credentialCalls: RoutineHarness['credentialCalls'] = [];
  const cleanupWarnings: RoutineHarness['cleanupWarnings'] = [];
  let failDelete = false;
  let teamFailure: 'missing' | 'outage' | null = null;
  const teamRoles = new Map<string, 'admin' | 'member'>([['owner', 'admin'], ['admin', 'admin'], ['member', 'member'], ['peer', 'member'], ['team-admin', 'admin']]);
  const invokeCalls: string[] = [];
  let gate: Promise<void> | undefined;
  let started: (() => void) | undefined;
  // The tick loop starts at plugin init and its first pass (materialize,
  // reconcile owners, claim, drain cleanup) runs in the background. Left alone
  // it lands at a load-dependent point inside the test; the loop sleeps right
  // after each pass, so the first sleep marks the first pass as finished.
  const baseClock = options.clock ?? systemClock;
  let firstTickDone!: () => void;
  const firstTick = new Promise<void>(resolve => { firstTickDone = resolve; });
  const tickClock: Clock = { now: () => baseClock.now(), sleep: (ms, signal) => { firstTickDone(); return baseClock.sleep(ms, signal); } };
  const routinesPlugin = createRoutinesPlugin({ tickIntervalMs: 3_600_000 }, tickClock, options.dispatch ? {
      dispatch: async accepted => {
        const runCtx = makeAgentContext({ userId: accepted.row.ownerUserId, agentId: accepted.row.agentId, sessionId: 'routine', reqId: accepted.reqId });
        await liveBus.call('agent:invoke', runCtx, {});
        await liveStore.finishDispatch({ dispatchId: accepted.dispatchId, outcome: { status: 'ok', conversationId: null, error: null, renderedPrompt: accepted.row.promptBody, warning: null } });
        return { status: 'ok' };
      },
    } : {});
  const harness = await createTestHarness({
    services: {
      'blob:get': async (_ctx,raw) => { const bytes=blobs.get((raw as {sha256:string}).sha256); return bytes ? {bytes}:{found:false}; },
      'blob:put-internal': async (_ctx,raw) => { const bytes=(raw as {bytes:Uint8Array}).bytes; const sha256=createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256,bytes); return {sha256,size:bytes.length}; },
      'connectors:live-ids': async (_ctx, raw) => ({ live: (raw as { connectorIds: string[] }).connectorIds }),
      'tool:register': async (_ctx, raw) => { descriptors.push(raw as ToolDescriptor); return { ok: true }; },
      'conversations:get-metadata': async () => ({ activeSessionId: attended ? 'live' : null, origin: attended ? 'web' : 'routine' }),
      'session:queue-work': async () => ({}),
      'teams:is-member': async (_ctx, raw) => {
        if (teamFailure) throw new PluginError({ plugin: 'teams', code: teamFailure === 'missing' ? 'no-service' : 'unavailable', message: 'Team lookup unavailable' });
        const { userId, teamId } = raw as { userId: string; teamId: string };
        const role = teamId === 'team-1' ? teamRoles.get(userId) : undefined;
        return { member: role !== undefined, ...(role === undefined ? {} : { role }) };
      },
      'auth:require-user': async ctx => { const userId = options.authenticatedUserId ?? ctx.userId; return { user: { id: userId, email: `${userId}@example.test`, displayName: userId, isAdmin: userId === 'admin', createdAt: new Date() } }; },
      'auth:get-user': async (_ctx, raw) => { const { userId } = raw as { userId: string }; return { id: userId, email: `${userId}@example.test`, displayName: userId, isAdmin: userId === 'admin' }; },
      'http:register-route': async (_ctx, raw) => { routes.push(raw as HttpRegisterRouteInput); return { unregister() {} }; },
      'conversations:find-or-create': async () => ({ conversation: { conversationId: 'conversation' }, created: true }),
      'conversations:create': async () => ({ conversationId: 'conversation' }),
      'conversations:drop-turn': async () => undefined,
      'conversations:hide': async () => undefined,
      'credentials:get': async (_ctx, raw) => {
        const value = secrets.get((raw as { ref: string }).ref);
        if (value) return Buffer.from(value).toString('utf8');
        if (options.strictCredentials) throw new Error('Credential not found');
        return 'test-secret';
      },
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
        secrets.delete((raw as { ref: string }).ref);
      },
      'workspace:apply': async () => { throw new Error('Workspace storage is unavailable'); },
    },
  });
  const kernel = await bootstrap({ bus: harness.bus, config: {},
    ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    ...(options.onShutdownError === undefined ? {} : { onShutdownError: options.onShutdownError }),
    plugins: [{manifest:{name:'test-blob-facade',version:'0.0.0',registers:['blob:put'],calls:['blob:put-internal'],subscribes:[]},async init({bus}){registerBlobPutFacade(bus,'test-blob-facade');}}, {
      manifest: { name: '@test/credential-effects', version: '0.0.0', registers: ['credentials:set', 'test:credential-write', 'agent:invoke'], calls: [], subscribes: [] },
      async init({ bus }) {
        bus.registerService('agent:invoke', '@test/credential-effects', async (ctx, input) => {
          invokeCalls.push(ctx.reqId);
          if (options.invoke) return options.invoke(ctx, bus, input);
          await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] });
          return { kind: 'complete' };
        }, { timeoutMs: options.invokeTimeoutMs ?? 120_000 });
        bus.registerService('credentials:set', '@test/credential-effects', (ctx, raw) => bus.call('test:credential-write', ctx, raw));
        bus.registerService('test:credential-write', '@test/credential-effects', async (_ctx, raw) => {
          started?.(); await gate; credentialCalls.push({ operation: 'set', ref: (raw as { ref: string }).ref });
          const input = raw as { ref: string; payload: Uint8Array };
          secrets.set(input.ref, input.payload);
        }, { timeoutMs: options.credentialTimeoutMs ?? 120_000 });
      },
    }, createDatabasePostgresPlugin({ connectionString: container.getConnectionUri() }), createToolPolicyPlugin(), createAgentsPlugin(), createDecisionsPlugin({ now: () => new Date(clock), sweepIntervalMs: 0, attendanceFor: () => attended ? 'attended' : 'unattended' }), routinesPlugin],
  });
  await firstTick;
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
  return { routes, shutdownRoutines: async () => { await routinesPlugin.shutdown?.(); }, shutdownKernel: () => kernel.shutdown(), async restart() { await kernel.shutdown(); await harness.close(); return createRoutineHarness({ ...options, reuse: { container, agentId, teamAgentId, clock, secrets, blobs } }); }, setAttended(value) { attended = value; }, descriptors, advance(ms) { clock += ms; }, cleanupWarnings, invokeCalls, setTeamFailure(mode) { teamFailure = mode; }, setTeamRole(userId, role) { if (role === null) teamRoles.delete(userId); else teamRoles.set(userId, role); }, bus: harness.bus, owner, teamAdmin, teamMember, agentId, teamAgentId, credentialCalls, db,
    failNextCredentialDelete() { failDelete = true; },
    holdCredentialSet() { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; }); return { started: entered, release }; },
    drainCleanup: () => drainRoutineCleanup({ bus: harness.bus, store: createRoutinesStore(db) }),
    async close() { await kernel.shutdown(); await harness.close(); await stopPostgresContainer(container); },
  };
}
