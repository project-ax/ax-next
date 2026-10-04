import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  answerBlobCollectRefs,
  BLOB_COLLECT_REFS_HOOK,
  BLOB_COLLECT_REFS_MAX_CANDIDATES,
  HookBus,
  makeAgentContext,
  reject,
  type AgentContext,
  type BlobRef,
  type Logger,
} from '@ax/core';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createLimitsStore, LIMITS_STORAGE_KEY, type LimitsStore } from '../config.js';
import { runDiskQuotaMigration, type DiskQuotaDatabase } from '../migrations.js';
import {
  blobFullMessage,
  STORAGE_UNAVAILABLE_MESSAGE,
  workspaceFullMessage,
} from '../messages.js';
import {
  blobCharge,
  BLOB_ALLOCATION_UNIT,
  createDiskQuotaService,
  OWNER_CACHE_MAX,
  STORAGE_FULL_REASON,
  SWEEP_CONCURRENCY,
  type DiskQuotaService,
} from '../service.js';
import { createDiskQuotaStore, type DiskQuotaStore } from '../store.js';

const MB = 1_048_576;

let container: StartedPostgreSqlContainer;
let db: Kysely<DiskQuotaDatabase>;
let realStore: DiskQuotaStore;

beforeAll(async () => {
  container = await startTestContainer(new PostgreSqlContainer('postgres:16-alpine'));
  db = new Kysely<DiskQuotaDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: container.getConnectionUri(), max: 5 }),
    }),
  });
  await runDiskQuotaMigration(db);
  realStore = createDiskQuotaStore(db);
}, 120_000);

beforeEach(async () => {
  await sql`TRUNCATE disk_quota_v1_usage, disk_quota_v1_ref_holders`.execute(db);
});

afterAll(async () => {
  await db?.destroy().catch(() => {});
  if (container) await stopPostgresContainer(container);
});

interface Line {
  level: string;
  msg: string;
  bindings?: Record<string, unknown>;
}

interface World {
  bus: HookBus;
  svc: DiskQuotaService;
  limits: LimitsStore;
  store: DiskQuotaStore;
  storage: Map<string, Uint8Array>;
  clock: { advance(ms: number): void; now(): Date };
  lines: Line[];
  ctx(userId: string, agentId?: string): AgentContext;
  /** Another host sharing the same stored setting. */
  otherHost(): LimitsStore;
  /** Set the limit through the same store the service reads. */
  setLimitMb(mb: number): Promise<void>;
  /** Put an owner at `bytes` of files. */
  seedFiles(owner: string, bytes: number): Promise<void>;
  seedWorkspace(owner: string, agentId: string, bytes: number): Promise<void>;
}

type Handler = (ctx: AgentContext, input: never) => Promise<unknown>;

function makeWorld(
  opts: {
    services?: Record<string, Handler>;
    store?: DiskQuotaStore;
    storageGetThrows?: boolean;
    /** Where the injected clock starts (ms since epoch). */
    startAt?: number;
  } = {},
): World {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
    'storage:get',
    'test',
    async (_c, { key }) => {
      if (opts.storageGetThrows) throw new Error('storage down');
      return { value: storage.get(key) };
    },
  );
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>(
    'storage:set',
    'test',
    async (_c, { key, value }) => {
      storage.set(key, value);
      return {};
    },
  );
  for (const [hook, handler] of Object.entries(opts.services ?? {})) {
    bus.registerService(hook, 'test', handler as never);
  }

  const lines: Line[] = [];
  const mk = (level: string) => (msg: string, bindings?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(bindings === undefined ? {} : { bindings }) });
  };
  const logger: Logger = {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    child: () => logger,
  };
  const ctx = (userId: string, agentId = 'agt_default') =>
    makeAgentContext({ sessionId: 's', agentId, userId, logger });

  let t = opts.startAt ?? 1_000_000;
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const limitsCtx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'system', logger });
  const limits = createLimitsStore({ bus, ctx: limitsCtx, now: clock.now, ttlMs: 1000 });
  const store = opts.store ?? realStore;
  const svc = createDiskQuotaService({ bus, store, limits, logger, now: clock.now });

  return {
    bus,
    svc,
    limits,
    store,
    storage,
    clock,
    lines,
    ctx,
    otherHost: () => createLimitsStore({ bus, ctx: limitsCtx, now: clock.now, ttlMs: 1000 }),
    async setLimitMb(mb) {
      await limits.set({ limitMb: mb });
    },
    async seedFiles(owner, bytes) {
      await realStore.upsertUsage(owner, `blob:seed-${owner}`, 'blob', bytes);
    },
    async seedWorkspace(owner, agentId, bytes) {
      await realStore.upsertUsage(owner, `workspace:${agentId}`, 'workspace', bytes);
    },
  };
}

const failingStore: DiskQuotaStore = {
  async upsertUsage() {
    throw new Error('db down');
  },
  async usageFor() {
    throw new Error('db down');
  },
  async topOwners() {
    throw new Error('db down');
  },
  async totals() {
    throw new Error('db down');
  },
  async deleteWorkspaceUsage() {
    throw new Error('db down');
  },
  async staleBlobShas() {
    throw new Error('db down');
  },
  async staleBlobRows() {
    throw new Error('db down');
  },
  async releaseBlobRows() {
    throw new Error('db down');
  },
  async listRefHolders() {
    throw new Error('db down');
  },
  async touchRefHolders() {
    throw new Error('db down');
  },
  async forgetRefHolder() {
    throw new Error('db down');
  },
};

const errorLogged = (w: World, msg: string) => w.lines.some((l) => l.level === 'error' && l.msg === msg);

