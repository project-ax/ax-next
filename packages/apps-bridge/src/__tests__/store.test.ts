import { createSharedPostgres, startTestContainer } from '@ax/test-harness';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runAppsBridgeMigration, type AppsBridgeDatabase } from '../migrations.js';
import { createAppsBridgeStore, MAX_OPEN_LINK_CODES_PER_AGENT, type AppsBridgeStore } from '../store.js';

/*
  The store holds who may lend which connector to which outside app, so the
  rules below are the security-relevant ones: a link code links once and only
  while fresh; an app id is linked to at most one agent, decided atomically even
  when two claims race; a removal only acts on the agent the caller named; and
  a grant or an approval can't outlive what it hangs off.

  One Postgres server per file, one fresh database per test.
*/

const server = createSharedPostgres(() => startTestContainer(new PostgreSqlContainer('postgres:16-alpine')));
afterAll(() => server.stop(), 60_000);

let open: Kysely<AppsBridgeDatabase>[] = [];
afterEach(async () => {
  await Promise.all(open.map((db) => db.destroy().catch(() => {})));
  open = [];
});

async function freshDb(): Promise<{ db: Kysely<AppsBridgeDatabase>; store: AppsBridgeStore; connectionString: string }> {
  const connectionString = await server.database();
  // Room for the racing claims below to each hold their own connection.
  const db = new Kysely<AppsBridgeDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
  open.push(db);
  await runAppsBridgeMigration(db);
  return { db, store: createAppsBridgeStore(db), connectionString };
}

/**
 * A second session, outside the store, that plays the other side of a race:
 * it opens a transaction, takes row locks, and commits when the test says so.
 */
async function otherSession(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  clients.push(client);
  await client.query('BEGIN');
  return client;
}
let clients: pg.Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
  clients = [];
});

