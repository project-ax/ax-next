import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { AgentContext, ServiceHandler } from '@ax/core';
import { stopPostgresContainer, startTestContainer } from '@ax/test-harness';
import { Kysely, sql } from 'kysely';
import { LIMITS_STORAGE_KEY } from '../config.js';
import { bootDiskQuota, MB, truncateDiskQuotaTables, type Booted } from './helpers.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const booted: Booted[] = [];

async function boot(services: Record<string, ServiceHandler> = {}): Promise<Booted> {
  const b = await bootDiskQuota({ connectionString, services });
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

/** Store `size` bytes of files for `userId` through the real blob:stored subscriber. */
async function storeFiles(b: Booted, userId: string, size: number, c = 'a'): Promise<void> {
  await b.harness.bus.fire('blob:stored', b.harness.ctx({ userId }), { sha256: sha(c), size });
}

async function mine(b: Booted, userId: string) {
  b.setAuth({ id: userId, isAdmin: false });
  return b.request('GET', '/settings/storage');
}

describe('auth', () => {
  it('401 unauthenticated on every route, and 403 (never on /settings) for a non-admin', async () => {
    const b = await boot();
    const calls: Array<[string, string]> = [
      ['GET', '/settings/storage'],
      ['GET', '/admin/storage'],
      ['PUT', '/admin/storage/limits'],
      ['POST', '/admin/storage/ref-holders/forget'],
    ];
    b.setAuth('throw');
    for (const [m, p] of calls) {
      const r = await b.request(m, p);
      expect(r, `${m} ${p}`).toEqual({ status: 401, json: { error: 'unauthenticated' } });
    }
    b.setAuth({ id: 'u9', isAdmin: false });
    for (const [m, p] of calls.slice(1)) {
      const r = await b.request(m, p);
      expect(r, `${m} ${p}`).toEqual({ status: 403, json: { error: 'forbidden' } });
    }
    // A non-admin is allowed on their own view.
    expect((await b.request('GET', '/settings/storage')).status).toBe(200);
  });

  it('a non-admin cannot change the limits: nothing is written', async () => {
    const b = await boot();
    b.setAuth({ id: 'u9', isAdmin: false });
    const r = await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64 } });
    expect(r.status).toBe(403);
    expect(b.storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });

  it('registers the mutating route with a 4 KiB body cap', async () => {
    const b = await boot();
    expect(b.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/storage',
      'GET /settings/storage',
      'POST /admin/storage/ref-holders/forget',
      'PUT /admin/storage/limits',
    ]);
    for (const r of b.routes.filter((x) => x.method !== 'GET')) expect(r.maxBodyBytes).toBe(4096);
  });
});