describe('the blob gate', () => {
  it('admits a write that fits', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 10 * MB);
    expect(await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB)).toEqual({ ok: true });
  });

  it('refuses a write that would cross the limit, with the upload sentence naming the numbers', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 60 * MB);
    const d = await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB);
    // The sentence is for the person; the code is for whoever must react to it
    // without matching prose (an HTTP status, a specific banner).
    expect(d).toEqual({ ok: false, reason: blobFullMessage(60 * MB, 64 * MB), code: 'storage-full' });
    expect((d as { reason: string }).reason).toContain('60 MB of 64 MB');
  });

  it('lets a write land EXACTLY on the limit, and refuses one byte more', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 60 * MB);
    expect(await w.svc.admitBlobWrite(w.ctx('alice'), 4 * MB)).toEqual({ ok: true });
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 4 * MB + 1)).ok).toBe(false);
  });

  it('counts workspace bytes and file bytes against the same budget', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 40 * MB);
    await w.seedWorkspace('alice', 'agt_1', 20 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB)).ok).toBe(false);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 4 * MB)).ok).toBe(true);
  });

  it('leaves another owner alone', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 64 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 1)).ok).toBe(false);
    expect(await w.svc.admitBlobWrite(w.ctx('bob'), 60 * MB)).toEqual({ ok: true });
  });

  it('uses the default 1024 MB limit when nothing is set', async () => {
    const w = makeWorld();
    await w.seedFiles('alice', 1000 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 24 * MB)).ok).toBe(true);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 24 * MB + 1)).ok).toBe(false);
  });

  it('does not attribute (or refuse) a write with no person behind it, even a huge one', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    for (const userId of ['system', 'init', '', 'ownerless:sess-1']) {
      expect(await w.svc.admitBlobWrite(w.ctx(userId), 10 * 1024 * 1024 * MB), userId).toEqual({
        ok: true,
      });
    }
  });

  it('a person already over the limit (it was lowered) is refused even a 0-byte write', async () => {
    const w = makeWorld();
    await w.seedFiles('alice', 100 * MB);
    await w.setLimitMb(64);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 0)).ok).toBe(false);
  });

  it('treats a hostile size as 0, never as a way through', async () => {
    const w = makeWorld();
    await w.seedFiles('alice', 100 * MB);
    await w.setLimitMb(64);
    for (const bad of [Number.NaN, -1e12, Number.POSITIVE_INFINITY, 'big' as unknown as number]) {
      expect((await w.svc.admitBlobWrite(w.ctx('alice'), bad)).ok, String(bad)).toBe(false);
    }
  });

  it('takes a raised limit at once on the host that raised it', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 60 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 20 * MB)).ok).toBe(false);
    await w.limits.set({ limitMb: 128 });
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 20 * MB)).ok).toBe(true);
  });

  it('takes a limit raised on ANOTHER host once the cache window has passed, not before', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 60 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 20 * MB)).ok).toBe(false);
    await w.otherHost().set({ limitMb: 128 });
    // This host still holds the old figure for up to the cache TTL...
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 20 * MB)).ok).toBe(false);
    // ...and no longer once it has passed.
    w.clock.advance(1001);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 20 * MB)).ok).toBe(true);
  });

  it('FAILS CLOSED when the store throws: the person is told nothing was saved', async () => {
    const w = makeWorld({ store: failingStore });
    const d = await w.svc.admitBlobWrite(w.ctx('alice'), 1);
    expect(d).toEqual({ ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE });
    // "We could not check" is NOT "your storage is full": it must not carry the
    // full code, or a caller keyed on it would tell a person with plenty of room
    // to make some. (toEqual ignores an undefined key, so ask for the key itself.)
    expect('code' in d).toBe(false);
    expect(errorLogged(w, 'disk_quota_admit_failed')).toBe(true);
  });

  it('FAILS CLOSED when the limit setting cannot be read, again without the full code', async () => {
    const w = makeWorld({ storageGetThrows: true });
    const d = await w.svc.admitBlobWrite(w.ctx('alice'), 1);
    expect(d).toEqual({ ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE });
    expect('code' in d).toBe(false);
  });

  it('a corrupt stored limit falls back to the default; it does not open the gate or close it', async () => {
    const w = makeWorld();
    w.storage.set(LIMITS_STORAGE_KEY, new TextEncoder().encode('{nope'));
    await w.seedFiles('alice', 1000 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 24 * MB)).ok).toBe(true);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 25 * MB)).ok).toBe(false);
  });

  it('a broken logger cannot turn a refusal into a pass', async () => {
    const w = makeWorld({ store: failingStore });
    const bad = makeAgentContext({
      sessionId: 's',
      agentId: 'a',
      userId: 'alice',
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {
          throw new Error('logger down');
        },
        child() {
          return this;
        },
      },
    });
    expect(await w.svc.admitBlobWrite(bad, 1)).toEqual({ ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE });
  });
});

