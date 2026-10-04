import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  answerBlobCollectRefs,
  BLOB_COLLECT_REFS_HOOK,
  HookBus,
  makeAgentContext,
  type AgentContext,
  type ServiceHandler,
} from '@ax/core';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createDiskQuotaPlugin } from '../plugin.js';
import {
  blobFullMessage,
  STORAGE_UNAVAILABLE_MESSAGE,
  workspaceFullMessage,
} from '../messages.js';
import { bootDiskQuota, MB, truncateDiskQuotaTables, type Booted } from './helpers.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: Booted[] = [];

async function boot(
  services: Record<string, ServiceHandler> = {},
  config: Parameters<typeof bootDiskQuota>[0]['config'] = {},
): Promise<Booted> {
  const b = await bootDiskQuota({ connectionString, services, config });
  booted.push(b);
  return b;
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (booted.length > 0) await booted.pop()!.harness.close({ onError: () => {} });
  await truncateDiskQuotaTables(connectionString);
});

afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

const sha = (c: string) => c.repeat(64);

const blobStored = (b: Booted, ctx: AgentContext, size: number, c = 'a') =>
  b.harness.bus.fire('blob:stored', ctx, { sha256: sha(c), size });
const blobPrePut = (b: Booted, ctx: AgentContext, size: number) =>
  b.harness.bus.fire('blob:pre-put', ctx, { size });
const preApply = (b: Booted, ctx: AgentContext, sizeBytes?: unknown) =>
  b.harness.bus.fire('workspace:pre-apply', ctx, {
    changes: [],
    parent: null,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  });
const applied = (b: Booted, ctx: AgentContext) =>
  b.harness.bus.fire('workspace:applied', ctx, { delta: 'ignored' });

async function setLimitMb(b: Booted, limitMb: number): Promise<void> {
  expect((await b.request('PUT', '/admin/storage/limits', { body: { limitMb } })).status).toBe(200);
}

async function mine(b: Booted, userId: string) {
  b.setAuth({ id: userId, isAdmin: false });
  const r = await b.request('GET', '/settings/storage');
  expect(r.status).toBe(200);
  return r.json as {
    usedBytes: number;
    workspaceBytes: number;
    fileBytes: number;
    limitBytes: number;
    status: string;
  };
}

async function dbOf(b: Booted): Promise<Kysely<unknown>> {
  const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
    'database:get-instance',
    b.harness.ctx(),
    {},
  );
  return db;
}

describe('manifest', () => {
  it('subscribes to the two write gates + two meters + the chat:start front door + workspace:deleted, registers nothing, declares its calls', () => {
    const m = createDiskQuotaPlugin().manifest;
    expect(m.name).toBe('@ax/disk-quota');
    expect(m.version).toBe('0.0.0');
    expect(m.registers).toEqual([]);
    expect(m.subscribes).toEqual([
      'workspace:pre-apply',
      'workspace:applied',
      'blob:pre-put',
      'blob:stored',
      'chat:start',
      'workspace:deleted',
    ]);
    expect(m.calls).toEqual([
      'database:get-instance',
      'storage:get',
      'storage:set',
      'http:register-route',
      'auth:require-user',
    ]);
    expect(m.optionalCalls?.map((c) => c.hook)).toEqual([
      'workspace:usage',
      'agents:resolve',
      'agents:list-personal-owners',
      'auth:get-user',
    ]);
    for (const c of m.optionalCalls ?? []) expect(c.degradation.length).toBeGreaterThan(20);
  });
});

