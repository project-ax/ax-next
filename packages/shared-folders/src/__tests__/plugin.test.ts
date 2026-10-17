import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
  createTestHarness,
  type TestHarness,
  stopPostgresContainer,
  startTestContainer,
} from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import {
  createLogger,
  makeAgentContext,
  ownerlessIdFor,
  PluginError,
  type AgentContext,
  type ServiceHandler,
} from '@ax/core';
import { isValidSharedFolderId } from '@ax/sandbox-protocol';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSharedFoldersPlugin, type SharedFoldersPlugin } from '../plugin.js';
import type { SharedFoldersAccessReducedEvent, SharedFoldersDeletedEvent } from '../types.js';

// ---------------------------------------------------------------------------
// A tiny in-test agents world, standing in for @ax/agents:
//   - personal agent: managed and usable only by its owner;
//   - team agent: managed only by a team ADMIN, usable by any team member;
//   - `extraManagers` lets one test give a person authority over a single
//     agent without the folder's owner agent (the revoke OR-rule).
// Workspace-admin status does not exist here at all — which is the point: it
// must grant nothing on its own.
// ---------------------------------------------------------------------------

interface StubAgent {
  ownerType: 'user' | 'team';
  ownerId: string;
}

const AGENTS: Record<string, StubAgent> = {
  'a-alice-1': { ownerType: 'user', ownerId: 'alice' },
  'a-alice-2': { ownerType: 'user', ownerId: 'alice' },
  'a-alice-3': { ownerType: 'user', ownerId: 'alice' },
  'a-alice-4': { ownerType: 'user', ownerId: 'alice' },
  'a-bob': { ownerType: 'user', ownerId: 'bob' },
  'a-tadmin': { ownerType: 'user', ownerId: 'tadmin' },
  'a-team-1': { ownerType: 'team', ownerId: 't1' },
  'a-team-2': { ownerType: 'team', ownerId: 't1' },
};
const TEAMS: Record<string, { admins: string[]; members: string[] }> = {
  t1: { admins: ['tadmin'], members: ['tmember'] },
};
const extraManagers = new Map<string, string>(); // agentId → userId
/** Agents @ax/agents no longer has (for `agents:list-ids`), WITHOUT firing `agents:deleted`. */
const goneAgents = new Set<string>();
/** When set, `agents:list-ids` throws (the sweep must survive it). */
let listIdsFails = false;
/** When set, `agents:list-ids` answers with the wrong shape. */
let listIdsMalformed = false;
/** When set, `agents:list-ids` answers exactly these ids (a well-formed but possibly wrong answer). */
let listIdsAnswer: string[] | undefined;
/** Extra agents `agents:list-ids` reports as live (agents with no stub entry). */
const extraLiveAgents = new Set<string>();
let listIdsCalls = 0;

function manages(userId: string, agentId: string): boolean {
  const a = AGENTS[agentId]!;
  if (extraManagers.get(agentId) === userId) return true;
  if (a.ownerType === 'user') return a.ownerId === userId;
  return TEAMS[a.ownerId]!.admins.includes(userId);
}
function canUse(userId: string, agentId: string): boolean {
  const a = AGENTS[agentId]!;
  if (a.ownerType === 'user') return a.ownerId === userId;
  const t = TEAMS[a.ownerId]!;
  return t.admins.includes(userId) || t.members.includes(userId);
}
function notFound(hookName: string, agentId: string): PluginError {
  return new PluginError({ code: 'not-found', plugin: 'stub-agents', hookName, message: `no ${agentId}` });
}

type ProviderMode = 'ok' | 'fail';
let providerMode: ProviderMode = 'ok';
let providerCalls: string[] = [];
/** While set, the provider does not answer until the test releases it (a slow reclaim pod). */
let providerGate: Promise<void> | undefined;
let releaseProvider: (() => void) | undefined;
function holdProvider(): () => void {
  let release!: () => void;
  providerGate = new Promise<void>((r) => {
    release = r;
  });
  releaseProvider = () => {
    providerGate = undefined;
    releaseProvider = undefined;
    release();
  };
  return releaseProvider;
}

const agentServices: Record<string, ServiceHandler> = {
  'agents:can-manage-sharing': async (ctx, raw) => {
    const { agentId } = raw as { agentId: string };
    if (!AGENTS[agentId]) throw notFound('agents:can-manage-sharing', agentId);
    return { allowed: manages(ctx.userId, agentId) };
  },
  'agents:resolve': async (_ctx, raw) => {
    const { agentId, userId } = raw as { agentId: string; userId: string };
    const a = AGENTS[agentId];
    if (!a) throw notFound('agents:resolve', agentId);
    if (!canUse(userId, agentId)) {
      throw new PluginError({ code: 'forbidden', plugin: 'stub-agents', hookName: 'agents:resolve', message: 'no' });
    }
    return { agent: { id: agentId, ...a } };
  },
  'agents:list-ids': async () => {
    listIdsCalls++;
    if (listIdsFails) throw new Error('agents store unavailable');
    if (listIdsMalformed) return { ids: [] };
    if (listIdsAnswer !== undefined) return { agentIds: [...listIdsAnswer] };
    return { agentIds: [...Object.keys(AGENTS), ...extraLiveAgents].filter((id) => !goneAgents.has(id)) };
  },
};
const providerService: Record<string, ServiceHandler> = {
  'sandbox:delete-shared-folder': async (_ctx, raw) => {
    const { folderId } = raw as { folderId: string };
    providerCalls.push(folderId);
    if (providerGate !== undefined) await providerGate;
    if (providerMode === 'fail') throw new Error('nfs unavailable');
    return { deleted: true };
  },
};

// ---------------------------------------------------------------------------

let container: StartedPostgreSqlContainer;
let connectionString: string;
const harnesses: TestHarness[] = [];

interface World {
  h: TestHarness;
  plugin: SharedFoldersPlugin;
  logs: Record<string, unknown>[];
  events: SharedFoldersAccessReducedEvent[];
  /** Every `shared-folders:deleted` payload, in fire order. */
  deletedEvents: SharedFoldersDeletedEvent[];
  as(userId: string): AgentContext;
  call<O = unknown>(userId: string, hook: string, input: unknown): Promise<O>;
}