/** Wait until `n` sessions on this database are blocked on a lock. */
async function lockWaiters(db: Kysely<AppsBridgeDatabase>, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `.execute(db);
    if ((rows[0]?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} lock waiter(s), saw ${rows[0]?.n}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Any 64-hex string stands in for sha256(code) here. */
function hash(n: number): string {
  return n.toString(16).padStart(64, '0');
}

const P = 'acme-apps';
const OTHER_P = 'other-platform';
const APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6B';
const OTHER_APP = 'app_01JDZ8M5Q4X7RT3VKF0N2C9H6C';
const AGENT = 'agt_support';
const OTHER_AGENT = 'agt_sales';
const ADA = 'usr_ada';
const BOB = 'usr_bob';
const GITHUB = 'github';
const LINEAR = 'linear';
const KEY_A = 'mcp.c0123456789.create_issue';
const KEY_B = 'mcp.c0123456789.list_issues';
const KEY_C = 'mcp.cabcdefabcd.search';

const T0 = new Date('2026-11-21T12:00:00.000Z');
const minutes = (m: number): Date => new Date(T0.getTime() + m * 60_000);

async function mint(store: AppsBridgeStore, n: number, o: { agentId?: string; userId?: string; at?: Date; ttlMin?: number } = {}): Promise<string> {
  const now = o.at ?? T0;
  const codeHash = hash(n);
  await store.mintLinkCode({
    codeHash,
    userId: o.userId ?? ADA,
    agentId: o.agentId ?? AGENT,
    expiresAt: new Date(now.getTime() + (o.ttlMin ?? 15) * 60_000),
    now,
  });
  return codeHash;
}

async function link(store: AppsBridgeStore, n: number, o: { appId?: string; agentId?: string; platformId?: string } = {}) {
  const codeHash = await mint(store, n, { agentId: o.agentId ?? AGENT });
  const r = await store.claimLinkCode({ codeHash, platformId: o.platformId ?? P, appId: o.appId ?? APP, appName: 'Support Desk', now: T0 });
  if (r.result !== 'linked') throw new Error(`link failed: ${r.result}`);
  return r.link;
}

async function codeHashes(db: Kysely<AppsBridgeDatabase>): Promise<string[]> {
  const rows = await db.selectFrom('apps_bridge_v1_link_codes').select('code_hash').orderBy('code_hash').execute();
  return rows.map((r) => r.code_hash);
}

async function count(db: Kysely<AppsBridgeDatabase>, table: keyof AppsBridgeDatabase): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(db);
  return Number(rows[0]?.n);
}

describe('apps-bridge store', () => {
  it('migrations are idempotent', async () => {
    const { db } = await freshDb();
    await runAppsBridgeMigration(db);
    for (const t of [
      'apps_bridge_v1_link_codes',
      'apps_bridge_v1_links',
      'apps_bridge_v1_grants',
      'apps_bridge_v1_viewer_approvals',
    ]) {
      const { rows } = await sql<{ r: string | null }>`SELECT to_regclass(${t})::text AS r`.execute(db);
      expect(rows[0]?.r).toBe(t);
    }
  });

  it('mintLinkCode sweeps expired codes and keeps the newest 10 per agent', async () => {
    const { db, store } = await freshDb();
    // Another agent's code that has expired by the time of the later mints.
    await mint(store, 900, { agentId: OTHER_AGENT, at: T0, ttlMin: 1 });
    // Another agent's fresh code is never trimmed by this agent's mints.
    await mint(store, 901, { agentId: OTHER_AGENT, at: minutes(5) });
    // Twelve codes for AGENT, one second apart: the oldest two go.
    for (let i = 1; i <= 12; i++) {
      await mint(store, i, { at: new Date(minutes(5).getTime() + i * 1000) });
    }
    const left = await codeHashes(db);
    expect(left).not.toContain(hash(900));
    expect(left).toContain(hash(901));
    const mine = left.filter((h) => h !== hash(901));
    expect(mine).toHaveLength(MAX_OPEN_LINK_CODES_PER_AGENT);
    expect(mine).toEqual(Array.from({ length: 10 }, (_, i) => hash(i + 3)));

    // created_at is the injected clock, not the database's.
    const row = await db.selectFrom('apps_bridge_v1_link_codes').select('created_at').where('code_hash', '=', hash(12)).executeTakeFirstOrThrow();
    expect(row.created_at.toISOString()).toBe(new Date(minutes(5).getTime() + 12_000).toISOString());
  });

  it('mintLinkCode trims ties on created_at by code_hash, deterministically', async () => {
    const { db, store } = await freshDb();
    // Eleven codes minted at the very same instant: the order is created_at
    // DESC, then code_hash ascending, so the largest hash is the one trimmed.
    for (let i = 1; i <= 11; i++) await mint(store, i, { at: T0 });
    expect(await codeHashes(db)).toEqual(Array.from({ length: 10 }, (_, i) => hash(i + 1)));
  });

  it('concurrent mints for one agent still leave at most 10 open codes', async () => {
    const { db, store, connectionString } = await freshDb();
    for (let i = 1; i <= 10; i++) await mint(store, i, { at: new Date(T0.getTime() + i) });
    // Force the interleaving: another session holds the oldest code, so the
    // first mint stops in its trim, after its insert. A second mint for the
    // same agent must wait for the first to finish rather than trim against
    // a table without the first one's row (which would leave 11).
    const other = await otherSession(connectionString);
    await other.query('SELECT 1 FROM apps_bridge_v1_link_codes WHERE code_hash = $1 FOR UPDATE', [hash(1)]);
    const first = mint(store, 11, { at: new Date(T0.getTime() + 11) });
    await lockWaiters(db, 1);
    const second = mint(store, 12, { at: new Date(T0.getTime() + 12) });
    await lockWaiters(db, 2);
    await other.query('COMMIT');
    await Promise.all([first, second]);
    expect(await codeHashes(db)).toEqual(Array.from({ length: 10 }, (_, i) => hash(i + 3)));

    // And a plain burst stays at the cap too.
    await Promise.all(Array.from({ length: 20 }, (_, i) => mint(store, 100 + i, { at: new Date(T0.getTime() + 100 + i) })));
    expect(await codeHashes(db)).toHaveLength(MAX_OPEN_LINK_CODES_PER_AGENT);
  });

  it('peekLinkCode answers only an unexpired code', async () => {
    const { store } = await freshDb();
    const h = await mint(store, 1, { userId: BOB, agentId: OTHER_AGENT });
    expect(await store.peekLinkCode(h, minutes(14))).toEqual({ userId: BOB, agentId: OTHER_AGENT });
    expect(await store.peekLinkCode(h, minutes(15))).toBeNull();
    expect(await store.peekLinkCode(hash(2), T0)).toBeNull();
  });

  it('a fresh code links once and is burned', async () => {
    const { db, store } = await freshDb();
    const h = await mint(store, 1, { userId: BOB, agentId: OTHER_AGENT });
    const r = await store.claimLinkCode({ codeHash: h, platformId: P, appId: APP, appName: 'Support Desk', now: minutes(1) });
    expect(r.result).toBe('linked');
    if (r.result !== 'linked') return;
    expect(r.link).toMatchObject({ platformId: P, appId: APP, agentId: OTHER_AGENT, linkedByUserId: BOB, appName: 'Support Desk' });
    expect(r.link.createdAt).toBeInstanceOf(Date);
    expect(await codeHashes(db)).toEqual([]);
    expect(await store.getLink(P, APP)).toEqual(r.link);

    const again = await store.claimLinkCode({ codeHash: h, platformId: P, appId: OTHER_APP, appName: 'x', now: minutes(1) });
    expect(again).toEqual({ result: 'invalid' });
    expect(await store.getLink(P, OTHER_APP)).toBeNull();
  });

  it('an expired code is invalid', async () => {
    const { db, store } = await freshDb();
    const h = await mint(store, 1);
    const r = await store.claimLinkCode({ codeHash: h, platformId: P, appId: APP, appName: 'x', now: minutes(15) });
    expect(r).toEqual({ result: 'invalid' });
    expect(await count(db, 'apps_bridge_v1_links')).toBe(0);
    // An unknown code is the same answer.
    expect(await store.claimLinkCode({ codeHash: hash(77), platformId: P, appId: APP, appName: 'x', now: T0 })).toEqual({ result: 'invalid' });
  });

  it('an app already linked is already-linked, and the code is kept', async () => {
    const { store } = await freshDb();
    await link(store, 1);
    const h2 = await mint(store, 2, { agentId: OTHER_AGENT, userId: BOB });
    const r = await store.claimLinkCode({ codeHash: h2, platformId: P, appId: APP, appName: 'x', now: T0 });
    expect(r).toEqual({ result: 'already-linked' });
    expect(await store.peekLinkCode(h2, T0)).toEqual({ userId: BOB, agentId: OTHER_AGENT });
    expect((await store.getLink(P, APP))?.agentId).toBe(AGENT);

    expect(await store.deleteLink(P, APP, AGENT)).toBe(true);
    const again = await store.claimLinkCode({ codeHash: h2, platformId: P, appId: APP, appName: 'Other', now: T0 });
    expect(again.result).toBe('linked');
    if (again.result === 'linked') expect(again.link).toMatchObject({ agentId: OTHER_AGENT, linkedByUserId: BOB, appName: 'Other' });
  });

  it('the same app id on another platform is a separate link', async () => {
    const { store } = await freshDb();
    await link(store, 1);
    const other = await link(store, 2, { platformId: OTHER_P, agentId: OTHER_AGENT });
    expect(other).toMatchObject({ platformId: OTHER_P, appId: APP, agentId: OTHER_AGENT });
    expect((await store.getLink(P, APP))?.agentId).toBe(AGENT);
  });

  it('racing claims make exactly one link', async () => {
    const { db, store } = await freshDb();
    // Two different codes for one app id at once.
    const a = await mint(store, 1, { agentId: AGENT });
    const b = await mint(store, 2, { agentId: OTHER_AGENT, userId: BOB });
    const raced = await Promise.all([
      store.claimLinkCode({ codeHash: a, platformId: P, appId: APP, appName: 'A', now: T0 }),
      store.claimLinkCode({ codeHash: b, platformId: P, appId: APP, appName: 'B', now: T0 }),
    ]);
    expect(raced.map((r) => r.result).sort()).toEqual(['already-linked', 'linked']);
    expect(await count(db, 'apps_bridge_v1_links')).toBe(1);
    const winner = raced.find((r) => r.result === 'linked');
    const loserHash = winner?.result === 'linked' && winner.link.agentId === AGENT ? b : a;
    const winnerAgent = loserHash === b ? AGENT : OTHER_AGENT;
    // The loser's code still peeks, and links once the winner's link is gone.
    expect(await store.peekLinkCode(loserHash, T0)).not.toBeNull();
    expect(await store.deleteLink(P, APP, winnerAgent)).toBe(true);
    expect((await store.claimLinkCode({ codeHash: loserHash, platformId: P, appId: APP, appName: 'L', now: T0 })).result).toBe('linked');

    // One code claimed twice at once (for two app ids, so only the code decides).
    const c = await mint(store, 3);
    const twice = await Promise.all([
      store.claimLinkCode({ codeHash: c, platformId: P, appId: 'app_twice_1', appName: 'x', now: T0 }),
      store.claimLinkCode({ codeHash: c, platformId: P, appId: 'app_twice_2', appName: 'x', now: T0 }),
    ]);
    expect(twice.map((r) => r.result).sort()).toEqual(['invalid', 'linked']);
    const twiceLinks = await db.selectFrom('apps_bridge_v1_links').select('app_id').where('app_id', 'like', 'app_twice_%').execute();
    expect(twiceLinks).toHaveLength(1);

    // And one code claimed twice at once for the same app id.
    const d = await mint(store, 4);
    const same = await Promise.all([
      store.claimLinkCode({ codeHash: d, platformId: P, appId: 'app_same', appName: 'x', now: T0 }),
      store.claimLinkCode({ codeHash: d, platformId: P, appId: 'app_same', appName: 'x', now: T0 }),
    ]);
    expect(same.map((r) => r.result).sort()).toEqual(['invalid', 'linked']);
    // The losing retry can still find the link its code made (Task 7 answers it 200).
    expect(await store.getLinkByCode(P, 'app_same', d)).not.toBeNull();
  });

  it('a claim that loses the insert race to another code is already-linked, and its code is kept', async () => {
    const { db, store, connectionString } = await freshDb();
    const h = await mint(store, 1, { agentId: OTHER_AGENT, userId: BOB });
    // Another claim has inserted the link for this app id but not committed,
    // so this claim's "already linked?" read can't see it yet.
    const other = await otherSession(connectionString);
    await other.query(
      `INSERT INTO apps_bridge_v1_links (platform_id, app_id, agent_id, linked_by_user_id, app_name, link_code_hash)
       VALUES ($1, $2, $3, $4, 'Winner', $5)`,
      [P, APP, AGENT, ADA, hash(2)],
    );
    const claim = store.claimLinkCode({ codeHash: h, platformId: P, appId: APP, appName: 'Loser', now: T0 });
    await lockWaiters(db, 1);
    await other.query('COMMIT');
    expect(await claim).toEqual({ result: 'already-linked' });
    expect(await store.peekLinkCode(h, T0)).toEqual({ userId: BOB, agentId: OTHER_AGENT });
    expect((await store.getLink(P, APP))?.agentId).toBe(AGENT);
  });

  it('a claim of a code that another claim is burning waits, then is invalid', async () => {
    const { db, store, connectionString } = await freshDb();
    const h = await mint(store, 1);
    // Another claim holds the code and burns it.
    const other = await otherSession(connectionString);
    await other.query('DELETE FROM apps_bridge_v1_link_codes WHERE code_hash = $1', [h]);
    const claim = store.claimLinkCode({ codeHash: h, platformId: P, appId: OTHER_APP, appName: 'x', now: T0 });
    await lockWaiters(db, 1);
    await other.query('COMMIT');
    expect(await claim).toEqual({ result: 'invalid' });
    expect(await store.getLink(P, OTHER_APP)).toBeNull();
  });

  it('getLinkByCode finds the link a code made, for that app id only', async () => {
    const { store } = await freshDb();
    const made = await link(store, 1);
    expect(await store.getLinkByCode(P, APP, hash(1))).toEqual(made);
    expect(await store.getLinkByCode(P, OTHER_APP, hash(1))).toBeNull();
    expect(await store.getLinkByCode(OTHER_P, APP, hash(1))).toBeNull();
    expect(await store.getLinkByCode(P, APP, hash(2))).toBeNull();
  });

  it('listLinksForAgent lists only that agent\'s links on that platform', async () => {
    const { store } = await freshDb();
    await link(store, 1, { appId: APP });
    await link(store, 2, { appId: OTHER_APP });
    await link(store, 3, { appId: 'app_sales', agentId: OTHER_AGENT });
    await link(store, 4, { appId: 'app_elsewhere', platformId: OTHER_P });
    const mine = await store.listLinksForAgent(P, AGENT);
    expect(mine.map((l) => l.appId).sort()).toEqual([APP, OTHER_APP].sort());
    expect(await store.listLinksForAgent(P, 'agt_nobody')).toEqual([]);
  });

  it('deleteLink only removes a link to that agent', async () => {
    const { store } = await freshDb();
    await link(store, 1);
    expect(await store.deleteLink(P, APP, OTHER_AGENT)).toBe(false);
    expect(await store.getLink(P, APP)).not.toBeNull();
    expect(await store.deleteLink(P, APP, AGENT)).toBe(true);
    expect(await store.getLink(P, APP)).toBeNull();
    expect(await store.deleteLink(P, APP, AGENT)).toBe(false);
  });

  it('putGrant upserts one grant per connector', async () => {
    const { store } = await freshDb();
    await link(store, 1);
    const first = await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'builder', toolKeys: [KEY_B, KEY_A] });
    if (first === 'no-link') throw new Error('unexpected no-link');
    expect(first).toMatchObject({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'builder', toolKeys: [KEY_B, KEY_A] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_A, KEY_C, KEY_B] });
    if (second === 'no-link') throw new Error('unexpected no-link');
    expect(second).toMatchObject({ mode: 'viewer', toolKeys: [KEY_A, KEY_C, KEY_B] });
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    expect(await store.listGrants(P, APP)).toEqual([second]);
    expect(await store.getGrant(P, APP, GITHUB)).toEqual(second);

    await store.putGrant({ platformId: P, appId: APP, connectorId: 'asana', mode: 'builder', toolKeys: [] });
    expect((await store.listGrants(P, APP)).map((g) => g.connectorId)).toEqual(['asana', GITHUB]);
    expect(await store.deleteGrant(P, APP, 'asana')).toBe(true);
    expect(await store.deleteGrant(P, APP, 'asana')).toBe(false);
    expect(await store.getGrant(P, APP, 'asana')).toBeNull();
  });

  it('putGrant without a link is no-link', async () => {
    const { db, store } = await freshDb();
    expect(await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'builder', toolKeys: [KEY_A] })).toBe('no-link');
    expect(await count(db, 'apps_bridge_v1_grants')).toBe(0);
  });

  it('unlinking cascades grants and approvals; removing a grant cascades its approvals', async () => {
    const { db, store } = await freshDb();
    await link(store, 1);
    await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_A] });
    await store.putGrant({ platformId: P, appId: APP, connectorId: LINEAR, mode: 'viewer', toolKeys: [KEY_C] });
    expect(await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] })).toBe('saved');
    expect(await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: LINEAR, agentId: 'agt_bob', toolKeys: [KEY_C] })).toBe('saved');

    expect(await store.deleteGrant(P, APP, GITHUB)).toBe(true);
    expect(await store.getApproval(BOB, P, APP, GITHUB)).toBeNull();
    expect(await store.getApproval(BOB, P, APP, LINEAR)).not.toBeNull();

    expect(await store.deleteLink(P, APP, AGENT)).toBe(true);
    expect(await count(db, 'apps_bridge_v1_grants')).toBe(0);
    expect(await count(db, 'apps_bridge_v1_viewer_approvals')).toBe(0);
  });

  it('putApproval upserts the agent and the tool snapshot; without a grant it is no-grant', async () => {
    const { db, store } = await freshDb();
    expect(await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] })).toBe('no-grant');
    expect(await count(db, 'apps_bridge_v1_viewer_approvals')).toBe(0);

    await link(store, 1);
    await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_A, KEY_B] });
    expect(await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] })).toBe('saved');
    const first = await store.getApproval(BOB, P, APP, GITHUB);
    expect(first).toMatchObject({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] });
    expect(await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob_2', toolKeys: [KEY_B, KEY_A] })).toBe('saved');
    const second = await store.getApproval(BOB, P, APP, GITHUB);
    expect(second).toMatchObject({ agentId: 'agt_bob_2', toolKeys: [KEY_B, KEY_A] });
    expect(await count(db, 'apps_bridge_v1_viewer_approvals')).toBe(1);

    expect(await store.listApprovalsForViewerAgent(BOB, P, 'agt_bob_2')).toEqual([second]);
    expect(await store.listApprovalsForViewerAgent(BOB, P, 'agt_bob')).toEqual([]);
    expect(await store.listApprovalsForViewerAgent(ADA, P, 'agt_bob_2')).toEqual([]);

    // deleteApproval acts only on the agent the caller named.
    expect(await store.deleteApproval(BOB, P, APP, GITHUB, 'agt_bob')).toBe(false);
    expect(await store.deleteApproval(BOB, P, APP, GITHUB, 'agt_bob_2')).toBe(true);
    expect(await store.getApproval(BOB, P, APP, GITHUB)).toBeNull();
  });

  it('deleteForAgent removes the agent\'s codes, links to it and approvals that borrow it, nothing else', async () => {
    const { db, store } = await freshDb();
    // AGENT: two open codes, two links (one with a grant and an approval from Bob's agent).
    await mint(store, 1);
    await mint(store, 2);
    await link(store, 3, { appId: APP });
    await link(store, 4, { appId: OTHER_APP });
    await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_A] });
    await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] });

    // OTHER_AGENT: a code, a link with a viewer grant, and two approvals there:
    // one borrowing AGENT (goes), one borrowing someone else (stays).
    await mint(store, 5, { agentId: OTHER_AGENT });
    await link(store, 6, { appId: 'app_sales', agentId: OTHER_AGENT });
    await store.putGrant({ platformId: P, appId: 'app_sales', connectorId: LINEAR, mode: 'viewer', toolKeys: [KEY_C] });
    await store.putApproval({ viewerUserId: ADA, platformId: P, appId: 'app_sales', connectorId: LINEAR, agentId: AGENT, toolKeys: [KEY_C] });
    await store.putApproval({ viewerUserId: BOB, platformId: P, appId: 'app_sales', connectorId: LINEAR, agentId: 'agt_bob', toolKeys: [KEY_C] });

    expect(await store.deleteForAgent(AGENT)).toEqual({ codes: 2, links: 2, approvals: 1 });

    expect(await codeHashes(db)).toEqual([hash(5)]);
    expect((await db.selectFrom('apps_bridge_v1_links').select('app_id').execute()).map((r) => r.app_id)).toEqual(['app_sales']);
    expect((await db.selectFrom('apps_bridge_v1_grants').select(['app_id', 'connector_id']).execute())).toEqual([{ app_id: 'app_sales', connector_id: LINEAR }]);
    const approvals = await db.selectFrom('apps_bridge_v1_viewer_approvals').select(['viewer_user_id', 'agent_id']).execute();
    expect(approvals).toEqual([{ viewer_user_id: BOB, agent_id: 'agt_bob' }]);

    // Running it again is harmless.
    expect(await store.deleteForAgent(AGENT)).toEqual({ codes: 0, links: 0, approvals: 0 });
  });

  it('deleteGrantsForConnector removes that connector\'s grants on every app', async () => {
    const { db, store } = await freshDb();
    await link(store, 1, { appId: APP });
    await link(store, 2, { appId: OTHER_APP, agentId: OTHER_AGENT });
    for (const appId of [APP, OTHER_APP]) {
      await store.putGrant({ platformId: P, appId, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_A] });
      await store.putGrant({ platformId: P, appId, connectorId: LINEAR, mode: 'builder', toolKeys: [KEY_C] });
    }
    await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_A] });

    expect(await store.deleteGrantsForConnector(GITHUB)).toBe(2);
    const left = await db.selectFrom('apps_bridge_v1_grants').select(['app_id', 'connector_id']).orderBy('app_id').execute();
    expect(left).toEqual([{ app_id: APP, connector_id: LINEAR }, { app_id: OTHER_APP, connector_id: LINEAR }].sort((x, y) => x.app_id.localeCompare(y.app_id)));
    expect(await count(db, 'apps_bridge_v1_viewer_approvals')).toBe(0);
    expect(await count(db, 'apps_bridge_v1_links')).toBe(2);
    expect(await store.deleteGrantsForConnector(GITHUB)).toBe(0);
  });

  it('deleteForToolNamespaces removes grants and approval snapshots naming any of those namespaces', async () => {
    const { db, store } = await freshDb();
    const NS_ADA = 'c0123456789';   // KEY_A, KEY_B: Ada's github connector
    const NS_BOB = 'cabcdefabcd';   // KEY_C: Bob's github connector, same id, other owner
    const NS_OTHER = 'c9999999999';
    const KEY_DOTTED = `mcp.${NS_OTHER}.tool.with.dots`;
    await link(store, 1, { appId: APP });
    await link(store, 2, { appId: OTHER_APP, agentId: OTHER_AGENT });
    // Ada's app: a github grant on her namespace (mixed with another), and a linear grant elsewhere.
    await store.putGrant({ platformId: P, appId: APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_DOTTED, KEY_B] });
    await store.putGrant({ platformId: P, appId: APP, connectorId: LINEAR, mode: 'viewer', toolKeys: [KEY_DOTTED] });
    // Bob's app: a github grant on Bob's namespace (same connector id, different owner).
    await store.putGrant({ platformId: P, appId: OTHER_APP, connectorId: GITHUB, mode: 'viewer', toolKeys: [KEY_C] });
    await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: GITHUB, agentId: 'agt_bob', toolKeys: [KEY_B] });
    // An approval under a grant that survives, whose snapshot still names Ada's namespace.
    await store.putApproval({ viewerUserId: BOB, platformId: P, appId: APP, connectorId: LINEAR, agentId: 'agt_bob', toolKeys: [KEY_A] });
    await store.putApproval({ viewerUserId: ADA, platformId: P, appId: OTHER_APP, connectorId: GITHUB, agentId: 'agt_ada', toolKeys: [KEY_C] });

    // The github grant on APP goes (its approval cascades, uncounted); the
    // linear grant stays but the approval snapshot naming Ada's namespace goes.
    expect(await store.deleteForToolNamespaces([NS_ADA])).toEqual({ grants: 1, approvals: 1 });
    const grants = await db.selectFrom('apps_bridge_v1_grants').select(['app_id', 'connector_id']).orderBy('app_id').orderBy('connector_id').execute();
    expect(grants).toEqual([{ app_id: APP, connector_id: LINEAR }, { app_id: OTHER_APP, connector_id: GITHUB }]);
    const approvals = await db.selectFrom('apps_bridge_v1_viewer_approvals').select(['viewer_user_id', 'app_id']).execute();
    expect(approvals).toEqual([{ viewer_user_id: ADA, app_id: OTHER_APP }]);

    // Only namespace-shaped values are accepted (a tool name's own dots never
    // reach the match: the namespace is the key's second segment).
    await expect(store.deleteForToolNamespaces(['with'])).rejects.toThrow();
    await expect(store.deleteForToolNamespaces(['%'])).rejects.toThrow();
    expect(await store.deleteForToolNamespaces([NS_OTHER, NS_BOB])).toEqual({ grants: 2, approvals: 0 });
    expect(await count(db, 'apps_bridge_v1_grants')).toBe(0);
    expect(await count(db, 'apps_bridge_v1_viewer_approvals')).toBe(0);
    expect(await store.deleteForToolNamespaces([])).toEqual({ grants: 0, approvals: 0 });
    expect(await count(db, 'apps_bridge_v1_links')).toBe(2);
  });

  it('a raw link code is refused wherever a code hash is expected, without echoing it, and nothing is stored', async () => {
    const { db, store } = await freshDb();
    const raw = 'axl_abcdefghijklmnopqrstuvwxyz234567';
    const calls: Array<() => Promise<unknown>> = [
      () => store.mintLinkCode({ codeHash: raw, userId: ADA, agentId: AGENT, expiresAt: minutes(15), now: T0 }),
      () => store.peekLinkCode(raw, T0),
      () => store.claimLinkCode({ codeHash: raw, platformId: P, appId: APP, appName: 'x', now: T0 }),
      () => store.getLinkByCode(P, APP, raw),
      // Upper-case hex and the wrong length are refused too.
      () => store.peekLinkCode(hash(1).toUpperCase().replace(/0/g, 'A'), T0),
      () => store.peekLinkCode(hash(1).slice(1), T0),
    ];
    for (const call of calls) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain(raw);
      expect(String((err as Error).message)).not.toContain('abcdefghijklmnop');
    }
    expect(await count(db, 'apps_bridge_v1_link_codes')).toBe(0);
    expect(await count(db, 'apps_bridge_v1_links')).toBe(0);

    // The table refuses one too, whoever writes it.
    await expect(
      sql`INSERT INTO apps_bridge_v1_link_codes (code_hash, user_id, agent_id, expires_at) VALUES (${raw}, 'u', 'a', now())`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`INSERT INTO apps_bridge_v1_links (platform_id, app_id, agent_id, linked_by_user_id, app_name, link_code_hash) VALUES ('p', 'a', 'g', 'u', 'n', ${raw})`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