describe('the blob:pre-put gate, end to end through the bus', () => {
  it('passes the payload through when under the limit', async () => {
    const b = await boot();
    const ctx = b.harness.ctx({ userId: 'alice' });
    expect(await blobPrePut(b, ctx, 5 * MB)).toEqual({ rejected: false, payload: { size: 5 * MB } });
  });

  it('refuses once stored bytes would cross the limit; another user is unaffected', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice' });
    const bob = b.harness.ctx({ userId: 'bob' });
    await blobStored(b, alice, 60 * MB);

    expect(await blobPrePut(b, alice, 5 * MB)).toMatchObject({
      rejected: true,
      reason: blobFullMessage(60 * MB, 64 * MB),
      source: '@ax/disk-quota',
    });
    // Exactly the limit is fine; one byte past is not.
    expect((await blobPrePut(b, alice, 4 * MB)).rejected).toBe(false);
    expect((await blobPrePut(b, alice, 4 * MB + 1)).rejected).toBe(true);
    // Bob has stored nothing.
    expect((await blobPrePut(b, bob, 64 * MB)).rejected).toBe(false);
  });

  it('blob:stored is what fills the ledger: the same sha counts once, two owners each count', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice' });
    const bob = b.harness.ctx({ userId: 'bob' });
    await blobStored(b, alice, 30 * MB, 'a');
    await blobStored(b, alice, 30 * MB, 'a');
    await blobStored(b, alice, 30 * MB, 'a');
    await blobStored(b, bob, 30 * MB, 'a');
    expect((await mine(b, 'alice')).fileBytes).toBe(30 * MB);
    expect((await mine(b, 'bob')).fileBytes).toBe(30 * MB);
    await blobStored(b, alice, 30 * MB, 'b');
    expect((await mine(b, 'alice')).fileBytes).toBe(60 * MB);
  });

  it('does not attribute or refuse a context with no person behind it', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    for (const userId of ['system', 'init']) {
      const ctx = b.harness.ctx({ userId });
      expect((await blobPrePut(b, ctx, 100 * 1024 * MB)).rejected, userId).toBe(false);
      await blobStored(b, ctx, 100 * MB);
    }
    b.setAuth({ id: 'admin-1', isAdmin: true });
    const r = await b.request('GET', '/admin/storage');
    expect((r.json as { owners: unknown[] }).owners).toEqual([]);
  });

  it('FAILS CLOSED when the database is broken: refused with the "could not check" sentence', async () => {
    const b = await boot();
    await (await dbOf(b)).destroy();
    expect(await blobPrePut(b, b.harness.ctx({ userId: 'alice' }), 1)).toMatchObject({
      rejected: true,
      reason: STORAGE_UNAVAILABLE_MESSAGE,
    });
    // The meter swallows the same failure: the fire completes, nothing throws.
    const stored = await blobStored(b, b.harness.ctx({ userId: 'alice' }), 1);
    expect(stored.rejected).toBe(false);
  });
});

const chatStart = (b: Booted, ctx: AgentContext) =>
  b.harness.bus.fire('chat:start', ctx, { message: { role: 'user', content: 'hi' } });
const workspaceDeleted = (b: Booted, ctx: AgentContext, payload: unknown) =>
  b.harness.bus.fire('workspace:deleted', ctx, payload);

// The two write gates say WHY in a machine-readable code as well as in prose,
// so a caller that must react to "full" specifically (an HTTP status, say) does
// not have to match a sentence or the name of the plugin that said no.
describe('a refusal because storage is full carries the storage-full code', () => {
  it('on the blob:pre-put gate', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice' });
    await blobStored(b, alice, 60 * MB);
    expect(await blobPrePut(b, alice, 5 * MB)).toMatchObject({
      rejected: true,
      source: '@ax/disk-quota',
      code: 'storage-full',
    });
  });

  it('on the workspace:pre-apply gate', async () => {
    const b = await boot({ 'workspace:usage': (async () => ({ bytes: 60 * MB })) as ServiceHandler });
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await applied(b, alice);
    await b.plugin.drain();
    expect(await preApply(b, alice, 5 * MB)).toMatchObject({
      rejected: true,
      source: '@ax/disk-quota',
      code: 'storage-full',
    });
  });

  it('but NOT on the fail-closed "could not check" refusal, which is not the same thing', async () => {
    const b = await boot();
    await (await dbOf(b)).destroy();
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    const blob = await blobPrePut(b, alice, 1);
    const ws = await preApply(b, alice, 1);
    for (const r of [blob, ws]) {
      expect(r).toMatchObject({ rejected: true, reason: STORAGE_UNAVAILABLE_MESSAGE });
      expect('code' in r).toBe(false);
    }
  });
});