async function makeWorld(opts: { provider?: boolean; sweepIntervalMs?: number } = {}): Promise<World> {
  const plugin = createSharedFoldersPlugin({ sweepIntervalMs: opts.sweepIntervalMs ?? 0 });
  const h = await createTestHarness({
    services: { ...agentServices, ...(opts.provider === false ? {} : providerService) },
    plugins: [createDatabasePostgresPlugin({ connectionString }), plugin],
  });
  harnesses.push(h);
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({ reqId: 'test', writer: (line) => logs.push(JSON.parse(line)) });
  const events: SharedFoldersAccessReducedEvent[] = [];
  h.bus.subscribe<SharedFoldersAccessReducedEvent>('shared-folders:access-reduced', 'test', async (_c, p) => {
    events.push(p);
    return undefined;
  });
  const deletedEvents: SharedFoldersDeletedEvent[] = [];
  h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'test', async (_c, p) => {
    deletedEvents.push(p);
    return undefined;
  });
  const as = (userId: string): AgentContext =>
    makeAgentContext({ sessionId: 's', agentId: 'caller-agent', userId, logger });
  return {
    h,
    plugin,
    logs,
    events,
    deletedEvents,
    as,
    call: (userId, hook, input) => h.bus.call(hook, as(userId), input),
  };
}

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end().catch(() => {});
  }
}
async function counts(): Promise<{ folders: number; grants: number; snapshot: string }> {
  const f = await q('SELECT * FROM shared_folders_v1_folders ORDER BY folder_id');
  const g = await q('SELECT * FROM shared_folders_v1_grants ORDER BY folder_id, agent_id');
  return { folders: f.length, grants: g.length, snapshot: JSON.stringify([f, g]) };
}
async function grantsOf(folderId: string): Promise<Record<string, string>> {
  const rows = await q<{ agent_id: string; role: string }>(
    'SELECT agent_id, role FROM shared_folders_v1_grants WHERE folder_id = $1',
    [folderId],
  );
  return Object.fromEntries(rows.map((r) => [r.agent_id, r.role]));
}
async function folderRow(folderId: string): Promise<Record<string, unknown> | undefined> {
  return (await q('SELECT * FROM shared_folders_v1_folders WHERE folder_id = $1', [folderId]))[0];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll `read` until `done` holds (or 10 s pass), returning the last value read. */
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  let v = await read();
  while (!done(v) && Date.now() < deadline) {
    await sleep(25);
    v = await read();
  }
  return v;
}
/** Wait for a detached cleanup to settle: the row is gone, or a failure was recorded. */
async function cleanupSettled(folderId: string): Promise<Record<string, unknown> | undefined> {
  return waitFor(
    () => folderRow(folderId),
    (r) => r === undefined || (r.cleanup_attempts as number) > 0,
  );
}

async function create(w: World, userId: string, ownerAgentId: string): Promise<string> {
  const { folderId } = await w.call<{ folderId: string }>(userId, 'shared-folders:create', { ownerAgentId });
  return folderId;
}
function refusals(w: World): Record<string, unknown>[] {
  return w.logs.filter((l) => l.msg === 'shared_folders_refused');
}

/** Assert a call is refused as `forbidden`, writes nothing, and is audited with `reason`. */
async function expectRefused(w: World, userId: string, hook: string, input: unknown, reason: string): Promise<void> {
  const before = await counts();
  const auditedBefore = refusals(w).length;
  const eventsBefore = w.events.length;
  await expect(w.call(userId, hook, input)).rejects.toMatchObject({ code: 'forbidden', hookName: hook });
  const after = await counts();
  expect(after.snapshot).toBe(before.snapshot);
  expect(w.events.length).toBe(eventsBefore);
  const audited = refusals(w).slice(auditedBefore);
  expect(audited).toHaveLength(1);
  expect(audited[0]).toMatchObject({ level: 'warn', hook, reason });
}

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  connectionString = container.getConnectionUri();
}, 120_000);
afterEach(async () => {
  releaseProvider?.();
  while (harnesses.length > 0) await harnesses.pop()!.close({ onError: () => {} });
  providerMode = 'ok';
  providerCalls = [];
  extraManagers.clear();
  goneAgents.clear();
  listIdsFails = false;
  listIdsMalformed = false;
  listIdsAnswer = undefined;
  extraLiveAgents.clear();
  listIdsCalls = 0;
  await q('DROP TABLE IF EXISTS shared_folders_v1_grants');
  await q('DROP TABLE IF EXISTS shared_folders_v1_folders');
});
afterAll(async () => {
  if (container) await stopPostgresContainer(container);
});

describe('@ax/shared-folders manifest', () => {
  it('declares its surface; the provider delete hook is NOT declared (call-graph cycle)', () => {
    const m = createSharedFoldersPlugin().manifest;
    expect(m).toEqual({
      name: '@ax/shared-folders',
      version: '0.0.0',
      registers: [
        'shared-folders:create',
        'shared-folders:grant',
        'shared-folders:revoke',
        'shared-folders:delete',
        'shared-folders:list',
        'shared-folders:get',
        'shared-folders:authorize-mounts',
      ],
      calls: ['database:get-instance', 'agents:can-manage-sharing', 'agents:resolve', 'agents:list-ids'],
      subscribes: ['agents:deleted'],
    });
  });
});