describe('the workspace gate', () => {
  it('admits under the limit and refuses over it, with the model-facing sentence', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedWorkspace('alice', 'agt_default', 60 * MB);
    expect(await w.svc.admitWorkspaceWrite(w.ctx('alice'), 4 * MB)).toEqual({ ok: true });
    const d = await w.svc.admitWorkspaceWrite(w.ctx('alice'), 4 * MB + 1);
    expect(d).toEqual({ ok: false, reason: workspaceFullMessage(60 * MB, 64 * MB), code: 'storage-full' });
  });

  it('leaves another owner alone', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedWorkspace('alice', 'agt_default', 64 * MB);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice'), 1)).ok).toBe(false);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('bob', 'agt_bob'), 1)).ok).toBe(true);
  });

  it('charges a TEAM agent to team:<id>: every member is judged by the team total, not their own', async () => {
    const w = makeWorld({
      services: {
        'agents:resolve': async (_c, input: { agentId: string; userId: string }) => ({
          agent:
            input.agentId === 'agt_team'
              ? { ownerId: 't1', ownerType: 'team' }
              : { ownerId: input.userId, ownerType: 'user' },
        }),
      },
    });
    await w.setLimitMb(64);
    await w.seedWorkspace('team:t1', 'agt_team', 64 * MB);
    await w.seedFiles('alice', 1 * MB);
    // Alice is nowhere near her own limit, but the team's repo is full.
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice', 'agt_team'), 1)).ok).toBe(false);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('bob', 'agt_team'), 1)).ok).toBe(false);
    // Her own personal agent is judged by HER total.
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice', 'agt_mine'), 1)).ok).toBe(true);
    // Her uploads are hers, unaffected by the team's repo.
    expect((await w.svc.admitBlobWrite(w.ctx('alice', 'agt_team'), 10 * MB)).ok).toBe(true);
  });

  it('falls back to the acting user when agents:resolve fails, and does not cache the failure', async () => {
    let calls = 0;
    const w = makeWorld({
      services: {
        'agents:resolve': async () => {
          calls++;
          if (calls === 1) throw new Error('resolver down');
          return { agent: { ownerId: 't9', ownerType: 'team' } };
        },
      },
    });
    expect(await w.svc.ownerOf(w.ctx('alice', 'agt_x'))).toBe('alice');
    expect(await w.svc.ownerOf(w.ctx('alice', 'agt_x'))).toBe('team:t9');
    expect(calls).toBe(2);
  });

  it('falls back to the acting user on an unusable resolve answer', async () => {
    for (const answer of [null, {}, { agent: {} }, { agent: { ownerId: '' } }, { agent: { ownerId: 5 } }]) {
      const w = makeWorld({ services: { 'agents:resolve': async () => answer } });
      expect(await w.svc.ownerOf(w.ctx('alice', 'agt_x')), JSON.stringify(answer)).toBe('alice');
    }
  });

  it('without agents:resolve at all, the acting user pays', async () => {
    const w = makeWorld();
    expect(await w.svc.ownerOf(w.ctx('alice', 'agt_x'))).toBe('alice');
  });

  it('asks agents:resolve as the acting user, once per agent (cached)', async () => {
    const seen: Array<{ agentId: string; userId: string }> = [];
    const w = makeWorld({
      services: {
        'agents:resolve': async (_c, input: { agentId: string; userId: string }) => {
          seen.push(input);
          return { agent: { ownerId: 'alice', ownerType: 'user' } };
        },
      },
    });
    await w.svc.ownerOf(w.ctx('alice', 'agt_x'));
    await w.svc.ownerOf(w.ctx('alice', 'agt_x'));
    expect(seen).toEqual([{ agentId: 'agt_x', userId: 'alice' }]);
  });

  it('clears the owner cache when it overflows, instead of growing without bound', async () => {
    let calls = 0;
    const w = makeWorld({
      services: {
        'agents:resolve': async () => {
          calls++;
          return { agent: { ownerId: 'alice', ownerType: 'user' } };
        },
      },
    });
    const ctx = w.ctx('alice');
    const at = (id: string): AgentContext => Object.assign(Object.create(ctx), { agentId: id });
    for (let i = 0; i < OWNER_CACHE_MAX; i++) await w.svc.ownerOf(at(`agt_${i}`));
    expect(calls).toBe(OWNER_CACHE_MAX);
    await w.svc.ownerOf(at('agt_0')); // still cached: the cache is exactly full
    expect(calls).toBe(OWNER_CACHE_MAX);
    await w.svc.ownerOf(at('agt_new')); // overflow: cleared
    expect(calls).toBe(OWNER_CACHE_MAX + 1);
    await w.svc.ownerOf(at('agt_0')); // gone, so it is resolved again
    expect(calls).toBe(OWNER_CACHE_MAX + 2);
  });

  it('lets a write through (with a warn) when nobody can be charged', async () => {
    const w = makeWorld({
      services: {
        'agents:resolve': async () => {
          throw new Error('no such agent');
        },
      },
    });
    await w.setLimitMb(64);
    for (const userId of ['system', 'init', '']) {
      expect(await w.svc.admitWorkspaceWrite(w.ctx(userId, 'agt_x'), 100 * MB), userId).toEqual({
        ok: true,
      });
    }
    expect(w.lines.filter((l) => l.msg === 'disk_quota_workspace_write_unattributed')).toHaveLength(3);
  });

  it('still charges the resolved owner when the acting principal is not a person', async () => {
    const w = makeWorld({
      services: {
        'agents:resolve': async () => ({ agent: { ownerId: 'alice', ownerType: 'user' } }),
      },
    });
    await w.setLimitMb(64);
    await w.seedWorkspace('alice', 'agt_x', 64 * MB);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('system', 'agt_x'), 1)).ok).toBe(false);
  });

  it('FAILS CLOSED when the store throws, without the full code', async () => {
    const w = makeWorld({ store: failingStore });
    const d = await w.svc.admitWorkspaceWrite(w.ctx('alice'), 1);
    expect(d).toEqual({ ok: false, reason: STORAGE_UNAVAILABLE_MESSAGE });
    expect('code' in d).toBe(false);
    expect(errorLogged(w, 'disk_quota_admit_failed')).toBe(true);
  });

  it('treats a hostile size as 0, never as a way through', async () => {
    const w = makeWorld();
    await w.seedWorkspace('alice', 'agt_default', 100 * MB);
    await w.setLimitMb(64);
    for (const bad of [Number.NaN, -1e12, 'x' as unknown as number]) {
      expect((await w.svc.admitWorkspaceWrite(w.ctx('alice'), bad)).ok, String(bad)).toBe(false);
    }
  });
});

// The front door (chat:start). The write gates are the hard guard; but the
// runner's end-of-turn save happens AFTER the reply is shown and its refusal
// reason is never surfaced there, so a full person would lose files silently.
// Turning the NEXT message away with a clear sentence is how they find out.
describe('the turn gate (chat:start)', () => {
  it('admits a person with room to spare, and one who is close but not full', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 63 * MB);
    expect(await w.svc.admitTurn(w.ctx('alice'))).toEqual({ ok: true });
  });

  it("refuses a full person's turn with the stable code, and only THEIRS", async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 64 * MB);
    expect(await w.svc.admitTurn(w.ctx('alice'))).toEqual({ ok: false, reason: STORAGE_FULL_REASON });
    expect(STORAGE_FULL_REASON).toBe('storage-full');
    expect(await w.svc.admitTurn(w.ctx('bob'))).toEqual({ ok: true });
  });

  it('counts workspace and file bytes together, like the write gates', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 30 * MB);
    await w.seedWorkspace('alice', 'agt_1', 34 * MB);
    expect((await w.svc.admitTurn(w.ctx('alice', 'agt_1'))).ok).toBe(false);
  });

  it("charges a team agent's turn to the team, so every member is judged by the team total", async () => {
    const w = makeWorld({
      services: {
        'agents:resolve': (async () => ({
          agent: { ownerId: 'team-9', ownerType: 'team' },
        })) as Handler,
      },
    });
    await w.setLimitMb(64);
    await w.seedWorkspace('team:team-9', 'agt_team', 64 * MB);
    expect((await w.svc.admitTurn(w.ctx('alice', 'agt_team'))).ok).toBe(false);
    expect((await w.svc.admitTurn(w.ctx('bob', 'agt_team'))).ok).toBe(false);
  });

  it('admits a turn with nobody to charge (a system run)', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    expect(await w.svc.admitTurn(w.ctx('system'))).toEqual({ ok: true });
  });

  it('takes a raised limit straight away', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 64 * MB);
    expect((await w.svc.admitTurn(w.ctx('alice'))).ok).toBe(false);
    await w.limits.set({ limitMb: 128 });
    expect((await w.svc.admitTurn(w.ctx('alice'))).ok).toBe(true);
  });

  it('FAILS OPEN when the check itself breaks (the write gates, which fail closed, still guard the disk), and says so', async () => {
    const w = makeWorld({ store: failingStore });
    expect(await w.svc.admitTurn(w.ctx('alice'))).toEqual({ ok: true });
    expect(w.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_turn_check_failed')).toBe(true);
    // ...while the same broken store still refuses a WRITE.
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 1)).ok).toBe(false);
  });
});