describe('GET /settings/storage', () => {
  it('reports the signed-in person\'s numbers, with the default 1 GB limit and an 80% warning', async () => {
    const b = await boot({
      'workspace:usage': (async () => ({ bytes: 300 * MB })) as ServiceHandler,
    });
    await storeFiles(b, 'alice', 100 * MB);
    await b.harness.bus.fire('workspace:applied', b.harness.ctx({ userId: 'alice', agentId: 'agt_1' }), {});
    await b.plugin.drain();

    const r = await mine(b, 'alice');
    expect(r).toEqual({
      status: 200,
      json: {
        usedBytes: 400 * MB,
        limitBytes: 1024 * MB,
        warnBytes: Math.floor((1024 * MB * 80) / 100),
        workspaceBytes: 300 * MB,
        fileBytes: 100 * MB,
        status: 'ok',
      },
    });
  });

  it('is zero for someone with nothing stored', async () => {
    const b = await boot();
    const r = await mine(b, 'newcomer');
    expect(r.json).toMatchObject({ usedBytes: 0, workspaceBytes: 0, fileBytes: 0, status: 'ok' });
  });

  it('a person only ever sees their OWN numbers, even when another user has far more and asks by id', async () => {
    const b = await boot();
    await storeFiles(b, 'alice', 5 * MB);
    await storeFiles(b, 'bob', 900 * MB);

    expect((await mine(b, 'alice')).json).toMatchObject({ usedBytes: 5 * MB });
    expect((await mine(b, 'bob')).json).toMatchObject({ usedBytes: 900 * MB });
    // Nothing in the URL selects who is asked about: alice naming bob gets alice.
    b.setAuth({ id: 'alice', isAdmin: false });
    const sneaky = await b.request('GET', '/settings/storage', {
      query: { userId: 'bob', ownerId: 'bob', user: 'bob' },
      params: { userId: 'bob', ownerId: 'bob' },
    });
    expect(sneaky.status).toBe(200);
    expect(sneaky.json).toMatchObject({ usedBytes: 5 * MB, fileBytes: 5 * MB });
  });

  it('an admin asking here still sees only their own row, not the fleet', async () => {
    const b = await boot();
    await storeFiles(b, 'bob', 900 * MB);
    b.setAuth({ id: 'admin-1', isAdmin: true });
    expect((await b.request('GET', '/settings/storage')).json).toMatchObject({ usedBytes: 0 });
  });

  it('derives ok / near-limit / full at the exact thresholds', async () => {
    const b = await boot();
    b.setAuth({ id: 'admin-1', isAdmin: true });
    expect(
      (await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64, warnPercent: 50 } })).status,
    ).toBe(200);
    const warn = 32 * MB;
    // Blobs are charged in whole 4 KiB units (see blobCharge), so "one under" a
    // threshold is one UNIT under it.
    const unit = 4096;
    const cases: Array<[string, number, string]> = [
      ['below-warn', warn - unit, 'ok'],
      ['at-warn', warn, 'near-limit'],
      ['below-limit', 64 * MB - unit, 'near-limit'],
      ['at-limit', 64 * MB, 'full'],
      ['over-limit', 70 * MB, 'full'],
    ];
    for (const [user, size] of cases) await storeFiles(b, user, size);
    for (const [user, size, status] of cases) {
      expect((await mine(b, user)).json, user).toMatchObject({
        usedBytes: size,
        limitBytes: 64 * MB,
        warnBytes: warn,
        status,
      });
    }
  });

  it('follows the limit an admin sets', async () => {
    const b = await boot();
    await storeFiles(b, 'alice', 40 * MB);
    expect((await mine(b, 'alice')).json).toMatchObject({ status: 'ok' });
    b.setAuth({ id: 'admin-1', isAdmin: true });
    await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64 } });
    // 40 of 64 MB = 62.5%: under the 80% warning.
    expect((await mine(b, 'alice')).json).toMatchObject({ limitBytes: 64 * MB, status: 'ok' });
    b.setAuth({ id: 'admin-1', isAdmin: true });
    await b.request('PUT', '/admin/storage/limits', { body: { warnPercent: 60 } });
    expect((await mine(b, 'alice')).json).toMatchObject({ limitBytes: 64 * MB, status: 'near-limit' });
  });
});