describe('create', () => {
  it('mints an sf_ id and records the owner as the single owner grant', async () => {
    const w = await makeWorld();
    const folderId = await create(w, 'alice', 'a-alice-1');
    expect(isValidSharedFolderId(folderId)).toBe(true);
    expect(await grantsOf(folderId)).toEqual({ 'a-alice-1': 'owner' });
    expect(await folderRow(folderId)).toMatchObject({ created_by_user: 'alice', deleted_at: null });
    const other = await create(w, 'alice', 'a-alice-1');
    expect(other).not.toBe(folderId);
  });

  it('a team admin may create on a team agent', async () => {
    const w = await makeWorld();
    const folderId = await create(w, 'tadmin', 'a-team-1');
    expect(await grantsOf(folderId)).toEqual({ 'a-team-1': 'owner' });
  });

  it('refuses a person who does not manage the owner agent (another user, a non-admin team member, a workspace admin)', async () => {
    const w = await makeWorld();
    await expectRefused(w, 'bob', 'shared-folders:create', { ownerAgentId: 'a-alice-1' }, 'cannot-manage-owner-agent');
    await expectRefused(w, 'tmember', 'shared-folders:create', { ownerAgentId: 'a-team-1' }, 'cannot-manage-owner-agent');
    await expectRefused(w, 'wsadmin', 'shared-folders:create', { ownerAgentId: 'a-team-1' }, 'cannot-manage-owner-agent');
    await expectRefused(w, 'alice', 'shared-folders:create', { ownerAgentId: 'a-ghost' }, 'cannot-manage-owner-agent');
  });

  it('refuses a call with no real person: empty, system, owner-less', async () => {
    const w = await makeWorld();
    // Give `system` real authority in the stub, so the only thing that can
    // refuse it is the actor gate itself (not the manage check).
    extraManagers.set('a-alice-1', 'system');
    for (const actor of ['', 'system', ownerlessIdFor('sess-1')]) {
      await expectRefused(w, actor, 'shared-folders:create', { ownerAgentId: 'a-alice-1' }, 'no-actor');
    }
  });

  it('rejects unknown payload keys (the actor never comes from the payload)', async () => {
    const w = await makeWorld();
    await expect(
      w.call('bob', 'shared-folders:create', { ownerAgentId: 'a-alice-1', userId: 'alice' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect((await counts()).folders).toBe(0);
  });
});

describe('grant', () => {
  it('adds a grant to a same-owner agent the actor manages; re-granting the same role is a no-op', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    expect(await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' })).toEqual({ changed: true });
    expect(await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' })).toEqual({ changed: false });
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner', 'a-alice-2': 'editor' });
  });

  it('refuses granting to an agent the actor does not manage', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await expectRefused(w, 'alice', 'shared-folders:grant', { folderId: f, agentId: 'a-bob', role: 'viewer' }, 'cannot-manage-target');
  });

  it('refuses granting to an agent with a different owner even when the actor manages both', async () => {
    const w = await makeWorld();
    // tadmin manages the team folder AND their own personal agent — only the
    // same-owner rule stops this.
    const f = await create(w, 'tadmin', 'a-team-1');
    await expectRefused(w, 'tadmin', 'shared-folders:grant', { folderId: f, agentId: 'a-tadmin', role: 'viewer' }, 'different-owner');
    // …while a same-owner team agent is fine.
    expect(await w.call('tadmin', 'shared-folders:grant', { folderId: f, agentId: 'a-team-2', role: 'viewer' })).toEqual({ changed: true });
  });

  it('refuses a person who manages the target but not the folder', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    extraManagers.set('a-alice-2', 'delegate');
    await expectRefused(w, 'delegate', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' }, 'cannot-manage-folder');
  });

  it('a non-admin team member and a workspace admin are refused on a team folder', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    for (const actor of ['tmember', 'wsadmin']) {
      await expectRefused(w, actor, 'shared-folders:grant', { folderId: f, agentId: 'a-team-2', role: 'viewer' }, 'cannot-manage-folder');
    }
  });

  it('refuses role owner (no second owner) and refuses a grant that targets the owner', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await expect(
      w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'owner' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    await expectRefused(w, 'alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-1', role: 'viewer' }, 'target-is-owner');
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });

  it('the database itself allows only one owner per folder', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await expect(
      q(`INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, 'a-alice-2', 'owner', 'x')`, [f]),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('refuses an unknown folder', async () => {
    const w = await makeWorld();
    await expectRefused(w, 'alice', 'shared-folders:grant', { folderId: 'sf_doesnotexist', agentId: 'a-alice-2', role: 'viewer' }, 'folder-unavailable');
  });

  it('a downgrade editor→viewer fires access-reduced; a new grant and an upgrade do not', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    expect(w.events).toEqual([]);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-2'] }]);
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner', 'a-alice-2': 'viewer' });
  });
});

describe('revoke', () => {
  it('the folder manager revokes; access-reduced fires; revoking nothing fires nothing', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    expect(await w.call('alice', 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-2' })).toEqual({ revoked: true });
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-2'] }]);
    expect(await w.call('alice', 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-2' })).toEqual({ revoked: false });
    expect(w.events).toHaveLength(1);
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });

  it("the target agent's manager can take it out of a folder they don't manage", async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    extraManagers.set('a-alice-2', 'delegate');
    expect(await w.call('delegate', 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-2' })).toEqual({ revoked: true });
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });

  it('refuses a person who manages neither, including a non-admin team member and a workspace admin', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    await w.call('tadmin', 'shared-folders:grant', { folderId: f, agentId: 'a-team-2', role: 'editor' });
    for (const actor of ['tmember', 'wsadmin', 'bob']) {
      await expectRefused(w, actor, 'shared-folders:revoke', { folderId: f, agentId: 'a-team-2' }, 'cannot-manage-folder-or-target');
    }
  });

  it('refuses revoking the owner', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await expectRefused(w, 'alice', 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-1' }, 'target-is-owner');
  });
});

describe('delete + cleanup', () => {
  it('tombstones, fires access-reduced for every former grantee, calls the provider and removes the row', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'viewer' });
    expect(await w.call('alice', 'shared-folders:delete', { folderId: f })).toEqual({ deleted: true });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]!.folderId).toBe(f);
    expect([...w.events[0]!.agentIds].sort()).toEqual(['a-alice-1', 'a-alice-2', 'a-alice-3']);
    // Cleanup runs detached; wait for it.
    expect(await cleanupSettled(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
    expect(await grantsOf(f)).toEqual({});
  });

  it('returns before a slow provider finishes; the row goes once it does (cleanup is detached)', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    const release = holdProvider();
    // A k8s reclaim pod can take longer than the bus's service timeout, so
    // delete must not wait for it.
    const outcome = await Promise.race([
      w.call('alice', 'shared-folders:delete', { folderId: f }),
      sleep(3_000).then(() => 'still-waiting-on-provider'),
    ]);
    expect(outcome).toEqual({ deleted: true });
    // Tombstoned + access-reduced already happened; the provider is mid-flight.
    expect(w.events).toHaveLength(1);
    expect(await waitFor(async () => providerCalls, (c) => c.length > 0)).toEqual([f]);
    const row = await folderRow(f);
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();
    expect(await grantsOf(f)).toEqual({});
    release();
    expect(await cleanupSettled(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
  });

  it('a sweep during an in-flight detached cleanup does not call the provider a second time', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const release = holdProvider();
    await Promise.race([w.call('alice', 'shared-folders:delete', { folderId: f }), sleep(3_000)]);
    await waitFor(async () => providerCalls, (c) => c.length > 0);
    expect(await w.plugin.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000))).toEqual({ attempted: 0, removed: 0 });
    release();
    expect(await cleanupSettled(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
  });

  it('shutdown waits for an in-flight detached cleanup', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const release = holdProvider();
    await Promise.race([w.call('alice', 'shared-folders:delete', { folderId: f }), sleep(3_000)]);
    await waitFor(async () => providerCalls, (c) => c.length > 0);
    let shutDown = false;
    const stopping = w.plugin.shutdown!().then(() => {
      shutDown = true;
    });
    await sleep(200);
    expect(shutDown).toBe(false);
    release();
    await stopping;
    expect(shutDown).toBe(true);
    // The cleanup finished before shutdown resolved.
    expect(await folderRow(f)).toBeUndefined();
  });

  it('refuses a non-manager (team member, workspace admin) and writes nothing', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    for (const actor of ['tmember', 'wsadmin']) {
      await expectRefused(w, actor, 'shared-folders:delete', { folderId: f }, 'cannot-manage-folder');
    }
    expect(providerCalls).toEqual([]);
  });

  it('a failed provider delete keeps the tombstone with backoff; the sweep retries once due and removes it', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    providerMode = 'fail';
    expect(await w.call('alice', 'shared-folders:delete', { folderId: f })).toEqual({ deleted: true });
    const row = await cleanupSettled(f);
    expect(row).toMatchObject({ cleanup_attempts: 1 });
    expect(row!.deleted_at).not.toBeNull();
    expect((row!.next_cleanup_at as Date).getTime()).toBeGreaterThan(Date.now());
    expect(await grantsOf(f)).toEqual({});
    expect(w.logs.some((l) => l.msg === 'shared_folders_cleanup_failed' && l.folderId === f)).toBe(true);

    // Not due yet → the sweep leaves it alone.
    providerMode = 'ok';
    expect(await w.plugin.sweep(new Date())).toEqual({ attempted: 0, removed: 0 });
    expect(await folderRow(f)).toBeDefined();

    // Due → retried and removed.
    expect(await w.plugin.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000))).toEqual({ attempted: 1, removed: 1 });
    expect(await folderRow(f)).toBeUndefined();
    expect(providerCalls).toEqual([f, f]);
  });

  it('backoff grows with each failure', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: f });
    const first = (await cleanupSettled(f))!.next_cleanup_at as Date;
    const t = new Date(first.getTime() + 1);
    await w.plugin.sweep(t);
    const r = (await folderRow(f))!;
    expect(r.cleanup_attempts).toBe(2);
    expect((r.next_cleanup_at as Date).getTime() - t.getTime()).toBeGreaterThan(first.getTime() - Date.now());
  });

  it('with no provider loaded the tombstone stays (and the sweep keeps it)', async () => {
    const w = await makeWorld({ provider: false });
    const f = await create(w, 'alice', 'a-alice-1');
    expect(await w.call('alice', 'shared-folders:delete', { folderId: f })).toEqual({ deleted: true });
    expect((await cleanupSettled(f))!.deleted_at).not.toBeNull();
    await w.plugin.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect((await folderRow(f))!.deleted_at).not.toBeNull();
    expect(w.logs.some((l) => l.msg === 'shared_folders_cleanup_failed' && l.reason === 'no-provider')).toBe(true);
  });

  it('the interval sweep runs on its own and removes a due tombstone', async () => {
    const w = await makeWorld({ sweepIntervalMs: 50 });
    const f = await create(w, 'alice', 'a-alice-1');
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: f });
    await cleanupSettled(f);
    providerMode = 'ok';
    await q(`UPDATE shared_folders_v1_folders SET next_cleanup_at = NOW() - INTERVAL '1 minute' WHERE folder_id = $1`, [f]);
    const deadline = Date.now() + 10_000;
    while ((await folderRow(f)) !== undefined && Date.now() < deadline) await sleep(50);
    expect(await folderRow(f)).toBeUndefined();
  });

  it('a tombstoned folder cannot be granted, revoked, deleted again, mounted or listed', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: f });
    // Let the detached cleanup record its failure before snapshotting rows.
    await cleanupSettled(f);
    await expectRefused(w, 'alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' }, 'folder-unavailable');
    await expectRefused(w, 'alice', 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-2' }, 'folder-unavailable');
    await expectRefused(w, 'alice', 'shared-folders:delete', { folderId: f }, 'folder-unavailable');
    // Even a grant row that somehow survived must not authorize a mount.
    await q(`INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, 'a-alice-2', 'editor', 'x')`, [f]);
    expect(await w.call('system', 'shared-folders:authorize-mounts', { agentId: 'a-alice-2', folderIds: [f] })).toEqual({ folders: [] });
    expect(await w.call('alice', 'shared-folders:list', { agentId: 'a-alice-2' })).toEqual({ folders: [] });
  });
});

