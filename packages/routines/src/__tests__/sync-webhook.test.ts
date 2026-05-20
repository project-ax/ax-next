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
}, 60_000);

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
  ensures: number;
}

function makeBus(opts: {
  initialToken?: string | null;
  captured: Captured;
}): HookBus {
  const bus = new HookBus();
  let token = opts.initialToken ?? null;
  bus.registerService('agents:ensure-webhook-token', 'test', async () => {
    opts.captured.ensures += 1;
    if (typeof token !== 'string' || token.length === 0) {
      token = `tok-${opts.captured.ensures}`;
    }
    return { token };
  });
  bus.registerService('http:register-route', 'test', async (_ctx, input: unknown) => {
    const i = input as { path: string };
    opts.captured.routes.push({ path: i.path });
    return { unregister: () => { opts.captured.unregisters.push(i.path); } };
  });
  return bus;
}

const noopFire = async () => ({
  status: 'ok' as const, conversationId: 'c1', error: null, renderedPrompt: 'p',
});

function ctx(): AgentContext {
  return makeAgentContext({ sessionId: 's', agentId: 'agt_a', userId: 'u1' });
}

describe('handleWorkspaceApplied — webhook arm', () => {
  it('registers a route on first webhook routine add (lazy token via ensure)', async () => {
    const captured: Captured = { routes: [], unregisters: [], ensures: 0 };
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
    expect(captured.ensures).toBe(1);
    expect(captured.routes).toEqual([{ path: '/webhooks/tok-1/r/x' }]);
    expect(webhookRoutes.size).toBe(1);
  });

  it('calls agents:ensure-webhook-token (not rotate) when agent already has one', async () => {
    const captured: Captured = { routes: [], unregisters: [], ensures: 0 };
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
    // ensure is called (idempotent — returns existing token, doesn't rotate).
    expect(captured.ensures).toBe(1);
    expect(captured.routes).toEqual([{ path: '/webhooks/existing/r/x' }]);
  });

  it('unregisters and removes the closure on deleted', async () => {
    const captured: Captured = { routes: [], unregisters: [], ensures: 0 };
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
    const captured: Captured = { routes: [], unregisters: [], ensures: 0 };
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
    const captured: Captured = { routes: [], unregisters: [], ensures: 0 };
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
    bus.registerService('agents:ensure-webhook-token', 'test', async () => ({
      token: 'tok',
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

describe('rebindWebhooksForAgent — Finding #5 rotation re-bind', () => {
  it('unregisters old closure and registers new route with updated token', async () => {
    const { rebindWebhooksForAgent: rebind } = await import('../sync.js');
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();

    // Seed a webhook routine in the store.
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/r.md', authorUserId: 'u1',
      name: 'r', description: 'd', specHash: 'h1',
      trigger: { kind: 'webhook', path: '/r/x' },
      activeHours: null, silenceToken: null, silenceMax: 0,
      conversation: 'per-fire', promptBody: 'hi', nextRunAt: null,
    });

    const unregisteredPaths: string[] = [];
    const registeredPaths: string[] = [];
    let currentToken = 'old-token';

    // Stash the old closure.
    webhookRoutes.set('agt_a::.ax/routines/r.md', () => {
      unregisteredPaths.push('/webhooks/old-token/r/x');
    });

    const bus = new HookBus();
    bus.registerService('agents:ensure-webhook-token', 'test', async () => ({
      token: currentToken,
    }));
    bus.registerService('http:register-route', 'test', async (_ctx, input: unknown) => {
      const i = input as { path: string };
      registeredPaths.push(i.path);
      return { unregister: () => {} };
    });

    // Simulate rotation: token changed.
    currentToken = 'new-token';
    await rebind({ store, bus, webhookRoutes, fireRoutine: noopFire }, ctx(), 'agt_a');

    expect(unregisteredPaths).toEqual(['/webhooks/old-token/r/x']);
    expect(registeredPaths).toEqual(['/webhooks/new-token/r/x']);
    expect(webhookRoutes.has('agt_a::.ax/routines/r.md')).toBe(true);
  });

  it('skips non-webhook routines during rebind', async () => {
    const { rebindWebhooksForAgent: rebind } = await import('../sync.js');
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();

    // Seed an interval routine — should be skipped.
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/cron.md', authorUserId: 'u1',
      name: 'c', description: 'd', specHash: 'h2',
      trigger: { kind: 'interval', every: '60s' },
      activeHours: null, silenceToken: null, silenceMax: 0,
      conversation: 'per-fire', promptBody: 'tick', nextRunAt: null,
    });

    const registeredPaths: string[] = [];
    const bus = new HookBus();
    bus.registerService('agents:ensure-webhook-token', 'test', async () => ({ token: 'tok' }));
    bus.registerService('http:register-route', 'test', async (_ctx, input: unknown) => {
      registeredPaths.push((input as { path: string }).path);
      return { unregister: () => {} };
    });

    await rebind({ store, bus, webhookRoutes, fireRoutine: noopFire }, ctx(), 'agt_a');
    expect(registeredPaths).toHaveLength(0);
  });

  it('K10: per-routine failure does not abort remaining rebinds', async () => {
    const { rebindWebhooksForAgent: rebind } = await import('../sync.js');
    const store = createRoutinesStore(db);
    const webhookRoutes = new Map<string, () => void>();

    // Two webhook routines.
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/a.md', authorUserId: 'u1',
      name: 'a', description: 'd', specHash: 'ha',
      trigger: { kind: 'webhook', path: '/r/a' },
      activeHours: null, silenceToken: null, silenceMax: 0,
      conversation: 'per-fire', promptBody: 'hi', nextRunAt: null,
    });
    await store.upsert({
      agentId: 'agt_a', path: '.ax/routines/b.md', authorUserId: 'u1',
      name: 'b', description: 'd', specHash: 'hb',
      trigger: { kind: 'webhook', path: '/r/b' },
      activeHours: null, silenceToken: null, silenceMax: 0,
      conversation: 'per-fire', promptBody: 'hi', nextRunAt: null,
    });

    const registeredPaths: string[] = [];
    let callCount = 0;
    const bus = new HookBus();
    bus.registerService('agents:ensure-webhook-token', 'test', async () => ({ token: 'tok' }));
    bus.registerService('http:register-route', 'test', async (_ctx, input: unknown) => {
      callCount++;
      if (callCount === 1) throw new Error('first fails');
      registeredPaths.push((input as { path: string }).path);
      return { unregister: () => {} };
    });

    // Should not throw.
    await expect(
      rebind({ store, bus, webhookRoutes, fireRoutine: noopFire }, ctx(), 'agt_a'),
    ).resolves.toBeUndefined();

    // Second routine still registered.
    expect(registeredPaths).toHaveLength(1);
  });
});