describe('GET /admin/storage', () => {
  it('returns limits, defaults, bounds and the biggest owners, with names and team rows', async () => {
    const getUserCalls: string[] = [];
    const b = await boot({
      'auth:get-user': (async (_c: AgentContext, { userId }: { userId: string }) => {
        getUserCalls.push(userId);
        return userId === 'alice'
          ? { id: 'alice', email: 'a@example.com', displayName: 'Alice', isAdmin: false }
          : null;
      }) as ServiceHandler,
      'workspace:usage': (async () => ({ bytes: 20 * MB })) as ServiceHandler,
      'agents:resolve': (async (_c: unknown, input: { agentId: string; userId: string }) => ({
        agent:
          input.agentId === 'agt_team'
            ? { ownerId: 't1', ownerType: 'team' }
            : { ownerId: input.userId, ownerType: 'user' },
      })) as ServiceHandler,
    });
    b.setAuth({ id: 'admin-1', isAdmin: true });
    await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64, warnPercent: 50 } });
    await storeFiles(b, 'alice', 10 * MB);
    await storeFiles(b, 'bob', 70 * MB);
    await b.harness.bus.fire('workspace:applied', b.harness.ctx({ userId: 'alice', agentId: 'agt_alice' }), {});
    await b.harness.bus.fire('workspace:applied', b.harness.ctx({ userId: 'alice', agentId: 'agt_team' }), {});
    await b.plugin.drain();

    b.setAuth({ id: 'admin-1', isAdmin: true });
    const r = await b.request('GET', '/admin/storage');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      limits: { limitMb: 64, warnPercent: 50, graceMs: 86_400_000 },
      defaults: { limitMb: 1024, warnPercent: 80, graceMs: 86_400_000 },
      bounds: {
        limitMb: { min: 64, max: 10_485_760 },
        warnPercent: { min: 1, max: 99 },
        graceMs: { min: 3_600_000, max: 2_592_000_000 },
      },
      owners: [
        {
          ownerId: 'bob',
          kind: 'person',
          displayName: null,
          email: null,
          usedBytes: 70 * MB,
          workspaceBytes: 0,
          fileBytes: 70 * MB,
          status: 'full',
        },
        {
          ownerId: 'alice',
          kind: 'person',
          displayName: 'Alice',
          email: 'a@example.com',
          usedBytes: 30 * MB,
          workspaceBytes: 20 * MB,
          fileBytes: 10 * MB,
          status: 'ok',
        },
        {
          ownerId: 'team:t1',
          kind: 'team',
          displayName: null,
          email: null,
          usedBytes: 20 * MB,
          workspaceBytes: 20 * MB,
          fileBytes: 0,
          status: 'ok',
        },
      ],
      ownerCount: 3,
      totalBytes: 120 * MB,
    });
    // A team id is not a user id: it is never sent to auth.
    expect(getUserCalls.sort()).toEqual(['alice', 'bob']);
  });

  it('marks near-limit owners', async () => {
    const b = await boot();
    b.setAuth({ id: 'admin-1', isAdmin: true });
    await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64, warnPercent: 50 } });
    await storeFiles(b, 'mid', 40 * MB);
    b.setAuth({ id: 'admin-1', isAdmin: true });
    const r = await b.request('GET', '/admin/storage');
    expect((r.json as { owners: Array<{ status: string }> }).owners[0]!.status).toBe('near-limit');
  });

  it('shows raw ids (null names) when auth:get-user is absent or throws', async () => {
    const b = await boot({
      'auth:get-user': (async () => {
        throw new Error('auth down');
      }) as ServiceHandler,
    });
    await storeFiles(b, 'alice', 1);
    const r = await b.request('GET', '/admin/storage');
    expect(r.status).toBe(200);
    expect((r.json as { owners: unknown[] }).owners[0]).toMatchObject({
      ownerId: 'alice',
      displayName: null,
      email: null,
    });

    const c = await boot();
    await storeFiles(c, 'alice', 1);
    const r2 = await c.request('GET', '/admin/storage');
    expect((r2.json as { owners: unknown[] }).owners).toHaveLength(1);
  });

  it('is empty with the defaults before anything is stored', async () => {
    const b = await boot();
    const r = await b.request('GET', '/admin/storage');
    expect(r.json).toMatchObject({
      limits: { limitMb: 1024, warnPercent: 80, graceMs: 86_400_000 },
      owners: [],
      ownerCount: 0,
      totalBytes: 0,
    });
  });

  it('caps the list at 200 owners, biggest first, while the count and total cover everyone', async () => {
    const b = await boot();
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    await sql`
      INSERT INTO disk_quota_v1_usage (owner_id, source, kind, bytes)
      SELECT 'u' || lpad(i::text, 4, '0'), 'blob:x', 'blob', i FROM generate_series(1, 205) AS i
    `.execute(db);
    const r = await b.request('GET', '/admin/storage');
    const body = r.json as { owners: Array<{ ownerId: string }>; ownerCount: number; totalBytes: number };
    expect(body.owners).toHaveLength(200);
    expect(body.owners[0]!.ownerId).toBe('u0205');
    expect(body.owners.at(-1)!.ownerId).toBe('u0006');
    expect(body.ownerCount).toBe(205);
    expect(body.totalBytes).toBe((205 * 206) / 2);
  });
});