describe('no real person: grant, revoke, delete and list refuse it too', () => {
  const NO_PERSON = ['', 'system', ownerlessIdFor('sess-1')];

  it('grant', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // Real authority in the stub for `system`, so only the actor gate can refuse.
    extraManagers.set('a-alice-1', 'system');
    extraManagers.set('a-alice-2', 'system');
    for (const actor of NO_PERSON) {
      await expectRefused(w, actor, 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' }, 'no-actor');
    }
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });

  it('revoke', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    extraManagers.set('a-alice-1', 'system');
    extraManagers.set('a-alice-2', 'system');
    for (const actor of NO_PERSON) {
      await expectRefused(w, actor, 'shared-folders:revoke', { folderId: f, agentId: 'a-alice-2' }, 'no-actor');
    }
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner', 'a-alice-2': 'editor' });
  });

  it('delete', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    extraManagers.set('a-alice-1', 'system');
    for (const actor of NO_PERSON) {
      await expectRefused(w, actor, 'shared-folders:delete', { folderId: f }, 'no-actor');
    }
    expect((await folderRow(f))!.deleted_at).toBeNull();
    expect(providerCalls).toEqual([]);
  });

  it('list', async () => {
    const w = await makeWorld();
    await create(w, 'alice', 'a-alice-1');
    for (const actor of NO_PERSON) {
      await expectRefused(w, actor, 'shared-folders:list', { agentId: 'a-alice-1' }, 'no-actor');
    }
  });
});

describe('authorize-mounts', () => {
  it('returns only live grants on the requested folders; viewer → readOnly; drops invalid ids', async () => {
    const w = await makeWorld();
    const fEdit = await create(w, 'alice', 'a-alice-1');
    const fView = await create(w, 'alice', 'a-alice-1');
    const fNone = await create(w, 'alice', 'a-alice-1');
    const fNotRequested = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: fEdit, agentId: 'a-alice-2', role: 'editor' });
    await w.call('alice', 'shared-folders:grant', { folderId: fView, agentId: 'a-alice-2', role: 'viewer' });
    await w.call('alice', 'shared-folders:grant', { folderId: fNotRequested, agentId: 'a-alice-2', role: 'editor' });
    const out = await w.call<{ folders: { folderId: string; readOnly: boolean }[] }>(
      // No person on purpose: authorize-mounts is host-internal and person-less.
      'system',
      'shared-folders:authorize-mounts',
      { agentId: 'a-alice-2', folderIds: [fEdit, fView, fNone, '../etc', 'sf_unknown', `${fEdit}/..`] },
    );
    const byId = Object.fromEntries(out.folders.map((x) => [x.folderId, x.readOnly]));
    expect(byId).toEqual({ [fEdit]: false, [fView]: true });
    // The owner holds an owner grant → writable.
    expect(
      await w.call('system', 'shared-folders:authorize-mounts', { agentId: 'a-alice-1', folderIds: [fNone] }),
    ).toEqual({ folders: [{ folderId: fNone, readOnly: false }] });
  });
});

describe('list', () => {
  it('lists an agent’s live folders with its role; requires use access, not manage access', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    await w.call('tadmin', 'shared-folders:grant', { folderId: f, agentId: 'a-team-2', role: 'viewer' });
    // A plain team member can USE the team agent → may list.
    const out = await w.call<{ folders: { folderId: string; role: string }[] }>('tmember', 'shared-folders:list', { agentId: 'a-team-2' });
    expect(out.folders.map((x) => [x.folderId, x.role])).toEqual([[f, 'viewer']]);
    await expectRefused(w, 'bob', 'shared-folders:list', { agentId: 'a-team-2' }, 'cannot-use-agent');
    await expectRefused(w, 'system', 'shared-folders:list', { agentId: 'a-team-2' }, 'no-actor');
  });
});