describe('the workspace:deleted subscriber, end to end through the bus', () => {
  const usageByAgent = (bytes: Record<string, number>): Record<string, ServiceHandler> => ({
    'workspace:usage': (async (ctx: AgentContext) => ({ bytes: bytes[ctx.agentId] ?? 0 })) as ServiceHandler,
  });

  it("drops that agent's workspace row and frees the owner's room; another agent's row stays", async () => {
    const b = await boot(usageByAgent({ agt_1: 40 * MB, agt_2: 10 * MB }));
    await setLimitMb(b, 64);
    const one = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    const two = b.harness.ctx({ userId: 'alice', agentId: 'agt_2' });
    await applied(b, one);
    await applied(b, two);
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(50 * MB);
    expect((await blobPrePut(b, one, 20 * MB)).rejected).toBe(true);

    // Whoever fires it (a system context, in real life) is not the owner.
    const result = await workspaceDeleted(b, b.harness.ctx({ userId: 'system' }), { agentId: 'agt_1' });
    expect(result.rejected).toBe(false);

    expect((await mine(b, 'alice')).workspaceBytes).toBe(10 * MB);
    expect((await blobPrePut(b, one, 20 * MB)).rejected).toBe(false);
  });

  it("drops a TEAM agent's row from the team, not from whoever fired the hook", async () => {
    const b = await boot({
      ...usageByAgent({ agt_team: 30 * MB }),
      'agents:resolve': (async () => ({ agent: { ownerId: 't1', ownerType: 'team' } })) as ServiceHandler,
    });
    await applied(b, b.harness.ctx({ userId: 'alice', agentId: 'agt_team' }));
    await b.plugin.drain();
    b.setAuth({ id: 'admin-1', isAdmin: true });
    expect(((await b.request('GET', '/admin/storage')).json as { owners: unknown[] }).owners).toEqual([
      expect.objectContaining({ ownerId: 'team:t1', workspaceBytes: 30 * MB }),
    ]);

    await workspaceDeleted(b, b.harness.ctx({ userId: 'system' }), { agentId: 'agt_team' });
    expect(((await b.request('GET', '/admin/storage')).json as { owners: unknown[] }).owners).toEqual([]);
  });

  it('a malformed payload deletes nothing and does not throw', async () => {
    const b = await boot(usageByAgent({ agt_1: 40 * MB }));
    await applied(b, b.harness.ctx({ userId: 'alice', agentId: 'agt_1' }));
    await b.plugin.drain();
    const ctx = b.harness.ctx({ userId: 'system' });
    const bad: unknown[] = [
      undefined,
      null,
      'agt_1',
      42,
      [],
      {},
      { agentId: '' },
      { agentId: 5 },
      { agentId: null },
      { agentId: ['agt_1'] },
      { agent: 'agt_1' },
    ];
    for (const payload of bad) {
      await expect(workspaceDeleted(b, ctx, payload), JSON.stringify(payload)).resolves.toMatchObject({
        rejected: false,
      });
    }
    expect((await mine(b, 'alice')).workspaceBytes).toBe(40 * MB);
    // The subscriber is alive (so the above is not just "nobody was listening"):
    // the same hook with a good payload does drop the row.
    await workspaceDeleted(b, ctx, { agentId: 'agt_1' });
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
  });
});

describe('the chat:start front door, end to end through the bus', () => {
  it('turns a FULL person away with the stable code; someone with room, and someone else, get through', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    const bob = b.harness.ctx({ userId: 'bob', agentId: 'agt_2' });
    await blobStored(b, alice, 63 * MB);
    expect((await chatStart(b, alice)).rejected).toBe(false);

    await blobStored(b, alice, 1 * MB, 'b');
    expect(await chatStart(b, alice)).toMatchObject({
      rejected: true,
      reason: 'storage-full',
      source: '@ax/disk-quota',
    });
    expect((await chatStart(b, bob)).rejected).toBe(false);
  });

  it('lets the turn through when the check itself breaks (the write gates still fail closed)', async () => {
    const b = await boot();
    await (await dbOf(b)).destroy();
    expect((await chatStart(b, b.harness.ctx({ userId: 'alice', agentId: 'agt_1' }))).rejected).toBe(false);
    expect((await blobPrePut(b, b.harness.ctx({ userId: 'alice' }), 1)).rejected).toBe(true);
  });
});

