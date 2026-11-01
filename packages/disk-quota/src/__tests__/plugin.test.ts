import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { createDiskQuotaPlugin } from '../plugin.js';
import { blobFullMessage, STORAGE_UNAVAILABLE_MESSAGE } from '../messages.js';
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
  it('subscribes to the upload gate, the two meters and the agent delete (never chat:start), registers nothing, declares its calls', () => {
    const m = createDiskQuotaPlugin().manifest;
    expect(m.name).toBe('@ax/disk-quota');
    expect(m.version).toBe('0.0.0');
    expect(m.registers).toEqual([]);
    expect(m.subscribes).toEqual(['blob:pre-put', 'blob:stored', 'chat:turn-end', 'agents:deleted']);
    expect(m.calls).toEqual([
      'database:get-instance',
      'storage:get',
      'storage:set',
      'http:register-route',
      'auth:require-user',
    ]);
    expect(m.optionalCalls?.map((c) => c.hook)).toEqual([
      'agents:resolve',
      'agents:list-personal-owners',
      'auth:get-user',
      'blob:stat',
      'sandbox:user-files-usage',
    ]);
    for (const c of m.optionalCalls ?? []) expect(c.degradation.length).toBeGreaterThan(20);
  });

  // TASK-995: the git workspace tier is gone, so nothing here may listen on or
  // call into it. The bus does not hold a plugin to its manifest, so this
  // records what init REALLY subscribes to.
  it('init subscribes to exactly what the manifest declares, and to no workspace hook', async () => {
    const bus = new HookBus();
    const pool = new pg.Pool({ connectionString, max: 2 });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    bus.registerService('database:get-instance', 'test', async () => ({ db }));
    bus.registerService('storage:get', 'test', async () => ({ value: undefined }));
    bus.registerService('storage:set', 'test', async () => ({}));
    bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'u', isAdmin: true } }));
    bus.registerService('http:register-route', 'test', async () => ({ unregister: () => {} }));
    const subscribe = vi.spyOn(bus, 'subscribe');
    const plugin = createDiskQuotaPlugin({ sweepIntervalMs: 0 });
    try {
      await plugin.init({ bus, config: {} });
      const subscribed = subscribe.mock.calls
        .filter(([, owner]) => owner === '@ax/disk-quota')
        .map(([hook]) => hook);
      expect([...subscribed].sort()).toEqual([...plugin.manifest.subscribes].sort());
      const m = plugin.manifest;
      const touched = [
        ...subscribed,
        ...m.registers,
        ...m.calls,
        ...(m.optionalCalls ?? []).map((c) => c.hook),
      ];
      expect(touched.filter((hook) => hook.startsWith('workspace:'))).toEqual([]);
    } finally {
      await plugin.shutdown?.();
      await db.destroy();
    }
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
const turnEnd = (b: Booted, ctx: AgentContext, role: 'tool' | 'assistant') =>
  b.harness.bus.fire('chat:turn-end', ctx, { reqId: 'r1', reason: 'user-message-wait', role });

// The upload gate says WHY in a machine-readable code as well as in prose, so a
// caller that must react to "full" specifically (an HTTP status, say) does not
// have to match a sentence or the name of the plugin that said no.
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

  it('but NOT on the fail-closed "could not check" refusal, which is not the same thing', async () => {
    const b = await boot();
    await (await dbOf(b)).destroy();
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    const r = await blobPrePut(b, alice, 1);
    expect(r).toMatchObject({ rejected: true, reason: STORAGE_UNAVAILABLE_MESSAGE });
    expect('code' in r).toBe(false);
  });
});