describe('get', () => {
  interface Member {
    agentId: string;
    role: string;
    createdAt: string;
  }
  interface GetOut {
    folderId: string;
    members: Member[];
  }

  it('returns the live folder’s members, owner first; the actor needs only use access to one member', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'viewer' });
    const out = await w.call<GetOut>('alice', 'shared-folders:get', { folderId: f });
    expect(out.folderId).toBe(f);
    expect(out.members.map((m) => [m.agentId, m.role])).toEqual([
      ['a-alice-1', 'owner'],
      ['a-alice-2', 'editor'],
      ['a-alice-3', 'viewer'],
    ]);
    for (const m of out.members) {
      expect(typeof m.createdAt).toBe('string');
      expect(new Date(m.createdAt).toISOString()).toBe(m.createdAt);
    }
    // Strict shape: nothing but these three fields leaves the plugin.
    expect(Object.keys(out.members[0]!).sort()).toEqual(['agentId', 'createdAt', 'role']);
  });

  it('puts the owner first even when an older grant exists (after an ownership transfer), then orders by createdAt', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // viewer is the oldest grant after the owner; the editor that inherits is newer.
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-4', role: 'viewer' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'editor' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    const a = AGENTS['a-alice-1']!;
    await w.h.bus.fire('agents:deleted', w.h.ctx(), { agentId: 'a-alice-1', ownerId: a.ownerId, ownerType: a.ownerType });
    const out = await w.call<GetOut>('alice', 'shared-folders:get', { folderId: f });
    expect(out.members.map((m) => [m.agentId, m.role])).toEqual([
      ['a-alice-3', 'owner'],
      ['a-alice-4', 'viewer'],
      ['a-alice-2', 'editor'],
    ]);
  });

  it('a plain team member (use access, no manage access) may get a team folder', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    const out = await w.call<GetOut>('tmember', 'shared-folders:get', { folderId: f });
    expect(out.members.map((m) => [m.agentId, m.role])).toEqual([['a-team-1', 'owner']]);
  });

  it('is allowed when the actor can use AT LEAST ONE member agent, not necessarily the owner', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // A cross-owner member (W4 shape), written straight to the table.
    await q(
      `INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, 'a-bob', 'viewer', 'x')`,
      [f],
    );
    const out = await w.call<GetOut>('bob', 'shared-folders:get', { folderId: f });
    expect(out.members.map((m) => m.agentId)).toEqual(['a-alice-1', 'a-bob']);
    await expect(w.call('tmember', 'shared-folders:get', { folderId: f })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('is not-found — never forbidden, with ONE message — for an unknown folder, a tombstoned one and an actor who can use no member', async () => {
    const w = await makeWorld();
    const live = await create(w, 'alice', 'a-alice-1');
    const dead = await create(w, 'alice', 'a-alice-1');
    providerMode = 'fail'; // keep the tombstone around
    await w.call('alice', 'shared-folders:delete', { folderId: dead });
    await cleanupSettled(dead);
    expect((await folderRow(dead))!.deleted_at).not.toBeNull();

    const before = await counts();
    const errors: PluginError[] = [];
    const cases: [string, string, string][] = [
      ['alice', 'sf_doesnotexist', 'folder-unavailable'], // unknown
      ['alice', dead, 'folder-unavailable'], // tombstoned
      ['bob', live, 'cannot-use-any-member'], // exists, actor can use no member
      ['wsadmin', live, 'cannot-use-any-member'], // workspace-admin status grants nothing
    ];
    for (const [actor, folderId, reason] of cases) {
      const auditedBefore = refusals(w).length;
      const err = await w.call(actor, 'shared-folders:get', { folderId }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PluginError);
      expect(err).toMatchObject({ code: 'not-found', hookName: 'shared-folders:get', plugin: '@ax/shared-folders' });
      errors.push(err as PluginError);
      // Audited with the real reason (the log has it, the caller does not).
      const audited = refusals(w).slice(auditedBefore);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ level: 'warn', hook: 'shared-folders:get', reason, actor, folderId });
    }
    // No oracle: every refused caller sees the identical error.
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    expect(new Set(errors.map((e) => e.code))).toEqual(new Set(['not-found']));
    // Read-only: nothing was written.
    expect((await counts()).snapshot).toBe(before.snapshot);
  });

  it('refuses a call with no real person: empty, system, owner-less', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    for (const actor of ['', 'system', ownerlessIdFor('sess-1')]) {
      await expectRefused(w, actor, 'shared-folders:get', { folderId: f }, 'no-actor');
    }
  });

  it('rejects unknown payload keys and a malformed folder id (the actor never comes from the payload)', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await expect(w.call('bob', 'shared-folders:get', { folderId: f, userId: 'alice' })).rejects.toMatchObject({
      code: 'invalid-payload',
    });
    await expect(w.call('alice', 'shared-folders:get', { folderId: '../etc' })).rejects.toMatchObject({
      code: 'invalid-payload',
    });
  });
});