describe('the workspace:pre-apply gate, end to end through the bus', () => {
  const usage = (bytes: number): Record<string, ServiceHandler> => ({
    'workspace:usage': (async () => ({ bytes })) as ServiceHandler,
  });

  it('passes when there is no sizeBytes and nothing is stored', async () => {
    const b = await boot();
    const ctx = b.harness.ctx({ userId: 'alice' });
    expect((await preApply(b, ctx)).rejected).toBe(false);
  });

  it('refuses a commit that would cross the limit, using sizeBytes; exactly the limit passes', async () => {
    const b = await boot(usage(60 * MB));
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await applied(b, alice);
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(60 * MB);

    expect(await preApply(b, alice, 5 * MB)).toMatchObject({
      rejected: true,
      reason: workspaceFullMessage(60 * MB, 64 * MB),
      source: '@ax/disk-quota',
    });
    expect((await preApply(b, alice, 4 * MB)).rejected).toBe(false);
    expect((await preApply(b, alice, 4 * MB + 1)).rejected).toBe(true);
    // Another user, another agent: unaffected.
    expect((await preApply(b, b.harness.ctx({ userId: 'bob', agentId: 'agt_2' }), 5 * MB)).rejected).toBe(
      false,
    );
  });

  it('workspace bytes and file bytes share ONE budget', async () => {
    const b = await boot(usage(30 * MB));
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await applied(b, alice);
    await b.plugin.drain();
    await blobStored(b, alice, 30 * MB);
    expect((await preApply(b, alice, 4 * MB)).rejected).toBe(false);
    expect((await preApply(b, alice, 4 * MB + 1)).rejected).toBe(true);
    expect((await blobPrePut(b, alice, 4 * MB + 1)).rejected).toBe(true);
  });

  it('reads a hostile sizeBytes as 0: an over-limit owner is still refused, an ordinary one still passes', async () => {
    const b = await boot(usage(100 * MB));
    const over = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await applied(b, over);
    await b.plugin.drain();
    await setLimitMb(b, 64); // alice is now over her limit
    for (const bad of [-1e12, Number.NaN, 'lots', null, {}, Number.POSITIVE_INFINITY]) {
      expect((await preApply(b, over, bad)).rejected, String(bad)).toBe(true);
    }
    const fine = b.harness.ctx({ userId: 'bob', agentId: 'agt_2' });
    for (const bad of [-1e12, Number.NaN, 'lots', null, {}]) {
      expect((await preApply(b, fine, bad)).rejected, String(bad)).toBe(false);
    }
  });

  it('FAILS CLOSED when the database is broken', async () => {
    const b = await boot();
    await (await dbOf(b)).destroy();
    expect(await preApply(b, b.harness.ctx({ userId: 'alice' }), 1)).toMatchObject({
      rejected: true,
      reason: STORAGE_UNAVAILABLE_MESSAGE,
    });
  });

  it('charges a team agent\'s workspace to team:<id>, not to whoever happened to commit', async () => {
    const b = await boot({
      ...usage(30 * MB),
      'agents:resolve': (async (_c: unknown, input: { agentId: string; userId: string }) => ({
        agent:
          input.agentId === 'agt_team'
            ? { ownerId: 't1', ownerType: 'team' }
            : { ownerId: input.userId, ownerType: 'user' },
      })) as ServiceHandler,
    });
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_team' });
    const bob = b.harness.ctx({ userId: 'bob', agentId: 'agt_team' });
    await applied(b, alice);
    await b.plugin.drain();

    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
    // Bob commits to the same team agent: the team's 30 MB is what counts.
    expect((await preApply(b, bob, 34 * MB)).rejected).toBe(false);
    expect((await preApply(b, bob, 34 * MB + 1)).rejected).toBe(true);

    b.setAuth({ id: 'admin-1', isAdmin: true });
    const r = await b.request('GET', '/admin/storage');
    expect((r.json as { owners: Array<Record<string, unknown>> }).owners).toEqual([
      expect.objectContaining({ ownerId: 'team:t1', kind: 'team', workspaceBytes: 30 * MB }),
    ]);
  });
});

