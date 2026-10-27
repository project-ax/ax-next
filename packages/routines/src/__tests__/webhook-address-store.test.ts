import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { fixture, now, webhookInput } from './store-fixture.js';
import { createRoutinesStore } from '../store.js';
import { createRepeatDeliveryStore } from '../repeat-deliveries.js';
import { runRoutinesMigration } from '../migrations.js';

const f = fixture({ max: 2, connectionTimeoutMillis: 1500 });
const task = (id: string) => {
  const input = webhookInput(id);
  return { ...input, definition: { ...input.definition, name: id, webhook: { kind: 'webhook' as const, path: `/${id}` } } };
};
const owner = { actorUserId: 'owner' };
const persist = (bytes: Uint8Array) => Promise.resolve({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });

describe('private task webhook addresses', () => {
  it('keeps setup lock waiters from taking the connection needed to persist an incoming update', async () => {
    const a = await f.store.createAuthored(task('pool'));
    const old = await f.store.ensureWebhookAddress({ ...a, ...owner });
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const admission = createRepeatDeliveryStore(f.db, 'test').admit({ row: a, payload: {}, deliveryId: null, now, address: { kind: 'task', token: old.token } }, async bytes => {
      started(); await gate;
      // The real blob facade uses the same database pool outside this transaction.
      await sql`SELECT 1`.execute(f.db);
      return persist(bytes);
    });
    await entered;
    const replace = f.store.replaceWebhookAddress({ ...a, ...owner, expectedVersion: old.version });
    await new Promise(r => setTimeout(r, 50));
    release();
    const results = await Promise.allSettled([admission, replace]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 'accepted' });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
  });
  it('gives new tasks independent addresses without a shared alias or any generic-view/receipt/payload leak', async () => {
    const a = await f.store.createAuthored(task('a'));
    const b = await f.store.createAuthored(task('b'));
    const one = await f.store.ensureWebhookAddress({ ...a, ...owner });
    const two = await f.store.ensureWebhookAddress({ ...b, ...owner });
    expect(one.token).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(two.token).not.toBe(one.token);
    expect(one.legacyActive).toBe(false);
    expect(await f.store.findWebhook({ agentId: a.agentId, path: '/a', legacyOnly: true })).toBeNull();
    expect(await f.store.findWebhookByToken({ token: one.token, path: '/a' })).toEqual(a);
    expect(await f.store.findWebhookByToken({ token: one.token, path: '/b' })).toBeNull();
    expect(await createRoutinesStore(f.db).ensureWebhookAddress({ ...a, ...owner })).toEqual(one);
    const snapshots = [await f.store.findOne(a), await f.store.list(a), await f.store.createAuthored(task('a'))];
    const receipt = await f.db.selectFrom('routines_v1_requests').select('result').execute();
    expect(JSON.stringify([snapshots, receipt])).not.toContain(one.token);
    const write = vi.fn(persist);
    expect(await createRepeatDeliveryStore(f.db, 'test').admit({ row: a, payload: {}, deliveryId: null, now, address: { kind: 'task', token: one.token } }, write)).toBe('accepted');
    expect(Buffer.from(write.mock.calls[0]![0]).toString()).not.toContain(one.token);
  });

  it('migrates existing jobs unchanged, keeps both setup addresses, and cuts over only the replaced task across restart/repair', async () => {
    const a = await f.store.createAuthored(task('legacy-a'));
    const b = await f.store.createAuthored(task('legacy-b'));
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN webhook_address_token, DROP COLUMN webhook_legacy_enabled; DELETE FROM routines_schema_versions WHERE version=18`.execute(f.db);
    await runRoutinesMigration(f.db);
    expect(await f.store.findOne(a)).toEqual(a);
    expect(await f.store.findWebhook({ agentId: a.agentId, path: '/legacy-a', legacyOnly: true })).toEqual(a);
    const old = await f.store.ensureWebhookAddress({ ...a, ...owner });
    expect(old.legacyActive).toBe(true);
    const other = await f.store.ensureWebhookAddress({ ...b, ...owner });
    const next = await f.store.replaceWebhookAddress({ ...a, ...owner, expectedVersion: old.version });
    expect(next.legacyActive).toBe(false);
    expect(next.token).not.toBe(old.token);
    expect(await f.store.findWebhookByToken({ token: old.token, path: '/legacy-a' })).toBeNull();
    expect(await f.store.findWebhook({ agentId: a.agentId, path: '/legacy-a', legacyOnly: true })).toBeNull();
    expect(await f.store.findWebhook({ agentId: b.agentId, path: '/legacy-b', legacyOnly: true })).toEqual(b);
    expect(await f.store.ensureWebhookAddress({ ...b, ...owner })).toEqual(other);
    await expect(f.store.replaceWebhookAddress({ ...a, ...owner, expectedVersion: old.version })).rejects.toMatchObject({ toolCode: 'revision-conflict' });
    await sql`DELETE FROM routines_schema_versions WHERE version=18`.execute(f.db);
    await runRoutinesMigration(f.db);
    expect(await createRoutinesStore(f.db).ensureWebhookAddress({ ...a, ...owner })).toEqual(next);
  });

  it('revokes on owner change, webhook removal and deletion, including reuse of the old path', async () => {
    let a = await f.store.createAuthored(task('owner-change'));
    const old = await f.store.ensureWebhookAddress({ ...a, ...owner });
    await f.store.reconcileOwners({ agents: [{ agentId: a.agentId, ownerUserId: 'next' }] });
    expect(await f.store.findWebhookByToken({ token: old.token, path: '/owner-change' })).toBeNull();
    await expect(f.store.ensureWebhookAddress({ ...a, ...owner })).rejects.toMatchObject({ toolCode: 'not-found' });
    a = (await f.store.findOne(a))!;
    const nextOwner = { actorUserId: 'next' };
    const current = await f.store.ensureWebhookAddress({ ...a, ...nextOwner });
    expect(current.legacyActive).toBe(false);
    a = await f.store.updateAuthored({ ...a, ...nextOwner, expectedRevision: a.revision, requestId: 'remove-hook', patch: { schedule: { kind: 'interval', every: '1h' }, webhook: null }, now, stopOnly: false });
    a = await f.store.updateAuthored({ ...a, ...nextOwner, expectedRevision: a.revision, requestId: 'restore-hook', patch: { webhook: { kind: 'webhook', path: '/owner-change' } }, now, stopOnly: false });
    expect(await f.store.findWebhookByToken({ token: current.token, path: '/owner-change' })).toBeNull();
    const beforeDelete = await f.store.ensureWebhookAddress({ ...a, ...nextOwner });
    await f.store.deleteAuthored({ ...a, ...nextOwner, expectedRevision: a.revision, requestId: 'delete', now });
    const recreated = await f.store.createAuthored({ ...task('owner-change'), requestId: 'recreated' });
    expect(await f.store.findWebhookByToken({ token: beforeDelete.token, path: '/owner-change' })).toBeNull();
    expect((await f.store.ensureWebhookAddress({ ...recreated, ...owner })).token).not.toBe(beforeDelete.token);
  });

  it('fences both task-token and legacy-alias admissions authenticated before a replacement', async () => {
    const a = await f.store.createAuthored(task('race'));
    await f.db.updateTable('routines_v1_definitions').set({ webhook_legacy_enabled: true }).where('routine_id', '=', a.routineId).execute();
    const old = await f.store.ensureWebhookAddress({ ...a, ...owner });
    const fresh = await f.store.replaceWebhookAddress({ ...a, ...owner, expectedVersion: old.version });
    expect((await f.store.findOne(a))?.revision).toBe(a.revision);
    const write = vi.fn(persist);
    const deliveries = createRepeatDeliveryStore(f.db, 'test');
    for (const address of [{ kind: 'task' as const, token: old.token }, { kind: 'legacy' as const, token: 'old-agent-token' }]) {
      expect(await deliveries.admit({ row: a, payload: {}, deliveryId: null, now, address }, write, async () => true)).toBe('missing');
    }
    expect(write).not.toHaveBeenCalled();
    expect(await deliveries.admit({ row: a, payload: {}, deliveryId: null, now, address: { kind: 'task', token: fresh.token } }, write)).toBe('accepted');
  });

  it('lets a committed admission finish before replacement and rechecks a revoked agent token under the lock', async () => {
    const a = await f.store.createAuthored(task('locked'));
    await f.db.updateTable('routines_v1_definitions').set({ webhook_legacy_enabled: true }).where('routine_id', '=', a.routineId).execute();
    const old = await f.store.ensureWebhookAddress({ ...a, ...owner });
    const deliveries = createRepeatDeliveryStore(f.db, 'test');
    const write = vi.fn(persist);
    expect(await deliveries.admit({ row: a, payload: {}, deliveryId: null, now, address: { kind: 'legacy', token: 'revoked' } }, write, async () => false)).toBe('missing');
    expect(write).not.toHaveBeenCalled();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const admit = deliveries.admit({ row: a, payload: {}, deliveryId: null, now, address: { kind: 'task', token: old.token } }, async bytes => { started(); await gate; return persist(bytes); });
    await entered;
    let replaced = false;
    const replace = f.store.replaceWebhookAddress({ ...a, ...owner, expectedVersion: old.version }).then(value => { replaced = true; return value; });
    await new Promise(r => setTimeout(r, 30));
    expect(replaced).toBe(false);
    release();
    expect(await admit).toBe('accepted');
    expect((await replace).token).not.toBe(old.token);
    expect((await deliveries.claim(now))?.accepted.row.routineId).toBe(a.routineId);
  });
});