describe('agents:deleted', () => {
  async function fireDeleted(w: World, agentId: string): Promise<void> {
    const a = AGENTS[agentId]!;
    await w.h.bus.fire('agents:deleted', w.h.ctx(), { agentId, ownerId: a.ownerId, ownerType: a.ownerType });
  }
  async function rowsMentioning(agentId: string): Promise<number> {
    return (await q('SELECT 1 FROM shared_folders_v1_grants WHERE agent_id = $1', [agentId])).length;
  }

  it('ownership passes to the OLDEST editor — never to an older viewer', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // Order matters: the viewer is the oldest grant overall, and the oldest
    // editor sorts AFTER the newer one by id, so neither a "oldest grant" nor
    // an "id order" implementation passes.
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-4', role: 'viewer' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'editor' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await fireDeleted(w, 'a-alice-1');
    expect(await grantsOf(f)).toEqual({ 'a-alice-3': 'owner', 'a-alice-2': 'editor', 'a-alice-4': 'viewer' });
    expect(await rowsMentioning('a-alice-1')).toBe(0);
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-1'] }]);
    expect((await folderRow(f))!.deleted_at).toBeNull();
    expect(providerCalls).toEqual([]);
  });

  it('with no editor the folder is deleted: viewers lose access, the provider is called, the row goes', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    await fireDeleted(w, 'a-alice-1');
    expect(await grantsOf(f)).toEqual({});
    expect(w.events).toHaveLength(1);
    expect([...w.events[0]!.agentIds].sort()).toEqual(['a-alice-1', 'a-alice-2']);
    // Cleanup is not awaited by the subscriber; wait for it.
    const deadline = Date.now() + 10_000;
    while ((await folderRow(f)) !== undefined && Date.now() < deadline) await sleep(25);
    expect(await folderRow(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
    expect(await rowsMentioning('a-alice-1')).toBe(0);
  });

  it('a deleted grantee just loses its grant, and access-reduced fires', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await fireDeleted(w, 'a-alice-2');
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-2'] }]);
  });

  it('a heir whose grant is revoked mid-deletion is skipped: the next editor inherits, never a live ownerless folder', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // B (a-alice-2) is the oldest editor, so it is the heir the deletion
    // picks first; C (a-alice-3) is the one that must end up owning.
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'editor' });

    // A concurrent revoke of B, held open in a raw transaction: it takes the
    // folder row lock FIRST (exactly like `revokeGrant`), then deletes B's
    // grant, and stays uncommitted while the agent deletion runs.
    //
    // Why this fails on the old code: `deleteAllForAgent` never locked the
    // folder row on the transfer branch. Its plain SELECT of the heir does not
    // block and cannot see the uncommitted delete, so it picks B; the UPDATE
    // that promotes B then blocks on B's row lock and, once the raw
    // transaction commits, re-checks the row, finds it gone and matches ZERO
    // rows — yet the old code recorded the transfer anyway. Result: a LIVE
    // folder with no owner grant. With the fix, the deletion queues on the
    // folder row lock up front, so it only ever picks a heir that exists.
    const raw = new pg.Client({ connectionString });
    await raw.connect();
    let deletion: Promise<void> | undefined;
    try {
      await raw.query('BEGIN');
      await raw.query('SELECT 1 FROM shared_folders_v1_folders WHERE folder_id = $1 FOR UPDATE', [f]);
      await raw.query('DELETE FROM shared_folders_v1_grants WHERE folder_id = $1 AND agent_id = $2', [f, 'a-alice-2']);
      deletion = fireDeleted(w, 'a-alice-1');
      // Not awaited: it must be mid-flight (blocked on a lock) when the raw
      // transaction commits. Give it time to reach that point.
      await sleep(300);
      await raw.query('COMMIT');
    } catch (err) {
      await raw.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await raw.end().catch(() => {});
    }
    await deletion;

    // The invariant: the folder is tombstoned or has exactly one owner grant…
    expect((await folderRow(f))!.deleted_at).toBeNull();
    expect(await grantsOf(f)).toEqual({ 'a-alice-3': 'owner' });
    // …and, database-wide, there is never a live folder without an owner.
    const ownerless = await q(
      `SELECT f.folder_id FROM shared_folders_v1_folders f
         LEFT JOIN shared_folders_v1_grants g ON g.folder_id = f.folder_id AND g.role = 'owner'
        WHERE f.deleted_at IS NULL AND g.agent_id IS NULL`,
    );
    expect(ownerless).toEqual([]);
    expect(await rowsMentioning('a-alice-1')).toBe(0);
    expect(providerCalls).toEqual([]);
  });

  it('a malformed payload is logged and swallowed', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.h.bus.fire('agents:deleted', w.h.ctx(), { agentId: '' });
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });
});