describe('the workspace:applied meter', () => {
  it('does not hold up the write: the fire returns before the measurement finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const b = await boot({
      'workspace:usage': (async () => {
        started++;
        await gate;
        return { bytes: 7 * MB };
      }) as ServiceHandler,
    });
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    const result = await applied(b, alice);
    expect(result.rejected).toBe(false);
    // The measurement was started, is still waiting, and the fire is over.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1);
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
    release();
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(7 * MB);
  });

  it('measures the agent of THAT write (workspace:usage routes by ctx.agentId)', async () => {
    const seen: string[] = [];
    const b = await boot({
      'workspace:usage': (async (ctx: AgentContext) => {
        seen.push(`${ctx.agentId}/${ctx.userId}`);
        return { bytes: 1 * MB };
      }) as ServiceHandler,
    });
    await applied(b, b.harness.ctx({ userId: 'alice', agentId: 'agt_7' }));
    await b.plugin.drain();
    expect(seen).toEqual(['agt_7/alice']);
  });

  it('a failing measurement is a warn, never a failed write', async () => {
    const b = await boot({
      'workspace:usage': (async () => {
        throw new Error('disk gone');
      }) as ServiceHandler,
    });
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    expect((await applied(b, alice)).rejected).toBe(false);
    await expect(b.plugin.drain()).resolves.toBeUndefined();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
  });

  it('without workspace:usage, workspace bytes are simply not counted (files still are)', async () => {
    const b = await boot();
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await applied(b, alice);
    await b.plugin.drain();
    await blobStored(b, alice, 2 * MB);
    expect(await mine(b, 'alice')).toMatchObject({ workspaceBytes: 0, fileBytes: 2 * MB });
  });
});

describe('the sweep', () => {
  const fleet = (calls: { list: number }): Record<string, ServiceHandler> => ({
    'agents:list-personal-owners': (async () => {
      calls.list++;
      return {
        agents: [
          { agentId: 'a1', ownerUserId: 'alice' },
          { agentId: 'b1', ownerUserId: 'bob' },
        ],
      };
    }) as ServiceHandler,
    'workspace:usage': (async (ctx: AgentContext) => ({
      bytes: ctx.agentId === 'a1' ? 11 * MB : 5 * MB,
    })) as ServiceHandler,
  });

  it('reconcile() before init resolves all zeros', async () => {
    expect(await createDiskQuotaPlugin().reconcile()).toEqual({
      measured: 0,
      failed: 0,
      blobsReleased: 0,
      blobReleaseAborted: false,
    });
  });

  it("reconcile() runs the blob pass on the plugin's clock: A's charge goes once A lets go, B's stays", async () => {
    const b = await boot();
    const alice = b.harness.ctx({ userId: 'alice' });
    const bob = b.harness.ctx({ userId: 'bob' });
    await blobStored(b, alice, 3 * MB);
    await blobStored(b, bob, 3 * MB);
    b.harness.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, '@ax/attachments', async (_c, p) =>
      answerBlobCollectRefs(p, '@ax/attachments', async () => [{ sha256: sha('a'), userIds: ['bob'] }]),
    );
    // Rows are stamped with the database's own now(); the cutoff comes from
    // the INJECTED clock, so step it rather than sleep.
    b.clock.set(new Date(Date.now() + 60 * 60 * 1000));
    expect(await b.plugin.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: false });
    expect((await mine(b, 'alice')).fileBytes).toBe(3 * MB);
    b.clock.set(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(await b.plugin.reconcile()).toEqual({
      measured: 0,
      failed: 0,
      blobsReleased: 1,
      blobReleaseAborted: false,
    });
    expect((await mine(b, 'alice')).fileBytes).toBe(0);
    expect((await mine(b, 'bob')).fileBytes).toBe(3 * MB);
  });

  it('reconcile() backfills workspaces that existed before the plugin did', async () => {
    const calls = { list: 0 };
    const b = await boot(fleet(calls));
    expect(await b.plugin.reconcile()).toEqual({
      measured: 2,
      failed: 0,
      blobsReleased: 0,
      blobReleaseAborted: false,
    });
    expect((await mine(b, 'alice')).workspaceBytes).toBe(11 * MB);
    expect((await mine(b, 'bob')).workspaceBytes).toBe(5 * MB);
  });

  it('runs by itself after the initial delay and then on its interval', async () => {
    const calls = { list: 0 };
    const b = await boot(fleet(calls), { sweepInitialDelayMs: 10, sweepIntervalMs: 40 });
    await waitFor(() => calls.list >= 2);
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(11 * MB);
  });

  it('does not run at all when the interval is 0', async () => {
    const calls = { list: 0 };
    await boot(fleet(calls), { sweepInitialDelayMs: 5, sweepIntervalMs: 0 });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.list).toBe(0);
  });

  it('stops when the plugin shuts down', async () => {
    const calls = { list: 0 };
    const b = await boot(fleet(calls), { sweepInitialDelayMs: 5, sweepIntervalMs: 20 });
    await waitFor(() => calls.list >= 1);
    await b.harness.close({ onError: () => {} });
    await b.plugin.drain();
    const settled = calls.list;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.list).toBe(settled);
  });

  it('does not run before the initial delay', async () => {
    const calls = { list: 0 };
    await boot(fleet(calls), { sweepInitialDelayMs: 60_000, sweepIntervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.list).toBe(0);
  });
});