describe('PUT /admin/storage/limits', () => {
  it('saves valid limits through storage and returns them', async () => {
    const b = await boot();
    const r = await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 2048, warnPercent: 90 } });
    expect(r).toEqual({
      status: 200,
      json: { limits: { limitMb: 2048, warnPercent: 90, graceMs: 86_400_000 } },
    });
    expect(JSON.parse(new TextDecoder().decode(b.storage.get(LIMITS_STORAGE_KEY)))).toEqual({
      limitMb: 2048,
      warnPercent: 90,
      graceMs: 86_400_000,
    });
  });

  it('changes only the fields sent', async () => {
    const b = await boot();
    expect((await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 500 } })).json).toEqual({
      limits: { limitMb: 500, warnPercent: 80, graceMs: 86_400_000 },
    });
    expect((await b.request('PUT', '/admin/storage/limits', { body: { warnPercent: 70 } })).json).toEqual({
      limits: { limitMb: 500, warnPercent: 70, graceMs: 86_400_000 },
    });
    // The blob pass's grace window is one more field of the same setting.
    expect((await b.request('PUT', '/admin/storage/limits', { body: { graceMs: 7_200_000 } })).json).toEqual({
      limits: { limitMb: 500, warnPercent: 70, graceMs: 7_200_000 },
    });
    const g = await b.request('GET', '/admin/storage');
    expect((g.json as { limits: unknown }).limits).toEqual({
      limitMb: 500,
      warnPercent: 70,
      graceMs: 7_200_000,
    });
  });

  it('accepts the bounds themselves', async () => {
    const b = await boot();
    expect(
      (await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64, warnPercent: 1 } })).status,
    ).toBe(200);
    expect(
      (await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 10_485_760, warnPercent: 99 } }))
        .status,
    ).toBe(200);
    for (const graceMs of [3_600_000, 2_592_000_000]) {
      expect((await b.request('PUT', '/admin/storage/limits', { body: { graceMs } })).status).toBe(200);
    }
  });

  it('rejects bad shapes and bounds with invalid-limits, and bad bodies, writing nothing', async () => {
    const b = await boot();
    const bad: unknown[] = [
      { limitMb: 63 },
      { limitMb: 10_485_761 },
      { limitMb: 100.5 },
      { limitMb: '512' },
      { limitMb: null },
      { limitMb: -1 },
      { warnPercent: 0 },
      { warnPercent: 100 },
      { warnPercent: 80.5 },
      { warnPercent: '80' },
      { graceMs: 3_599_999 },
      { graceMs: 2_592_000_001 },
      { graceMs: 3_600_000.5 },
      { graceMs: '86400000' },
      { limitMb: 512, extra: true },
      { unknown: 1 },
      [1, 2],
      null,
      'text',
      5,
    ];
    for (const body of bad) {
      const r = await b.request('PUT', '/admin/storage/limits', { body });
      expect(r, JSON.stringify(body)).toEqual({ status: 400, json: { error: 'invalid-limits' } });
    }
    expect(await b.request('PUT', '/admin/storage/limits', { rawBody: Buffer.from('{nope') })).toEqual({
      status: 400,
      json: { error: 'invalid-json' },
    });
    expect(b.storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });

  it('refuses a body over 4 KiB with 413, even though it is well-formed', async () => {
    const b = await boot();
    const big = Buffer.from(JSON.stringify({ limitMb: 512, pad: 'x'.repeat(5 * 1024) }));
    expect(big.length).toBeGreaterThan(5 * 1024);
    expect(await b.request('PUT', '/admin/storage/limits', { rawBody: big })).toEqual({
      status: 413,
      json: { error: 'body-too-large' },
    });
    expect(
      await b.request('PUT', '/admin/storage/limits', { rawBody: Buffer.alloc(4097, 0x20) }),
    ).toEqual({ status: 413, json: { error: 'body-too-large' } });
    expect(b.storage.has(LIMITS_STORAGE_KEY)).toBe(false);
  });

  it('takes effect at once: the next GET shows it and the next write is judged by it', async () => {
    const b = await boot();
    await storeFiles(b, 'alice', 60 * MB);
    const alice = b.harness.ctx({ userId: 'alice' });

    // Default 1 GB: a 5 MB upload passes.
    expect((await b.harness.bus.fire('blob:pre-put', alice, { size: 5 * MB })).rejected).toBe(false);

    await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 64 } });
    const g = await b.request('GET', '/admin/storage');
    expect((g.json as { limits: unknown }).limits).toEqual({
      limitMb: 64,
      warnPercent: 80,
      graceMs: 86_400_000,
    });
    expect((await b.harness.bus.fire('blob:pre-put', alice, { size: 5 * MB })).rejected).toBe(true);

    await b.request('PUT', '/admin/storage/limits', { body: { limitMb: 128 } });
    expect((await b.harness.bus.fire('blob:pre-put', alice, { size: 5 * MB })).rejected).toBe(false);
  });
});