// The fs blob backend stores ONE FILE PER BLOB, so a 100-byte blob costs the
// volume a whole block and an inode. Charging logical bytes let a looping agent
// create millions of tiny artifacts "inside" its quota and exhaust the shared
// volume's inodes (review finding). Each blob is therefore charged in whole
// allocation units, the same currency the workspace meter already counts in
// (allocated bytes).
describe('blobs are charged by what they occupy, not by their logical size', () => {
  it('blobCharge rounds up to whole 4 KiB units, with a floor of one unit (even for an empty blob)', () => {
    expect(BLOB_ALLOCATION_UNIT).toBe(4096);
    expect(blobCharge(0)).toBe(4096);
    expect(blobCharge(1)).toBe(4096);
    expect(blobCharge(100)).toBe(4096);
    expect(blobCharge(4096)).toBe(4096);
    expect(blobCharge(4097)).toBe(8192);
    expect(blobCharge(5 * MB)).toBe(5 * MB);
    // Hostile sizes are never a way to be charged less than one unit.
    for (const bad of [Number.NaN, -5, Number.NEGATIVE_INFINITY, 'x' as unknown as number]) {
      expect(blobCharge(bad), String(bad)).toBe(4096);
    }
  });

  it('records the rounded charge, so many tiny blobs add up to what they really cost', async () => {
    const w = makeWorld();
    for (let i = 0; i < 20; i++) {
      await w.svc.recordBlobStored(w.ctx('alice'), { sha256: String(i).padStart(64, '0'), size: 1 });
    }
    expect(await realStore.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 20 * 4096 });
  });

  it('gates on the rounded charge: a 100-byte blob does not fit in 1000 bytes of room', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 64 * MB - 1000);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 100)).ok).toBe(false);
    // ...but does fit when one whole unit of room is left.
    await w.seedFiles('alice', 64 * MB - 4096);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 100)).ok).toBe(true);
    await w.svc.recordBlobStored(w.ctx('alice'), { sha256: 'e'.repeat(64), size: 100 });
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 1)).ok).toBe(false);
  });

  it('leaves the workspace gate alone: it sizes a commit by its own figure, not per file', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedFiles('alice', 64 * MB - 1000);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice'), 100)).ok).toBe(true);
  });
});

describe('recordBlobStored (the meter)', () => {
  const sha = (c: string) => c.repeat(64);

  it('charges the writer, once per sha however often it is re-stored', async () => {
    const w = makeWorld();
    for (let i = 0; i < 3; i++) {
      await w.svc.recordBlobStored(w.ctx('alice'), { sha256: sha('a'), size: 7 * MB });
    }
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 7 * MB });
  });

  it('charges two owners who store the same bytes EACH, and different shas add up', async () => {
    const w = makeWorld();
    await w.svc.recordBlobStored(w.ctx('alice'), { sha256: sha('a'), size: 7 * MB });
    await w.svc.recordBlobStored(w.ctx('bob'), { sha256: sha('a'), size: 7 * MB });
    await w.svc.recordBlobStored(w.ctx('alice'), { sha256: sha('b'), size: 1 * MB });
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 8 * MB });
    expect(await w.store.usageFor('bob')).toEqual({ workspaceBytes: 0, fileBytes: 7 * MB });
  });

  it('records nothing for a context with no person behind it', async () => {
    const w = makeWorld();
    for (const userId of ['system', 'init', '', 'ownerless:s']) {
      await w.svc.recordBlobStored(w.ctx(userId), { sha256: sha('a'), size: 7 * MB });
    }
    expect(await w.store.topOwners(10)).toEqual([]);
  });

  it('ignores a malformed payload, with a warn, and never throws', async () => {
    const w = makeWorld();
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      {},
      { sha256: '', size: 1 },
      { sha256: 5, size: 1 },
      { sha256: 'x'.repeat(129), size: 1 },
      { sha256: sha('a') },
      { sha256: sha('a'), size: -1 },
      { sha256: sha('a'), size: Number.NaN },
      { sha256: sha('a'), size: '9' },
    ];
    for (const payload of bad) {
      await expect(w.svc.recordBlobStored(w.ctx('alice'), payload)).resolves.toBeUndefined();
    }
    expect(await w.store.topOwners(10)).toEqual([]);
    expect(w.lines.filter((l) => l.msg === 'disk_quota_blob_stored_invalid').length).toBeGreaterThan(0);
  });

  it('SWALLOWS a store failure (a meter never fails an upload) and logs it', async () => {
    const w = makeWorld({ store: failingStore });
    await expect(
      w.svc.recordBlobStored(w.ctx('alice'), { sha256: sha('a'), size: 1 }),
    ).resolves.toBeUndefined();
    expect(errorLogged(w, 'disk_quota_record_failed')).toBe(true);
  });

  it('a recorded blob then counts against the next admit', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.svc.recordBlobStored(w.ctx('alice'), { sha256: sha('a'), size: 60 * MB });
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB)).ok).toBe(false);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 4 * MB)).ok).toBe(true);
  });
});