describe('lifecycle', () => {
  it('the ledger survives a plugin restart', async () => {
    const b1 = await boot();
    await setLimitMb(b1, 64);
    const storage = new Map(b1.storage);
    await blobStored(b1, b1.harness.ctx({ userId: 'alice' }), 64 * MB);
    await b1.harness.close({ onError: () => {} });

    const b2 = await boot();
    for (const [k, v] of storage) b2.storage.set(k, v);
    expect((await blobPrePut(b2, b2.harness.ctx({ userId: 'alice' }), 1)).rejected).toBe(true);
  });

  it('shutdown unregisters its routes and its subscribers', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await blobStored(b, alice, 64 * MB);
    expect((await blobPrePut(b, alice, 1)).rejected).toBe(true);
    expect((await chatStart(b, alice)).rejected).toBe(true);
    await b.harness.close({ onError: () => {} });
    expect(b.unregistered.sort()).toEqual(
      ['GET /admin/storage', 'GET /settings/storage', 'PUT /admin/storage/limits', 'POST /admin/storage/ref-holders/forget'].sort(),
    );
    // No gate left: the (now closed) plugin is gone rather than refusing.
    expect(await blobPrePut(b, alice, 1)).toEqual({ rejected: false, payload: { size: 1 } });
    expect((await preApply(b, alice, 1)).rejected).toBe(false);
    expect((await chatStart(b, alice)).rejected).toBe(false);
  });

  it('a failed init unwinds: routes it registered are removed and no gate is left behind', async () => {
    const bus = new HookBus();
    const unregistered: string[] = [];
    let registered = 0;
    const pool = new pg.Pool({ connectionString, max: 2 });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    bus.registerService('database:get-instance', 'test', async () => ({ db }));
    bus.registerService('storage:get', 'test', async () => ({ value: undefined }));
    bus.registerService('storage:set', 'test', async () => ({}));
    bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'u', isAdmin: true } }));
    bus.registerService<{ method: string; path: string }, { unregister: () => void }>(
      'http:register-route',
      'test',
      async (_c, input) => {
        registered++;
        if (registered === 3) throw new Error('route table full');
        return { unregister: () => void unregistered.push(`${input.method} ${input.path}`) };
      },
    );
    const plugin = createDiskQuotaPlugin({ sweepIntervalMs: 0 });
    await expect(plugin.init({ bus, config: {} })).rejects.toThrow('route table full');
    expect(unregistered.sort()).toEqual(['GET /admin/storage', 'GET /settings/storage']);
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'alice' });
    expect(await bus.fire('blob:pre-put', ctx, { size: 10 * 1024 * 1024 * MB })).toMatchObject({
      rejected: false,
    });
    await db.destroy();
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