describe('sweep: orphaned grants (an agent gone without a successful purge)', () => {
  /** Make the agent vanish from @ax/agents WITHOUT `agents:deleted` reaching us (a lost / failed purge). */
  function vanish(agentId: string): void {
    goneAgents.add(agentId);
  }
  /** Age every grant past the sweep's grace window (see the race test below). */
  async function ageGrants(): Promise<void> {
    await q(`UPDATE shared_folders_v1_grants SET created_at = created_at - INTERVAL '1 hour'`);
  }

  it('an orphaned owner grant passes the folder to the oldest editor; access-reduced fires', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-4', role: 'viewer' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-3', role: 'editor' });
    await sleep(5);
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await ageGrants();
    vanish('a-alice-1');
    await w.plugin.sweep();
    expect(await grantsOf(f)).toEqual({ 'a-alice-3': 'owner', 'a-alice-2': 'editor', 'a-alice-4': 'viewer' });
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-1'] }]);
    expect((await folderRow(f))!.deleted_at).toBeNull();
    // The folder is manageable again: its new owner's manager can grant.
    expect(
      await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-4', role: 'editor' }),
    ).toEqual({ changed: true });
  });

  it('an orphaned owner with no editor: the folder is tombstoned, viewers lose access, cleanup runs detached', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    await ageGrants();
    vanish('a-alice-1');
    await w.plugin.sweep();
    expect(await grantsOf(f)).toEqual({});
    expect(w.events).toHaveLength(1);
    expect([...w.events[0]!.agentIds].sort()).toEqual(['a-alice-1', 'a-alice-2']);
    expect(await cleanupSettled(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
  });

  it('a failed agents:deleted purge is healed by the next sweep', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    await ageGrants();
    // Make the subscriber's purge transaction fail: the grants table is
    // briefly unreachable while the event is delivered.
    await q('ALTER TABLE shared_folders_v1_grants RENAME TO shared_folders_v1_grants_away');
    vanish('a-alice-1');
    await w.h.bus.fire('agents:deleted', w.as('alice'), { agentId: 'a-alice-1', ownerId: 'alice', ownerType: 'user' });
    await q('ALTER TABLE shared_folders_v1_grants_away RENAME TO shared_folders_v1_grants');
    expect(w.logs.some((l) => l.msg === 'shared_folders_purge_for_deleted_agent_failed')).toBe(true);
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner', 'a-alice-2': 'editor' });
    expect(w.events).toEqual([]);

    await w.plugin.sweep();
    expect(await grantsOf(f)).toEqual({ 'a-alice-2': 'owner' });
    expect(w.events).toEqual([{ folderId: f, agentIds: ['a-alice-1'] }]);
  });

  it('grants of live agents are untouched, and nothing fires', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    await ageGrants();
    const before = await counts();
    await w.plugin.sweep();
    expect((await counts()).snapshot).toBe(before.snapshot);
    expect(w.events).toEqual([]);
    expect(listIdsCalls).toBe(1);
  });

  it('a grant newer than the grace window is left alone even if its agent is not listed (create/list race)', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    vanish('a-alice-1');
    await w.plugin.sweep();
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
    expect(w.events).toEqual([]);
    // Once it is older than the window, it is an orphan.
    await ageGrants();
    await w.plugin.sweep();
    expect(await grantsOf(f)).toEqual({});
  });

  it('bounds the agents purged per pass', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    // 51 agents @ax/agents never heard of, each holding a viewer grant —
    // alongside 52 live ones, so the orphan ratio stays under the sanity floor.
    for (let i = 0; i < 51; i++) {
      await q(
        `INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, $2, 'viewer', 'x')`,
        [f, `ghost-${String(i).padStart(2, '0')}`],
      );
    }
    for (let i = 0; i < 52; i++) {
      const id = `live-${String(i).padStart(2, '0')}`;
      extraLiveAgents.add(id);
      await q(
        `INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, $2, 'viewer', 'x')`,
        [f, id],
      );
    }
    await ageGrants();
    await w.plugin.sweep();
    expect(Object.keys(await grantsOf(f))).toHaveLength(1 + 52 + 1); // owner + live + 1 ghost left
    expect(w.events).toHaveLength(50);
    await w.plugin.sweep();
    expect(Object.keys(await grantsOf(f)).filter((id) => id.startsWith('ghost-'))).toEqual([]);
    expect(Object.keys(await grantsOf(f))).toHaveLength(1 + 52);
  });

  it('never throws: a failing agents:list-ids is logged, nothing is purged, and tombstones are still retried', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const dead = await create(w, 'alice', 'a-alice-2');
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: dead });
    await cleanupSettled(dead);
    providerMode = 'ok';
    await ageGrants();
    vanish('a-alice-1');
    listIdsFails = true;
    expect(await w.plugin.sweep(new Date(Date.now() + 2 * 60 * 60 * 1000))).toEqual({ attempted: 1, removed: 1 });
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
    expect(await folderRow(dead)).toBeUndefined();
  });

  it('a malformed agents:list-ids answer purges nothing (fail closed)', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await ageGrants();
    // An answer that would read as "no agents exist" if trusted blindly.
    listIdsMalformed = true;
    await w.plugin.sweep();
    expect(listIdsCalls).toBe(1);
    expect(await grantsOf(f)).toEqual({ 'a-alice-1': 'owner' });
  });

  // A WELL-FORMED answer can still be wrong: an empty or under-counting list
  // (a bad replica, a filtered query) would read as "these agents are gone".
  // This path only heals FAILED agents:deleted purges, so it refuses to act
  // on an implausible answer rather than tombstone folders and delete bytes.
  describe('fails closed on an implausible (but well-formed) agents:list-ids answer', () => {
    /**
     * One folder owned by a-alice-1 plus `n - 1` aged viewer grants, so there
     * are exactly `n` candidate agents: a-alice-1, g-01 … g-(n-1).
     */
    async function seed(w: World, n: number): Promise<{ f: string; agents: string[] }> {
      const f = await create(w, 'alice', 'a-alice-1');
      const agents = ['a-alice-1'];
      for (let i = 1; i < n; i++) {
        const id = `g-${String(i).padStart(2, '0')}`;
        agents.push(id);
        await q(
          `INSERT INTO shared_folders_v1_grants (folder_id, agent_id, role, granted_by_user) VALUES ($1, $2, 'viewer', 'x')`,
          [f, id],
        );
      }
      await ageGrants();
      return { f, agents };
    }
    // The sweep logs through its own system context (default stdout writer),
    // not the world's logger — capture stdout for the refusal line.
    let stdoutLines: string[] = [];
    beforeEach(() => {
      stdoutLines = [];
      const write = process.stdout.write.bind(process.stdout);
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string' && chunk.includes('shared_folders_orphan_sweep_refused')) {
          stdoutLines.push(chunk);
          return true;
        }
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    function sweepRefusals(_w: World): Record<string, unknown>[] {
      return stdoutLines
        .flatMap((c) => c.split('\n'))
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.msg === 'shared_folders_orphan_sweep_refused');
    }

    it('an empty { agentIds: [] } purges, tombstones and deletes nothing, and is logged', async () => {
      const w = await makeWorld();
      const { f } = await seed(w, 2);
      const before = await counts();
      listIdsAnswer = [];
      await w.plugin.sweep();
      expect(listIdsCalls).toBe(1);
      expect((await counts()).snapshot).toBe(before.snapshot);
      expect((await folderRow(f))!.deleted_at).toBeNull();
      expect(w.events).toEqual([]);
      await sleep(50); // no detached cleanup may have been started
      expect(providerCalls).toEqual([]);
      expect(sweepRefusals(w)).toEqual([
        expect.objectContaining({ level: 'error', reason: 'empty agents:list-ids answer', candidates: 2 }),
      ]);
    });

    it('an under-counting answer (3 of 12 candidates listed) is refused', async () => {
      const w = await makeWorld();
      const { f, agents } = await seed(w, 12);
      const before = await counts();
      listIdsAnswer = agents.slice(0, 3);
      await w.plugin.sweep();
      expect((await counts()).snapshot).toBe(before.snapshot);
      expect((await folderRow(f))!.deleted_at).toBeNull();
      expect(w.events).toEqual([]);
      expect(providerCalls).toEqual([]);
      expect(sweepRefusals(w)).toEqual([
        expect.objectContaining({ level: 'error', reason: 'implausible orphan ratio', candidates: 12, orphans: 9 }),
      ]);
    });

    it('ratio boundary: 10 candidates with 5 orphans are purged', async () => {
      const w = await makeWorld();
      const { f, agents } = await seed(w, 10);
      listIdsAnswer = agents.slice(0, 5); // a-alice-1 (owner) stays live
      await w.plugin.sweep();
      expect(Object.keys(await grantsOf(f)).sort()).toEqual(agents.slice(0, 5).sort());
      expect(w.events).toHaveLength(5);
      expect(sweepRefusals(w)).toEqual([]);
    });

    it('ratio boundary: 10 candidates with 6 orphans are refused', async () => {
      const w = await makeWorld();
      const { agents } = await seed(w, 10);
      const before = await counts();
      listIdsAnswer = agents.slice(0, 4);
      await w.plugin.sweep();
      expect((await counts()).snapshot).toBe(before.snapshot);
      expect(w.events).toEqual([]);
      expect(sweepRefusals(w)).toEqual([
        expect.objectContaining({ reason: 'implausible orphan ratio', candidates: 10, orphans: 6 }),
      ]);
    });

    it('a small legit case (3 candidates, 1 orphan) still heals', async () => {
      const w = await makeWorld();
      const { f, agents } = await seed(w, 3);
      listIdsAnswer = agents.slice(0, 2);
      await w.plugin.sweep();
      expect(Object.keys(await grantsOf(f)).sort()).toEqual(agents.slice(0, 2).sort());
      expect(w.events).toEqual([{ folderId: f, agentIds: [agents[2]] }]);
      expect(sweepRefusals(w)).toEqual([]);
    });
  });
});

