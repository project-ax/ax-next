import { describe, it, expect, vi } from 'vitest';
import { sql } from 'kysely';
import { fixture, createInput, webhookInput, now } from './store-fixture.js';
import { credentialRef, inputHash } from '../definition.js';
const f = fixture();
const update = (r: { agentId: string; routineId: string; revision: string }, patch: Record<string, unknown>, requestId = 'edit') => ({ agentId: r.agentId, routineId: r.routineId, expectedRevision: r.revision, actorUserId: 'other-editor', requestId, patch, now: new Date(now.getTime() + 5000), stopOnly: false });
describe('transactional authored store', () => {
  it('creates one row for concurrent retry and returns the committed result after response loss', async () => {
    const input = createInput(); const [a, b] = await Promise.all([f.store.createAuthored(input), f.store.createAuthored(input)]);
    expect(a).toEqual(b); expect(a.ownerUserId).toBe('owner'); expect(a.promptBody).toBe(input.definition.promptBody);
    expect(a.routineId).toMatch(/^rtn_[0-9a-f]{32}$/); expect(a.revision).toMatch(/^rev_[0-9a-f]{32}$/);
    expect((await f.store.list({ agentId: 'a' }))).toHaveLength(1);
    const replay = await f.store.createAuthored({ ...input, now: new Date(), ownerUserId: 'new-owner' });
    expect(replay).toEqual(a); expect(replay.nextRunAt).toBeInstanceOf(Date);
    expect(await f.store.findOperationReceipt({ agentId: 'a', actorUserId: 'editor', operation: 'create', requestId: input.requestId, inputHash: inputHash({ agentId: 'a', definition: input.definition }) })).toEqual(a);
    expect(await f.store.findOperationReceipt({ agentId: 'a', actorUserId: 'owner', operation: 'create', requestId: input.requestId, inputHash: 'irrelevant' })).toBeNull();
  });
  it('conflicts on reused request IDs with changed input and scopes receipts to authenticated editor', async () => {
    const input = createInput(); await f.store.createAuthored(input);
    await expect(f.store.createAuthored({ ...input, definition: { ...input.definition, name: 'changed' } })).rejects.toMatchObject({ toolCode: 'request-conflict' });
    await f.store.createAuthored({ ...input, actorUserId: 'second-editor' });
    expect(await f.store.list({ agentId: 'a' })).toHaveLength(2);
  });
  it('CAS permits exactly one concurrent edit, preserves owner, and replays before stale gating', async () => {
    const row = await f.store.createAuthored(createInput());
    const results = await Promise.allSettled([f.store.updateAuthored(update(row, { name: 'first' }, 'u1')), f.store.updateAuthored(update(row, { name: 'second' }, 'u2'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { toolCode: 'revision-conflict' } });
    const winner = results[0]!.status === 'fulfilled' ? 0 : 1;
    const result = await f.store.updateAuthored(update(row, { name: winner === 0 ? 'first' : 'second' }, winner === 0 ? 'u1' : 'u2'));
    expect(result.ownerUserId).toBe('owner'); expect(result.revision).not.toBe(row.revision);
  });
  it('prompt edits preserve schedule; disabling and schedule edits recompute it', async () => {
    const row = await f.store.createAuthored(createInput());
    const edited = await f.store.updateAuthored(update(row, { promptBody: '\nnew\n' }));
    expect(edited.nextRunAt).toEqual(row.nextRunAt); expect(edited.promptBody).toBe('\nnew\n');
    const stopped = await f.store.updateAuthored({ ...update(edited, { enabled: false }, 'stop'), stopOnly: true });
    expect(stopped.nextRunAt).toBeNull();
    await expect(f.store.updateAuthored({ ...update(stopped, { enabled: false, name: 'sneak' }, 'bad-stop'), stopOnly: true })).rejects.toMatchObject({ toolCode: 'forbidden' });
    const enabled = await f.store.updateAuthored(update(stopped, { enabled: true, trigger: { kind: 'interval', every: '5m' } }, 'start'));
    expect(enabled.nextRunAt).toEqual(new Date(now.getTime() + 305000));
    await f.store.advance({ agentId: 'a', routineId: row.routineId, expectedRevision: row.revision, nextRunAt: null, lastRunAt: now });
    expect(await f.store.findOne(row)).toEqual(enabled);
  });
  it('validates merged definitions before writing or committing a receipt', async () => {
    const row = await f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, activeHours: { start: '09:00', end: '17:00', tz: 'UTC' } } });
    await expect(f.store.updateAuthored(update(row, { trigger: { kind: 'webhook', path: '/hook' } }))).rejects.toMatchObject({ toolCode: 'validation' });
    expect(await f.store.findOne(row)).toEqual(row);
    expect((await sql`SELECT * FROM routines_v1_requests WHERE operation='update'`.execute(f.db)).rows).toHaveLength(0);
    const edited = await f.store.updateAuthored(update(row, { trigger: { kind: 'webhook', path: '/hook' }, activeHours: null }));
    expect(edited.activeHours).toBeNull();
  });
  it('unique webhook path is scoped to agent and serializes concurrent creates', async () => {
    const results = await Promise.allSettled([f.store.createAuthored(webhookInput('h1')), f.store.createAuthored(webhookInput('h2'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { toolCode: 'webhook-path-conflict' } });
    await f.store.createAuthored({ ...webhookInput('h3'), agentId: 'b' });
    expect(await f.store.findWebhook({ agentId: 'c', path: '/hook' })).toBeNull();
    expect((await f.store.findWebhook({ agentId: 'a', path: '/hook' }))?.ownerUserId).toBe('owner');
  });
  it('wrong-agent reads and writes reveal no row', async () => {
    const row = await f.store.createAuthored(createInput());
    expect(await f.store.list({ agentId: 'b' })).toEqual([]); expect(await f.store.findOne({ ...row, agentId: 'b' })).toBeNull();
    await expect(f.store.updateAuthored({ ...update(row, { name: 'x' }), agentId: 'b' })).rejects.toMatchObject({ toolCode: 'not-found' });
    await expect(f.store.deleteAuthored({ ...update(row, {}), agentId: 'b' })).rejects.toMatchObject({ toolCode: 'not-found' });
  });
  it('delete atomically queues the exact owner credential and retries after row disappearance', async () => {
    const row = await f.store.createAuthored(webhookInput()); const input = update(row, {});
    expect(await f.store.deleteAuthored(input)).toEqual({ deleted: true, cleanupPending: true });
    expect(await f.store.deleteAuthored(input)).toEqual({ deleted: true, cleanupPending: true });
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([{ agentId: 'a', routineId: row.routineId, credentialRef: credentialRef(row), ownerUserId: 'owner' }]);
    expect(await f.store.findOne(row)).toBeNull();
  });
  it('unknown database failures remain infrastructure errors and roll back both effect and receipt', async () => {
    await sql`ALTER TABLE routines_v1_definitions ADD CONSTRAINT test_unknown_check CHECK (name <> 'reject')`.execute(f.db);
    try { await expect(f.store.createAuthored({ ...createInput(), definition: { ...createInput().definition, name: 'reject' } })).rejects.toMatchObject({ code: '23514' }); }
    finally { await sql`ALTER TABLE routines_v1_definitions DROP CONSTRAINT test_unknown_check`.execute(f.db); }
    expect(await f.store.list({ agentId: 'a' })).toEqual([]);
    expect((await sql`SELECT * FROM routines_v1_requests`.execute(f.db)).rows).toEqual([]);
  });
  it('cleanup fences stale discovery, concurrent drains, failure, and new secret reconfiguration', async () => {
    const row = await f.store.createAuthored(webhookInput());
    const removed = await f.store.updateAuthored(update(row, { trigger: { kind: 'webhook', path: '/hook' } }, 'remove-hmac'));
    const oldJob = (await f.store.pendingCleanup({ limit: 10 }))[0]!;
    await expect(f.store.updateAuthored(update(removed, { trigger: row.trigger }, 'reconfigure'))).rejects.toMatchObject({ toolCode: 'cleanup-pending' });
    const fail = vi.fn(async () => { throw new Error('vault down'); });
    await expect(f.store.runCredentialCleanup(oldJob, fail)).rejects.toThrow('vault down');
    expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(1);
    const cleanup = vi.fn(async () => { });
    expect((await Promise.all([f.store.runCredentialCleanup(oldJob, cleanup), f.store.runCredentialCleanup(oldJob, cleanup)])).sort()).toEqual([false, true]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const configured = await f.store.updateAuthored(update(removed, { trigger: row.trigger }, 'reconfigure'));
    let secret = 'old'; await f.store.withLockedWebhookSecret({ ...configured, expectedRevision: configured.revision, operation: 'set', secret: new Uint8Array([1]) }, async () => { secret = 'new'; });
    expect(await f.store.runCredentialCleanup(oldJob, async () => { secret = 'deleted'; })).toBe(false);
    expect(secret).toBe('new');
  });
  it('keeps purged-agent credential cleanup drainable without resurrecting routine data', async () => {
    const row = await f.store.createAuthored(webhookInput());
    await f.store.purgeAgent('a');
    const job = (await f.store.pendingCleanup({ limit: 10 }))[0]!;
    expect(job.credentialRef).toBe(credentialRef(row));
    const remove = vi.fn(async () => {});
    expect(await f.store.runCredentialCleanup(job, remove)).toBe(true);
    expect(remove).toHaveBeenCalledWith(job);
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
    expect(await f.store.list({ agentId: 'a' })).toEqual([]);
  });
  it('allows an emergency stop while credential cleanup is pending', async () => {
    const row = await f.store.createAuthored(webhookInput());
    const removed = await f.store.updateAuthored(update(row, { trigger: { kind: 'webhook', path: '/hook' } }, 'remove'));
    const stopped = await f.store.updateAuthored({ ...update(removed, { enabled: false }, 'stop-pending'), stopOnly: true });
    expect(stopped.enabled).toBe(false); expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(1);
  });
  it('secret writes use revision and definition lock before invoking the vault', async () => {
    const row = await f.store.createAuthored(webhookInput()); const effect = vi.fn(async () => { });
    await expect(f.store.withLockedWebhookSecret({ ...row, expectedRevision: 'stale', operation: 'delete' }, effect)).rejects.toMatchObject({ toolCode: 'revision-conflict' });
    expect(effect).not.toHaveBeenCalled();
    await f.store.withLockedWebhookSecret({ ...row, expectedRevision: row.revision, operation: 'delete' }, effect); expect(effect).toHaveBeenCalledTimes(1);
  });
});

it('generates the approved opaque rtn identity for new authored routines and preserves exact replay identity', async () => {
  const row = await f.store.createAuthored(createInput('id-spelling'));
  expect(row.routineId).toMatch(/^rtn_[a-f0-9]{32}$/);
  expect((await f.store.createAuthored(createInput('id-spelling'))).routineId).toBe(row.routineId);
});

describe('enabled routines persistence and scheduling', () => {
  it('defaults to enabled, persists disabling, excludes due claims and resumes when enabled', async () => {
    const later = new Date(now.getTime() + 3_600_000);
    const claim = async () => (await f.store.claimDue({ now: later, limit: 10, claimWindowMinutes: 1 })).filter(r => r.routineId === row.routineId);
    const row = await f.store.createAuthored(createInput('enabled-claims'));
    expect(row.enabled).toBe(true);
    const stopped = await f.store.updateAuthored({ ...update(row, { enabled: false }, 'stop-claims'), stopOnly: true });
    expect((await f.store.findOne({ agentId: row.agentId, routineId: row.routineId }))?.enabled).toBe(false);
    expect(await claim()).toEqual([]);
    await f.store.updateAuthored(update(stopped, { enabled: true }, 'start-claims'));
    expect(await claim()).toHaveLength(1);
  });
});