describe('the workspace meter (scheduleWorkspaceMeasure + drain)', () => {
  const usageOf = (bytesByAgent: Record<string, number>): Record<string, Handler> => ({
    'workspace:usage': async (c) => ({ bytes: bytesByAgent[c.agentId] ?? 0 }),
  });

  it('measures the agent named by the context, in the background, and records it for its owner', async () => {
    const seen: Array<{ agentId: string; userId: string }> = [];
    const w = makeWorld({
      services: {
        'workspace:usage': async (c) => {
          seen.push({ agentId: c.agentId, userId: c.userId });
          return { bytes: 12 * MB };
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await w.svc.drain();
    expect(seen).toEqual([{ agentId: 'agt_1', userId: 'alice' }]);
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 12 * MB, fileBytes: 0 });
  });

  it('does not make the caller wait: scheduling returns before the measurement runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = makeWorld({
      services: {
        'workspace:usage': async () => {
          await gate;
          return { bytes: 5 };
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 0 });
    release();
    await w.svc.drain();
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(5);
  });

  it('REPLACES the previous figure (it is a re-measure, not an increment)', async () => {
    let bytes = 10 * MB;
    const w = makeWorld({ services: { 'workspace:usage': async () => ({ bytes }) } });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await w.svc.drain();
    bytes = 3 * MB;
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await w.svc.drain();
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(3 * MB);
  });

  it('charges a team agent to team:<id> and leaves the acting user\'s own rows untouched', async () => {
    const w = makeWorld({
      services: {
        ...usageOf({ agt_team: 30 * MB }),
        'agents:resolve': async () => ({ agent: { ownerId: 't1', ownerType: 'team' } }),
      },
    });
    await w.seedFiles('alice', 2 * MB);
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_team'));
    await w.svc.drain();
    expect(await w.store.usageFor('team:t1')).toEqual({ workspaceBytes: 30 * MB, fileBytes: 0 });
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 2 * MB });
  });

  it('charges the acting user when agents:resolve fails', async () => {
    const w = makeWorld({
      services: {
        ...usageOf({ agt_x: 9 * MB }),
        'agents:resolve': async () => {
          throw new Error('resolver down');
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_x'));
    await w.svc.drain();
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 9 * MB, fileBytes: 0 });
  });

  it('measures nothing when workspace:usage is absent, and says nothing about it (not counted, not an error)', async () => {
    const w = makeWorld();
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await w.svc.drain();
    expect(await w.store.topOwners(10)).toEqual([]);
    // A backend without workspace:usage is a supported deployment, not a fault:
    // it must not put a warning in the log on every write.
    expect(w.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('skips a context with no usable agent, or nobody to charge', async () => {
    let calls = 0;
    const w = makeWorld({
      services: {
        'workspace:usage': async () => {
          calls++;
          return { bytes: 1 };
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', ''));
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'ownerless:s1'));
    w.svc.scheduleWorkspaceMeasure(w.ctx('system', 'agt_1'));
    await w.svc.drain();
    expect(calls).toBe(0);
    expect(await w.store.topOwners(10)).toEqual([]);
  });

  it('records nothing for an unusable figure, with a warn', async () => {
    for (const answer of [{ bytes: -1 }, { bytes: Number.NaN }, { bytes: '5' }, {}, null]) {
      const w = makeWorld({ services: { 'workspace:usage': async () => answer } });
      w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
      await w.svc.drain();
      expect(await w.store.topOwners(10), JSON.stringify(answer)).toEqual([]);
      expect(w.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_usage_invalid')).toBe(true);
    }
  });

  it('SWALLOWS a measurement failure and a store failure (warn), and drain still resolves', async () => {
    const w1 = makeWorld({
      services: {
        'workspace:usage': async () => {
          throw new Error('disk gone');
        },
      },
    });
    w1.svc.scheduleWorkspaceMeasure(w1.ctx('alice', 'agt_1'));
    await expect(w1.svc.drain()).resolves.toBeUndefined();
    expect(w1.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_measure_failed')).toBe(true);

    const w2 = makeWorld({ store: failingStore, services: usageOf({ agt_1: 5 }) });
    w2.svc.scheduleWorkspaceMeasure(w2.ctx('alice', 'agt_1'));
    await expect(w2.svc.drain()).resolves.toBeUndefined();
    expect(w2.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_measure_failed')).toBe(true);
  });

  it('a write landing mid-measurement gets a fresh measurement AFTER it, so a stale reading is never last', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const w = makeWorld({
      services: {
        'workspace:usage': async () => {
          const n = ++calls;
          if (n === 1) {
            await gate; // the slow, stale reading
            return { bytes: 10 };
          }
          return { bytes: 99 };
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await new Promise((r) => setTimeout(r, 10)); // the first call is now in flight
    // Three more writes land while it runs: they coalesce into ONE re-measure.
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    release();
    await w.svc.drain();
    expect(calls).toBe(2);
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(99);
  });

  it('different agents measure independently and in parallel', async () => {
    const w = makeWorld({ services: usageOf({ agt_1: 1, agt_2: 2 }) });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_2'));
    await w.svc.drain();
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(3);
  });

  it('a measured workspace then counts against the next admit', async () => {
    const w = makeWorld({ services: usageOf({ agt_1: 64 * MB }) });
    await w.setLimitMb(64);
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice', 'agt_1'), 1)).ok).toBe(true);
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await w.svc.drain();
    expect((await w.svc.admitWorkspaceWrite(w.ctx('alice', 'agt_1'), 1)).ok).toBe(false);
  });
});

// An agent delete removes its repo, so the bytes are really free. Nothing else
// ever takes a workspace row out (the sweep only upserts, by design), so without
// this the owner stays charged for a workspace that no longer exists.
describe('releaseWorkspace (an agent was deleted)', () => {
  it("drops that agent's row: the owner's usage falls by exactly those bytes, and other agents stay", async () => {
    const w = makeWorld();
    await w.seedWorkspace('alice', 'agt_1', 30 * MB);
    await w.seedWorkspace('alice', 'agt_2', 5 * MB);
    await w.seedFiles('alice', 2 * MB);
    await w.svc.releaseWorkspace('agt_1');
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 5 * MB, fileBytes: 2 * MB });
  });

  it('frees room: a write the full gate refused is admitted once the workspace is gone', async () => {
    const w = makeWorld();
    await w.setLimitMb(64);
    await w.seedWorkspace('alice', 'agt_1', 64 * MB);
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB)).ok).toBe(false);
    expect((await w.svc.admitTurn(w.ctx('alice'))).ok).toBe(false);
    await w.svc.releaseWorkspace('agt_1');
    expect((await w.svc.admitBlobWrite(w.ctx('alice'), 5 * MB)).ok).toBe(true);
    expect((await w.svc.admitTurn(w.ctx('alice'))).ok).toBe(true);
  });

  it("keys on the agent alone: a team's row goes too, with no owner lookup at all", async () => {
    // No agents:resolve is registered (and the agent is already deleted, so it
    // could not resolve anyway): the row is found by its source, not its owner.
    const w = makeWorld();
    await w.seedWorkspace('team:t1', 'agt_team', 30 * MB);
    await w.seedWorkspace('alice', 'agt_team', 1 * MB); // a fallback-charged copy
    await w.seedWorkspace('team:t1', 'agt_other', 4 * MB);
    await w.svc.releaseWorkspace('agt_team');
    expect(await w.store.usageFor('team:t1')).toEqual({ workspaceBytes: 4 * MB, fileBytes: 0 });
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 0 });
  });

  it('is idempotent and harmless for an agent that was never measured', async () => {
    const w = makeWorld();
    await w.seedWorkspace('alice', 'agt_1', 3 * MB);
    await w.svc.releaseWorkspace('agt_1');
    await w.svc.releaseWorkspace('agt_1');
    await w.svc.releaseWorkspace('agt_never');
    expect(await w.store.topOwners(10)).toEqual([]);
    expect(w.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('deletes nothing for an id that is not one, and never throws', async () => {
    const w = makeWorld();
    await w.seedWorkspace('alice', 'agt_1', 3 * MB);
    for (const bad of [undefined, null, '', 5, {}, ['agt_1'], true]) {
      await expect(w.svc.releaseWorkspace(bad), String(bad)).resolves.toBeUndefined();
    }
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 3 * MB, fileBytes: 0 });
    expect(w.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_workspace_deleted_invalid')).toBe(
      true,
    );
  });

  it('SWALLOWS a store failure (a delete must never fail because of the ledger) and logs it', async () => {
    const w = makeWorld({ store: failingStore });
    await expect(w.svc.releaseWorkspace('agt_1')).resolves.toBeUndefined();
    expect(errorLogged(w, 'disk_quota_release_failed')).toBe(true);
    // The row is now left behind and keeps charging the owner, and nothing else
    // repairs it, so this is the one line an operator acts on: it must say WHICH
    // agent. (The line's own context is the plugin's, so the id can only come
    // from the bindings.)
    const line = w.lines.find((l) => l.level === 'error' && l.msg === 'disk_quota_release_failed');
    expect(line?.bindings).toMatchObject({ agentId: 'agt_1' });
    expect(line?.bindings?.err).toBeInstanceOf(Error);
  });

  it('waits out a measurement already in flight, so a stale figure cannot re-create the row after the delete', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    const w = makeWorld({
      services: {
        'workspace:usage': async () => {
          started = true;
          await gate; // measuring the repo as it was BEFORE the delete
          return { bytes: 40 * MB };
        },
      },
    });
    w.svc.scheduleWorkspaceMeasure(w.ctx('alice', 'agt_1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);

    const released = w.svc.releaseWorkspace('agt_1');
    release(); // the stale reading now lands and is upserted...
    await released; // ...and the delete runs AFTER it
    await w.svc.drain();
    expect(await w.store.topOwners(10)).toEqual([]);
  });
});

describe('reconcile (the sweep)', () => {
  const personal = (agents: Array<{ agentId: string; ownerUserId: string }>) => ({
    'agents:list-personal-owners': async () => ({ agents }),
  });

  it('backfills every personal agent\'s workspace from workspace:usage', async () => {
    const asked: Array<{ agentId: string; userId: string; sessionId: string }> = [];
    const bytes: Record<string, number> = { a1: 10 * MB, a2: 5 * MB, b1: 7 * MB };
    const w = makeWorld({
      services: {
        ...personal([
          { agentId: 'a1', ownerUserId: 'alice' },
          { agentId: 'a2', ownerUserId: 'alice' },
          { agentId: 'b1', ownerUserId: 'bob' },
        ]),
        'workspace:usage': async (c) => {
          asked.push({ agentId: c.agentId, userId: c.userId, sessionId: c.sessionId });
          return { bytes: bytes[c.agentId] };
        },
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 3, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 15 * MB, fileBytes: 0 });
    expect(await w.store.usageFor('bob')).toEqual({ workspaceBytes: 7 * MB, fileBytes: 0 });
    // Each agent is measured AS its owner, in a sweep session of its own.
    expect(asked.sort((x, y) => x.agentId.localeCompare(y.agentId))).toEqual([
      { agentId: 'a1', userId: 'alice', sessionId: 'disk-quota-sweep' },
      { agentId: 'a2', userId: 'alice', sessionId: 'disk-quota-sweep' },
      { agentId: 'b1', userId: 'bob', sessionId: 'disk-quota-sweep' },
    ]);
  });

  it('is idempotent, repairs drift, and never deletes a row', async () => {
    let bytes = 10 * MB;
    const w = makeWorld({
      services: {
        ...personal([{ agentId: 'a1', ownerUserId: 'alice' }]),
        'workspace:usage': async () => ({ bytes }),
      },
    });
    await w.seedWorkspace('alice', 'a1', 999 * MB); // drifted
    await w.seedWorkspace('alice', 'gone-agent', 4 * MB); // no longer listed
    await w.seedFiles('alice', 1 * MB);
    await w.svc.reconcile();
    await w.svc.reconcile();
    expect(await w.store.usageFor('alice')).toEqual({ workspaceBytes: 14 * MB, fileBytes: 1 * MB });
    bytes = 2 * MB;
    await w.svc.reconcile();
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(6 * MB);
  });

  it('skips entirely (measured 0, no calls) when either hook is absent', async () => {
    const calls: string[] = [];
    const listOnly = makeWorld({
      services: {
        'agents:list-personal-owners': async () => {
          calls.push('list');
          return { agents: [{ agentId: 'a1', ownerUserId: 'alice' }] };
        },
      },
    });
    expect(await listOnly.svc.reconcile()).toEqual({ measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false });

    const usageOnly = makeWorld({
      services: {
        'workspace:usage': async () => {
          calls.push('usage');
          return { bytes: 1 };
        },
      },
    });
    expect(await usageOnly.svc.reconcile()).toEqual({ measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false });

    const neither = makeWorld();
    expect(await neither.svc.reconcile()).toEqual({ measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    expect(calls).toEqual([]);
    expect(await realStore.topOwners(10)).toEqual([]);
  });

  it('one failing agent does not stop the rest', async () => {
    const w = makeWorld({
      services: {
        ...personal([
          { agentId: 'a1', ownerUserId: 'alice' },
          { agentId: 'a2', ownerUserId: 'alice' },
          { agentId: 'a3', ownerUserId: 'alice' },
          { agentId: 'a4', ownerUserId: 'bob' },
        ]),
        'workspace:usage': async (c) => {
          if (c.agentId === 'a2') throw new Error('repo unreadable');
          if (c.agentId === 'a3') return { bytes: -5 };
          return { bytes: 1 * MB };
        },
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 2, failed: 2, blobsReleased: 0, blobReleaseAborted: false });
    expect((await w.store.usageFor('alice')).workspaceBytes).toBe(1 * MB);
    expect((await w.store.usageFor('bob')).workspaceBytes).toBe(1 * MB);
    expect(w.lines.some((l) => l.level === 'warn' && l.msg === 'disk_quota_measure_failed')).toBe(true);
  });

  it('measures at most two agents at a time, and does use both', async () => {
    let running = 0;
    let peak = 0;
    const agents = Array.from({ length: 8 }, (_, i) => ({ agentId: `a${i}`, ownerUserId: `u${i}` }));
    const w = makeWorld({
      services: {
        ...personal(agents),
        'workspace:usage': async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 15));
          running--;
          return { bytes: 1 };
        },
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 8, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    expect(SWEEP_CONCURRENCY).toBe(2);
    expect(peak).toBe(2);
  });

  it('returns quietly when listing the agents fails', async () => {
    const w = makeWorld({
      services: {
        'agents:list-personal-owners': async () => {
          throw new Error('agents down');
        },
        'workspace:usage': async () => ({ bytes: 1 }),
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
  });

  it('ignores malformed list entries', async () => {
    const w = makeWorld({
      services: {
        'agents:list-personal-owners': async () => ({
          agents: [
            null,
            {},
            { agentId: 'a1' },
            { agentId: '', ownerUserId: 'alice' },
            { agentId: 'ownerless:s', ownerUserId: 'alice' },
            { agentId: 'a2', ownerUserId: 'system' },
            { agentId: 'ok', ownerUserId: 'alice' },
          ],
        }),
        'workspace:usage': async () => ({ bytes: 1 * MB }),
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 1, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
    expect(await w.store.topOwners(10)).toEqual([{ ownerId: 'alice', workspaceBytes: MB, fileBytes: 0 }]);
  });

  it('tolerates a list that is not an array', async () => {
    const w = makeWorld({
      services: {
        'agents:list-personal-owners': async () => ({ agents: 'nope' }),
        'workspace:usage': async () => ({ bytes: 1 }),
      },
    });
    expect(await w.svc.reconcile()).toEqual({ measured: 0, failed: 0, blobsReleased: 0, blobReleaseAborted: false });
  });
});

// ---------------------------------------------------------------------------
// The blob pass (design D6): release an (owner, blob:<sha>) charge once the row
// is past the grace window AND every holder agrees that owner no longer holds
// the sha. It fails CLOSED: any doubt releases nothing.
// ---------------------------------------------------------------------------
describe('the blob pass (reconcile releases blob charges nobody holds)', () => {
  const HOUR = 3_600_000;
  const S = 'a'.repeat(64);
  const T = 'b'.repeat(64);

  /** A world whose clock starts at the real time (rows are stamped by the db's now()). */
  const blobWorld = (opts: Parameters<typeof makeWorld>[0] = {}) =>
    makeWorld({ startAt: Date.now(), ...opts });

  type Answer = BlobRef[] | 'throw' | 'fail';

  /** A holder that answers through the real helper, as a holder plugin does. */
  function holder(w: World, name: string, answer: (candidates: string[]) => Answer): string[][] {
    const asked: string[][] = [];
    w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, name, async (_c, payload) => {
      const candidates = (payload as { candidates: string[] }).candidates;
      asked.push([...candidates]);
      const a = answer(candidates);
      if (a === 'throw') throw new Error(`${name} crashed`);
      return answerBlobCollectRefs(payload, name, async () => {
        if (a === 'fail') throw new Error('query failed');
        return a;
      });
    });
    return asked;
  }

  async function charge(owner: string, sha: string): Promise<void> {
    await realStore.upsertUsage(owner, `blob:${sha}`, 'blob', 4096);
  }

  /** `owner blob:<first hex char>` per row, sorted. */
  async function rows(): Promise<string[]> {
    const r = await db.selectFrom('disk_quota_v1_usage').select(['owner_id', 'source']).execute();
    return r.map((x) => `${x.owner_id} ${x.source.slice(0, 'blob:'.length + 1)}`).sort();
  }

  const aborted = (w: World) => w.lines.find((l) => l.msg === 'disk_quota_blob_release_aborted');

  it("releases A's charge and keeps B's when only B still holds the identical bytes", async () => {
    const w = blobWorld();
    holder(w, '@ax/attachments', () => [{ sha256: S, userIds: ['bob'] }]);
    await charge('alice', S);
    await charge('bob', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toEqual({
      measured: 0,
      failed: 0,
      blobsReleased: 1,
      blobReleaseAborted: false,
    });
    expect(await rows()).toEqual(['bob blob:a']);
    expect(await realStore.usageFor('alice')).toEqual({ workspaceBytes: 0, fileBytes: 0 });
    expect(w.lines.some((l) => l.msg === 'disk_quota_blob_release_done')).toBe(true);
  });

  it('runs even though the workspace sweep is skipped (its optional hooks are absent)', async () => {
    const w = blobWorld();
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    const r = await w.svc.reconcile();
    expect(r).toMatchObject({ measured: 0, blobsReleased: 1, blobReleaseAborted: false });
    expect(w.lines.some((l) => l.msg === 'disk_quota_sweep_skipped')).toBe(true);
  });

  it('leaves rows inside the grace window alone, and never even asks about them', async () => {
    const w = blobWorld();
    const asked = holder(w, '@ax/attachments', () => []);
    await charge('alice', S);
    expect((await w.svc.reconcile()).blobsReleased).toBe(0);
    w.clock.advance(23 * HOUR);
    expect((await w.svc.reconcile()).blobsReleased).toBe(0);
    expect(asked.every((c) => c.length === 0)).toBe(true);
    expect(await rows()).toEqual(['alice blob:a']);
    w.clock.advance(2 * HOUR);
    expect((await w.svc.reconcile()).blobsReleased).toBe(1);
    expect(asked.at(-1)).toEqual([S]);
    expect(await rows()).toEqual([]);
  });

  it('reads the grace window from the admin setting', async () => {
    const w = blobWorld();
    await w.limits.set({ graceMs: HOUR });
    await charge('alice', S);
    w.clock.advance(2 * HOUR);
    expect((await w.svc.reconcile()).blobsReleased).toBe(1);
  });

  it('an empty pass still asks the holders, so the roster fills before anything is stale', async () => {
    const w = blobWorld();
    const asked = holder(w, '@ax/attachments', () => []);
    await charge('alice', S); // fresh: not a candidate yet
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: false });
    expect(asked).toEqual([[]]);
    expect(await realStore.listRefHolders()).toEqual(['@ax/attachments']);
  });

  it('FAIL CLOSED: a holder that answered before and now throws aborts with nothing released', async () => {
    const w = blobWorld();
    let crash = false;
    holder(w, '@ax/attachments', () => (crash ? 'throw' : []));
    await charge('alice', S);
    await charge('bob', T);
    await w.svc.reconcile(); // empty pass: @ax/attachments joins the roster
    crash = true;
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: true });
    expect(await rows()).toEqual(['alice blob:a', 'bob blob:b']);
    expect(aborted(w)?.bindings).toMatchObject({ missing: ['@ax/attachments'], failed: [] });
  });

  it('FAIL CLOSED: a roster member that is no longer loaded aborts until it is forgotten', async () => {
    const w = blobWorld();
    holder(w, '@ax/attachments', () => []);
    await realStore.touchRefHolders(['@ax/retired-plugin']);
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: true });
    expect(await rows()).toEqual(['alice blob:a']);
    expect(aborted(w)?.level).toBe('error');
    expect(aborted(w)?.bindings).toMatchObject({ missing: ['@ax/retired-plugin'] });
    // Forgetting it (the admin route's job) lets the next pass go ahead.
    await realStore.forgetRefHolder('@ax/retired-plugin');
    expect((await w.svc.reconcile()).blobsReleased).toBe(1);
  });

  it('FAIL CLOSED: a holder answering ok:false aborts (and still joins the roster)', async () => {
    const w = blobWorld();
    holder(w, '@ax/attachments', () => []);
    holder(w, '@ax/skills', () => 'fail');
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: true });
    expect(await rows()).toEqual(['alice blob:a']);
    expect(aborted(w)?.bindings).toMatchObject({ failed: ['@ax/skills'], missing: [] });
    expect(await realStore.listRefHolders()).toEqual(['@ax/attachments', '@ax/skills']);
  });

  it('FAIL CLOSED: a malformed answer aborts', async () => {
    const w = blobWorld();
    holder(w, '@ax/attachments', () => []);
    w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, 'rogue', async (_c, payload) => {
      const p = payload as { answers: unknown[] };
      return { ...p, answers: [...p.answers, { ok: true, refs: [] }] };
    });
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: true });
    expect(await rows()).toEqual(['alice blob:a']);
    expect(aborted(w)?.bindings).toMatchObject({ malformed: 1 });
  });

  it('FAIL CLOSED: a rejected fire aborts', async () => {
    const w = blobWorld();
    holder(w, '@ax/attachments', () => []);
    w.bus.subscribe<unknown>(BLOB_COLLECT_REFS_HOOK, 'vetoer', async () => reject({ reason: 'no' }));
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 0, blobReleaseAborted: true });
    expect(await rows()).toEqual(['alice blob:a']);
    expect(aborted(w)?.bindings).toMatchObject({ rejected: true });
  });

  it('an unattributed ref (userIds: []) releases nothing for that sha; other shas still go', async () => {
    const w = blobWorld();
    holder(w, '@ax/skills', () => [{ sha256: S, userIds: [] }]);
    holder(w, '@ax/attachments', () => [{ sha256: S, userIds: ['bob'] }]);
    await charge('alice', S);
    await charge('bob', S);
    await charge('alice', T);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 1, blobReleaseAborted: false });
    expect(await rows()).toEqual(['alice blob:a', 'bob blob:a']);
  });

  it('never offers (or releases) a blob row whose source is not a sha256', async () => {
    const w = blobWorld();
    const asked = holder(w, '@ax/attachments', () => []);
    await realStore.upsertUsage('alice', 'blob:seed', 'blob', 1);
    await charge('alice', S);
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 1, blobReleaseAborted: false });
    expect(asked.at(-1)).toEqual([S]);
    const left = await db.selectFrom('disk_quota_v1_usage').select('source').execute();
    expect(left.map((r) => r.source)).toEqual(['blob:seed']);
  });

  it('asks in batches of at most 1000 shas; an aborting batch stops the pass, earlier releases stand', async () => {
    const w = blobWorld();
    const n = BLOB_COLLECT_REFS_MAX_CANDIDATES + 5;
    await sql`
      INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes)
      SELECT 'alice', 'blob:' || encode(sha256(i::text::bytea), 'hex'), 'blob', 4096
      FROM generate_series(1, ${n}::int) AS i
    `.execute(db);
    let stale = 0;
    const asked = holder(w, '@ax/attachments', (c) => {
      if (c.length === 0) return [];
      stale++;
      return stale === 1 ? [] : 'fail';
    });
    w.clock.advance(25 * HOUR);
    expect(await w.svc.reconcile()).toEqual({
      measured: 0,
      failed: 0,
      blobsReleased: BLOB_COLLECT_REFS_MAX_CANDIDATES,
      blobReleaseAborted: true,
    });
    expect(asked.map((c) => c.length)).toEqual([BLOB_COLLECT_REFS_MAX_CANDIDATES, 5]);
    expect((await rows()).length).toBe(5);
    // Next pass: the holder is healthy again and the tail goes.
    stale = 0;
    expect(await w.svc.reconcile()).toMatchObject({ blobsReleased: 5, blobReleaseAborted: false });
  });

  it('never throws: a broken store or setting is an aborted pass with nothing released', async () => {
    const broken = blobWorld({ store: failingStore });
    expect(await broken.svc.reconcile()).toEqual({
      measured: 0,
      failed: 0,
      blobsReleased: 0,
      blobReleaseAborted: true,
    });
    const noSetting = blobWorld({ storageGetThrows: true });
    await charge('alice', S);
    noSetting.clock.advance(25 * HOUR);
    expect(await noSetting.svc.reconcile()).toMatchObject({
      blobsReleased: 0,
      blobReleaseAborted: true,
    });
    expect(await rows()).toEqual(['alice blob:a']);
  });
});