describe('shared-folders:deleted', () => {
  const FAR_FUTURE = () => new Date(Date.now() + 2 * 60 * 60 * 1000);

  it('fires once on delete, AFTER the tombstone commits and before the provider is asked; not on a second delete', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    // What a subscriber can observe at fire time: the committed row, the
    // (already removed) grants, and whether the provider was asked yet.
    const seen: { tombstoned: boolean; grants: Record<string, string>; providerCalls: number }[] = [];
    w.h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'observer', async (_c, p) => {
      seen.push({
        tombstoned: (await folderRow(p.folderId))!.deleted_at !== null,
        grants: await grantsOf(p.folderId),
        providerCalls: providerCalls.length,
      });
      return undefined;
    });
    expect(await w.call('alice', 'shared-folders:delete', { folderId: f })).toEqual({ deleted: true });
    expect(w.deletedEvents).toEqual([{ folderId: f }]);
    expect(seen).toEqual([{ tombstoned: true, grants: {}, providerCalls: 0 }]);
    expect(await cleanupSettled(f)).toBeUndefined();

    // A second delete is refused and fires nothing.
    await expectRefused(w, 'alice', 'shared-folders:delete', { folderId: f }, 'folder-unavailable');
    expect(w.deletedEvents).toEqual([{ folderId: f }]);
  });

  it('two racing deletes of one folder fire it exactly once', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const results = await Promise.allSettled([
      w.call('alice', 'shared-folders:delete', { folderId: f }),
      w.call('alice', 'shared-folders:delete', { folderId: f }),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(w.deletedEvents).toEqual([{ folderId: f }]);
    await cleanupSettled(f);
  });

  it('does not fire for a refused delete', async () => {
    const w = await makeWorld();
    const f = await create(w, 'tadmin', 'a-team-1');
    await expectRefused(w, 'tmember', 'shared-folders:delete', { folderId: f }, 'cannot-manage-folder');
    expect(w.deletedEvents).toEqual([]);
  });

  it('fires for a folder tombstoned because its deleted owner left no editor — not for an ownership transfer', async () => {
    const w = await makeWorld();
    const tombstoned = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: tombstoned, agentId: 'a-alice-2', role: 'viewer' });
    const transferred = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: transferred, agentId: 'a-alice-3', role: 'editor' });
    // a-alice-1 owns both: the first has only a viewer (→ tombstoned), the
    // second has an editor (→ passes to it, folder survives).
    const a = AGENTS['a-alice-1']!;
    await w.h.bus.fire('agents:deleted', w.h.ctx(), { agentId: 'a-alice-1', ownerId: a.ownerId, ownerType: a.ownerType });
    expect(w.deletedEvents).toEqual([{ folderId: tombstoned }]);
    expect(await grantsOf(transferred)).toEqual({ 'a-alice-3': 'owner' });
    expect(await cleanupSettled(tombstoned)).toBeUndefined();
  });

  it('does not fire when a mere grantee agent is deleted', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'editor' });
    const a = AGENTS['a-alice-2']!;
    await w.h.bus.fire('agents:deleted', w.h.ctx(), { agentId: 'a-alice-2', ownerId: a.ownerId, ownerType: a.ownerType });
    expect(w.deletedEvents).toEqual([]);
  });

  it('fires for the orphan sweep’s purge too (reconcileOrphans goes through purgeAgent)', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    await w.call('alice', 'shared-folders:grant', { folderId: f, agentId: 'a-alice-2', role: 'viewer' });
    await q(`UPDATE shared_folders_v1_grants SET created_at = created_at - INTERVAL '1 hour'`);
    goneAgents.add('a-alice-1');
    await w.plugin.sweep();
    expect(w.deletedEvents).toEqual([{ folderId: f }]);
    expect(await cleanupSettled(f)).toBeUndefined();
  });

  it('the sweep re-fires it for every due tombstone, before each cleanup attempt, until the folder is cleaned', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const providerCallsAtFire: number[] = [];
    w.h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'observer', async () => {
      providerCallsAtFire.push(providerCalls.length);
      return undefined;
    });
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: f });
    await cleanupSettled(f);
    expect(w.deletedEvents).toHaveLength(1); // from the delete itself

    // Not due yet → the sweep neither retries nor re-fires.
    expect(await w.plugin.sweep(new Date())).toEqual({ attempted: 0, removed: 0 });
    expect(w.deletedEvents).toHaveLength(1);

    // Due, provider still failing → fired again, then the attempt fails again.
    expect(await w.plugin.sweep(FAR_FUTURE())).toEqual({ attempted: 1, removed: 0 });
    expect(w.deletedEvents).toEqual([{ folderId: f }, { folderId: f }]);
    // …and again on the next pass (backoff has grown, so look further ahead).
    expect(await w.plugin.sweep(new Date(Date.now() + 3 * 60 * 60 * 1000))).toEqual({ attempted: 1, removed: 0 });
    expect(w.deletedEvents).toHaveLength(3);

    // Provider recovers: fired one last time, THEN cleaned up.
    providerMode = 'ok';
    expect(await w.plugin.sweep(new Date(Date.now() + 6 * 60 * 60 * 1000))).toEqual({ attempted: 1, removed: 1 });
    expect(w.deletedEvents).toHaveLength(4);
    expect(await folderRow(f)).toBeUndefined();

    // The fire precedes the cleanup attempt of its own pass: at fire #n the
    // provider had been asked n-1 times (the delete's own attempt + earlier passes).
    expect(providerCallsAtFire).toEqual([0, 1, 2, 3]);

    // Gone for good: nothing left to re-fire.
    expect(await w.plugin.sweep(new Date(Date.now() + 12 * 60 * 60 * 1000))).toEqual({ attempted: 0, removed: 0 });
    expect(w.deletedEvents).toHaveLength(4);
  });

  it('a tombstone whose cleanup is in flight right now is not re-fired by the sweep', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const release = holdProvider();
    await Promise.race([w.call('alice', 'shared-folders:delete', { folderId: f }), sleep(3_000)]);
    await waitFor(async () => providerCalls, (c) => c.length > 0);
    expect(w.deletedEvents).toHaveLength(1);
    expect(await w.plugin.sweep(FAR_FUTURE())).toEqual({ attempted: 0, removed: 0 });
    expect(w.deletedEvents).toHaveLength(1);
    release();
    expect(await cleanupSettled(f)).toBeUndefined();
  });

  it('a throwing subscriber does not break the delete, later subscribers, or the cleanup', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    const later: SharedFoldersDeletedEvent[] = [];
    w.h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'thrower', async () => {
      throw new Error('projects store is down');
    });
    w.h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'later', async (_c, p) => {
      later.push(p);
      return undefined;
    });
    expect(await w.call('alice', 'shared-folders:delete', { folderId: f })).toEqual({ deleted: true });
    expect(later).toEqual([{ folderId: f }]);
    expect(w.logs.some((l) => l.msg === 'hook_subscriber_failed' && l.hook === 'shared-folders:deleted')).toBe(true);
    // The bytes still went and the row is gone.
    expect(await cleanupSettled(f)).toBeUndefined();
    expect(providerCalls).toEqual([f]);
  });

  it('a throwing subscriber does not break the sweep’s retry either', async () => {
    const w = await makeWorld();
    const f = await create(w, 'alice', 'a-alice-1');
    providerMode = 'fail';
    await w.call('alice', 'shared-folders:delete', { folderId: f });
    await cleanupSettled(f);
    w.h.bus.subscribe<SharedFoldersDeletedEvent>('shared-folders:deleted', 'thrower', async () => {
      throw new Error('projects store is down');
    });
    providerMode = 'ok';
    expect(await w.plugin.sweep(FAR_FUTURE())).toEqual({ attempted: 1, removed: 1 });
    expect(await folderRow(f)).toBeUndefined();
  });
});
