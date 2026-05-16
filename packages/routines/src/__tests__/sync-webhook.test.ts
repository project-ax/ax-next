import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HookBus, makeAgentContext, type AgentContext } from '@ax/core';
import { runRoutinesMigration, type RoutinesDatabase } from '../migrations.js';
import { createRoutinesStore } from '../store.js';
import { handleWorkspaceApplied } from '../sync.js';

pg.types.setTypeParser(20, (v) => Number(v));

let container: StartedPostgreSqlContainer;
let db: Kysely<RoutinesDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<RoutinesDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runRoutinesMigration(db);
}, 120_000);

afterEach(async () => {
  await sql`TRUNCATE routines_v1_definitions, routines_v1_fires`.execute(db);
});

afterAll(async () => {
  await db.destroy();
  if (container) await container.stop();
});

const ENC = new TextEncoder();

function webhookFile(over: { events?: string[]; secretRef?: string } = {}): Uint8Array {
  const lines = [
    '---', 'name: r', 'description: d',
    'trigger:', '  kind: webhook', '  path: "/r/x"',
  ];
  if (over.events) lines.push(`  events: ${JSON.stringify(over.events)}`);
  if (over.secretRef) {
    lines.push('  hmac:', `    secretRef: ${over.secretRef}`,
               '    header: "X-Sig"', '    algorithm: sha256');
  }
  lines.push('conversation: per-fire', '---', 'hi {{payload.foo}}');
  return ENC.encode(lines.join('\n') + '\n');
}

function intervalFile(): Uint8Array {
  return ENC.encode([
    '---', 'name: r', 'description: d',
    'trigger:', '  kind: interval', '  every: "60s"',
    'conversation: per-fire', '---', 'tick',
  ].join('\n') + '\n');
}

interface Captured {
  routes: Array<{ path: string }>;
  unregisters: string[];
  rotates: number;
  resolves: number;
}

function makeBus(opts: {
  initialToken?: string | null;
  captured: Captured;
}): HookBus {
  const bus = new HookBus();
  let token = opts.initialToken ?? null;
  bus.registerService('agents:resolve', 'test', async (_ctx, _input) => {
    opts.captured.resolves += 1;
    return { agent: { id: 'agt_a', ownerId: 'u1', webhookToken: token } };
  });
  bus.registerService('agents:rotate-webhook-token', 'test', async () => {
    opts.captured.rotates += 1;
    token = `tok-${opts.captured.rotates}`;
    return { token };
  });
  bus.registerService('http:register-route', 'test', async (_ctx, input: unknown) => {
    const i = input as { path: string };
    opts.captured.routes.push({ path: i.path });
    return { unregister: () => { opts.captured.unregisters.push(i.path); } };
  });
  return bus;
}

const noopFire = async () => ({ status: 'ok' as const, conversationId: 'c1', error: null });

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'agt_a', userId: 'u1' });
}

describe('handleWorkspaceApplied — webhook arm', () => {
  it('registers a route on first webhook routine add (lazy token)', async () => {
    const captured: Captured = { routes: [], unregisters: [], rotates: 0, resolves: 0 };
    const bus = makeBus({ initialToken: null, captured });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added',
          contentAfter: async () => webhookFile() }],
      },
      new Date(),
    );
    expect(captured.rotates).toBe(1);
    expect(captured.routes).toEqual([{ path: '/webhooks/tok-1/r/x' }]);
    expect(webhookRoutes.size).toBe(1);
  });

  it('does not call agents:rotate-webhook-token when agent already has one', async () => {
    const captured: Captured = { routes: [], unregisters: [], rotates: 0, resolves: 0 };
    const bus = makeBus({ initialToken: 'existing', captured });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added',
          contentAfter: async () => webhookFile() }],
      },
      new Date(),
    );
    expect(captured.rotates).toBe(0);
    expect(captured.routes).toEqual([{ path: '/webhooks/existing/r/x' }]);
  });

  it('unregisters and removes the closure on deleted', async () => {
    const captured: Captured = { routes: [], unregisters: [], rotates: 0, resolves: 0 };
    const bus = makeBus({ initialToken: 'tok', captured });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    // Add first
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added',
          contentAfter: async () => webhookFile() }],
      },
      new Date(),
    );
    expect(webhookRoutes.size).toBe(1);
    // Then delete
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        after: 'v2' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'deleted' }],
      },
      new Date(),
    );
    expect(captured.unregisters).toEqual(['/webhooks/tok/r/x']);
    expect(webhookRoutes.size).toBe(0);
  });

  it('skips re-registration on no-op apply (spec_hash unchanged) — K6', async () => {
    const captured: Captured = { routes: [], unregisters: [], rotates: 0, resolves: 0 };
    const bus = makeBus({ initialToken: 'tok', captured });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    const content = webhookFile();
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added' as const,
          contentAfter: async () => content }],
      },
      new Date(),
    );
    // Re-apply identical bytes (modified kind but same content → same specHash)
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        after: 'v2' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'modified' as const,
          contentAfter: async () => content }],
      },
      new Date(),
    );
    expect(captured.routes).toHaveLength(1);
    expect(captured.unregisters).toHaveLength(0);
  });

  it('drops stale closure when routine transitions webhook -> interval', async () => {
    const captured: Captured = { routes: [], unregisters: [], rotates: 0, resolves: 0 };
    const bus = makeBus({ initialToken: 'tok', captured });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    // Add webhook
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added',
          contentAfter: async () => webhookFile() }],
      },
      new Date(),
    );
    // Transition to interval
    await handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        after: 'v2' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'modified',
          contentAfter: async () => intervalFile() }],
      },
      new Date(),
    );
    expect(captured.unregisters).toEqual(['/webhooks/tok/r/x']);
    expect(webhookRoutes.size).toBe(0);
  });

  it('K10: continues when http:register-route throws — does not wedge', async () => {
    const bus = new HookBus();
    bus.registerService('agents:resolve', 'test', async () => ({
      agent: { id: 'agt_a', ownerId: 'u1', webhookToken: 'tok' },
    }));
    bus.registerService('agents:rotate-webhook-token', 'test', async () => ({
      token: 'rot',
    }));
    bus.registerService('http:register-route', 'test', async () => {
      throw new Error('boom');
    });
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();
    // Should not throw out of handleWorkspaceApplied
    await expect(handleWorkspaceApplied(
      { store, bus, webhookRoutes, fireRoutine: noopFire },
      ctx(),
      {
        before: null, after: 'v1' as unknown as ReturnType<typeof import('@ax/core').asWorkspaceVersion>,
        author: { agentId: 'agt_a', userId: 'u1' },
        changes: [{ path: '.ax/routines/r.md', kind: 'added',
          contentAfter: async () => webhookFile() }],
      },
      new Date(),
    )).resolves.toBeUndefined();
    expect(webhookRoutes.size).toBe(0);
    // store.findOne should still find the routine — index path ran even though bind failed
    const row = await store.findOne({ agentId: 'agt_a', path: '.ax/routines/r.md' });
    expect(row).not.toBeNull();
    // last_status should be 'error'
    expect(row!.lastStatus).toBe('error');
  });
});