describe('POST /admin/storage/ref-holders/forget', () => {
  const FORGET = '/admin/storage/ref-holders/forget';

  async function dbOf(b: Booted): Promise<Kysely<unknown>> {
    const { db } = await b.harness.bus.call<unknown, { db: Kysely<unknown> }>(
      'database:get-instance',
      b.harness.ctx(),
      {},
    );
    return db;
  }

  async function roster(b: Booted): Promise<string[]> {
    const r = await sql<{ holder: string }>`SELECT holder FROM disk_quota_v1_ref_holders ORDER BY holder`.execute(
      await dbOf(b),
    );
    return r.rows.map((x) => x.holder);
  }

  async function seedRoster(b: Booted, names: string[]): Promise<void> {
    const db = await dbOf(b);
    for (const n of names) {
      await sql`INSERT INTO disk_quota_v1_ref_holders (holder) VALUES (${n})`.execute(db);
    }
  }

  it('drops one holder from the roster, logs who did it, and says whether it was there', async () => {
    const b = await boot();
    await seedRoster(b, ['@ax/attachments', '@ax/retired']);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      b.setAuth({ id: 'admin-1', isAdmin: true });
      expect(await b.request('POST', FORGET, { body: { holder: '@ax/retired' } })).toEqual({
        status: 200,
        json: { forgotten: true },
      });
      expect(await b.request('POST', FORGET, { body: { holder: '@ax/retired' } })).toEqual({
        status: 200,
        json: { forgotten: false },
      });
    } finally {
      spy.mockRestore();
    }
    expect(await roster(b)).toEqual(['@ax/attachments']);
    const logged = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.includes('disk_quota_ref_holder_forgotten'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ holder: '@ax/retired', by: 'admin-1', forgotten: true });
  });

  it('401 / 403 change nothing', async () => {
    const b = await boot();
    await seedRoster(b, ['@ax/retired']);
    b.setAuth('throw');
    expect(await b.request('POST', FORGET, { body: { holder: '@ax/retired' } })).toEqual({
      status: 401,
      json: { error: 'unauthenticated' },
    });
    b.setAuth({ id: 'u9', isAdmin: false });
    expect(await b.request('POST', FORGET, { body: { holder: '@ax/retired' } })).toEqual({
      status: 403,
      json: { error: 'forbidden' },
    });
    expect(await roster(b)).toEqual(['@ax/retired']);
  });

  it('400 on a missing, empty, over-long or non-string holder, or extra fields; 413 on a huge body', async () => {
    const b = await boot();
    await seedRoster(b, ['@ax/retired', 'x'.repeat(200)]);
    const bad: unknown[] = [
      {},
      { holder: '' },
      { holder: 'x'.repeat(201) },
      { holder: 5 },
      { holder: null },
      { holder: ['@ax/retired'] },
      { holder: '@ax/retired', extra: 1 },
      [],
      null,
      'text',
    ];
    for (const body of bad) {
      const r = await b.request('POST', FORGET, { body });
      expect(r, JSON.stringify(body)).toEqual({ status: 400, json: { error: 'invalid-holder' } });
    }
    expect(await b.request('POST', FORGET, { rawBody: Buffer.from('{nope') })).toEqual({
      status: 400,
      json: { error: 'invalid-json' },
    });
    expect(await b.request('POST', FORGET, { rawBody: Buffer.alloc(4097, 0x20) })).toEqual({
      status: 413,
      json: { error: 'body-too-large' },
    });
    expect(await roster(b)).toEqual(['@ax/retired', 'x'.repeat(200)]);
    // The 200-character name is the longest accepted.
    expect((await b.request('POST', FORGET, { body: { holder: 'x'.repeat(200) } })).json).toEqual({
      forgotten: true,
    });
  });
});