// TASK-995: an older release left git-workspace charges behind, and nothing
// re-measures or releases them now. Booting this plugin drops them, so the
// person is no longer refused for a repo that is gone.
describe('a git-workspace charge an older release left behind', () => {
  it('stops counting once the plugin boots: the upload it refused goes through', async () => {
    const first = await boot();
    await setLimitMb(first, 64);
    const storage = new Map(first.storage);
    await sql`
      INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes)
      VALUES ('alice', 'workspace:agt_1', 'workspace', ${64 * MB})
    `.execute(await dbOf(first));
    await first.harness.close({ onError: () => {} });

    const next = await boot();
    for (const [k, v] of storage) next.storage.set(k, v);
    // The boot itself removed it (not merely stopped counting it).
    const left = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM disk_quota_v1_usage WHERE kind = 'workspace'
    `.execute(await dbOf(next));
    expect(left.rows[0]?.n).toBe('0');
    const alice = next.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    expect(await blobPrePut(next, alice, 5 * MB)).toMatchObject({ rejected: false });
    expect(await mine(next, 'alice')).toMatchObject({ usedBytes: 0, workspaceBytes: 0, fileBytes: 0 });
  });
});

// TASK-993: a full person can still talk to their agent (and ask it to tidy its
// files up); only the bytes they would add are refused.
describe('over quota blocks writes, not chat', () => {
  it('a FULL owner still starts a turn: chat:start is never vetoed (TASK-993), and their uploads are refused', async () => {
    const b = await boot();
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await blobStored(b, alice, 64 * MB);
    expect(await chatStart(b, alice)).toMatchObject({ rejected: false });
    expect(await blobPrePut(b, alice, 1)).toMatchObject({
      rejected: true,
      source: '@ax/disk-quota',
      code: 'storage-full',
    });
  });
});

// TASK-993: every agent's `/files` is measured after each turn through the
// provider's `sandbox:user-files-usage`, charged to the agent's owner, and
// dropped when the agent is deleted.
describe('agent files, end to end through the bus', () => {
  const agentFiles = (
    bytes: { value: number },
    calls: string[] = [],
  ): Record<string, ServiceHandler> => ({
    'sandbox:user-files-usage': (async (_ctx: AgentContext, input: { agentId: string }) => {
      calls.push(input.agentId);
      return { bytes: bytes.value };
    }) as ServiceHandler,
    'agents:resolve': (async () => ({ agent: { ownerId: 'alice', ownerType: 'user' } })) as ServiceHandler,
  });

  it('chat:turn-end measures on the assistant turn end and not on the tool one', async () => {
    const calls: string[] = [];
    const b = await boot(agentFiles({ value: 3 * MB }, calls));
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });

    expect(await turnEnd(b, alice, 'tool')).toMatchObject({ rejected: false });
    await b.plugin.drain();
    expect(calls).toEqual([]);
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);

    expect(await turnEnd(b, alice, 'assistant')).toMatchObject({ rejected: false });
    await b.plugin.drain();
    expect(calls).toEqual(['agt_1']);
    expect((await mine(b, 'alice')).workspaceBytes).toBe(3 * MB);
  });

  it('does not hold up the turn end: the fire returns before the walk finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = 0;
    const b = await boot({
      'sandbox:user-files-usage': (async () => {
        started++;
        await gate;
        return { bytes: 7 * MB };
      }) as ServiceHandler,
      'agents:resolve': (async () => ({ agent: { ownerId: 'alice', ownerType: 'user' } })) as ServiceHandler,
    });
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    expect(await turnEnd(b, alice, 'assistant')).toMatchObject({ rejected: false });
    // The walk was started, is still waiting, and the fire is over.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1);
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
    release();
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(7 * MB);
  });

  it("agents:deleted drops the agent's agent-files row through the bus", async () => {
    const calls: string[] = [];
    const b = await boot(agentFiles({ value: 5 * MB }, calls));
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(5 * MB);

    // Whoever fires it (a system context, in real life) is not the owner.
    const fired = await b.harness.bus.fire('agents:deleted', b.harness.ctx({ userId: 'system' }), {
      agentId: 'agt_1',
      ownerId: 'alice',
      ownerType: 'user',
    });
    expect(fired.rejected).toBe(false);
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);

    // A warm runner's late turn end after the delete writes nothing.
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    expect((await mine(b, 'alice')).workspaceBytes).toBe(0);
    expect(calls).toEqual(['agt_1']);
  });

  it('a malformed agents:deleted payload deletes nothing and does not throw', async () => {
    const b = await boot(agentFiles({ value: 5 * MB }));
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    const sys = b.harness.ctx({ userId: 'system' });
    for (const payload of [undefined, null, 'agt_1', {}, { agentId: '' }, { agentId: 5 }]) {
      await expect(
        b.harness.bus.fire('agents:deleted', sys, payload),
        JSON.stringify(payload),
      ).resolves.toMatchObject({ rejected: false });
    }
    expect((await mine(b, 'alice')).workspaceBytes).toBe(5 * MB);
  });

  // TASK-1012: an agent-file chip points at the file in /files and is charged
  // once, as Agent files. Deleting the file shows up as a smaller measure at the
  // next assistant turn end, and the "getting full" notice goes away with it.
  it('(TASK-1012) deleting an agent file lowers the total by its full size and clears the warning at the next turn end', async () => {
    const usage = { value: 60 * MB };
    const b = await boot(agentFiles(usage));
    // 64 MB is the smallest limit the setting allows; the default 80% warning
    // line is 51.2 MB.
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });

    expect(await turnEnd(b, alice, 'assistant')).toMatchObject({ rejected: false });
    await b.plugin.drain();
    const before = await mine(b, 'alice');
    expect(before).toMatchObject({
      status: 'near-limit',
      workspaceBytes: 60 * MB,
      fileBytes: 0,
      usedBytes: 60 * MB,
    });

    usage.value = 4 * MB;
    expect(await turnEnd(b, alice, 'assistant')).toMatchObject({ rejected: false });
    await b.plugin.drain();
    const after = await mine(b, 'alice');
    expect(after).toMatchObject({ status: 'ok', workspaceBytes: 4 * MB, fileBytes: 0 });
    expect(before.usedBytes - after.usedBytes).toBe(56 * MB);
  });

  it('GET /settings/storage counts agent files under workspaceBytes', async () => {
    const b = await boot(agentFiles({ value: 5 * MB }));
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    await blobStored(b, alice, 2 * MB);
    expect(await mine(b, 'alice')).toMatchObject({
      usedBytes: 7 * MB,
      workspaceBytes: 5 * MB,
      fileBytes: 2 * MB,
    });
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
    'sandbox:user-files-usage': (async (_ctx: AgentContext, input: { agentId: string }) => ({
      bytes: input.agentId === 'a1' ? 11 * MB : 5 * MB,
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

  it('reconcile() backfills the files of agents no turn has measured yet', async () => {
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
    let measured = 0;
    const b = await boot({
      'sandbox:user-files-usage': (async () => {
        measured++;
        return { bytes: 1 };
      }) as ServiceHandler,
      'agents:resolve': (async () => ({ agent: { ownerId: 'alice', ownerType: 'user' } })) as ServiceHandler,
    });
    await setLimitMb(b, 64);
    const alice = b.harness.ctx({ userId: 'alice', agentId: 'agt_1' });
    await blobStored(b, alice, 64 * MB);
    expect((await blobPrePut(b, alice, 1)).rejected).toBe(true);
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    expect(measured).toBe(1);
    await b.harness.close({ onError: () => {} });
    expect(b.unregistered.sort()).toEqual(
      ['GET /admin/storage', 'GET /settings/storage', 'PUT /admin/storage/limits', 'POST /admin/storage/ref-holders/forget'].sort(),
    );
    // No gate left: the (now closed) plugin is gone rather than refusing.
    expect(await blobPrePut(b, alice, 1)).toEqual({ rejected: false, payload: { size: 1 } });
    // ...and no meter: a turn end after shutdown walks nothing.
    await turnEnd(b, alice, 'assistant');
    await b.plugin.drain();
    expect(measured).toBe(1);
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
