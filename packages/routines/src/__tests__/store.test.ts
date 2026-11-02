import { describe, it, expect, vi } from 'vitest';
import { sql } from 'kysely';
import { ROUTINE_DEFINITION_MAX_BYTES, RoutineDefinitionSchema } from '@ax/routines-contract';
import { fixture, createInput, webhookInput, plainWebhookInput, now } from './store-fixture.js';
import { createRequestHash, credentialRef, inputHash } from '../definition.js';
const f = fixture();
const update = (r: { agentId: string; routineId: string; revision: string }, patch: Record<string, unknown>, requestId = 'edit') => ({ agentId: r.agentId, routineId: r.routineId, expectedRevision: r.revision, actorUserId: 'other-editor', requestId, patch, now: new Date(now.getTime() + 5000), stopOnly: false });
const taskInput = (requestId: string, goodWhen = 'Nothing waits more than a day.') => ({ ...createInput(requestId), definition: RoutineDefinitionSchema.parse({
  name: 'Inbox', promptBody: 'Keep the inbox under control.', trigger: { kind: 'interval', every: '15m' }, kind: 'stay-on-top', goodWhen,
}) });
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
    const removed = await f.store.updateAuthored(update(row, { trigger: { kind: 'interval', every: '60s' } }, 'remove-hook'));
    const oldJob = (await f.store.pendingCleanup({ limit: 10 }))[0]!;
    await expect(f.store.updateAuthored(update(removed, { trigger: row.webhook }, 'reconfigure'))).rejects.toMatchObject({ toolCode: 'cleanup-pending' });
    const fail = vi.fn(async () => { throw new Error('vault down'); });
    await expect(f.store.runCredentialCleanup(oldJob, fail)).rejects.toThrow('vault down');
    expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(1);
    const cleanup = vi.fn(async () => { });
    expect((await Promise.all([f.store.runCredentialCleanup(oldJob, cleanup), f.store.runCredentialCleanup(oldJob, cleanup)])).sort()).toEqual([false, true]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const configured = await f.store.updateAuthored(update(removed, { trigger: row.webhook }, 'reconfigure'));
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
    const removed = await f.store.updateAuthored(update(row, { trigger: { kind: 'interval', every: '60s' } }, 'remove'));
    const stopped = await f.store.updateAuthored({ ...update(removed, { enabled: false }, 'stop-pending'), stopOnly: true });
    expect(stopped.enabled).toBe(false); expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(1);
  });
  // TASK-1026 D5. The leftover from before the deploy: a row whose `hmac` was dropped then, so it kept its
  // webhook while the cleanup that dropping queued keeps failing. A stop must still go through, with or
  // without a signature setting on the row.
  it('allows an emergency stop on a task with app updates while an old secret’s cleanup is pending', async () => {
    for (const input of [webhookInput(), { ...plainWebhookInput(), agentId: 'b' }]) {
      const row = await f.store.createAuthored(input);
      const job = { agentId: row.agentId, routineId: row.routineId, credentialRef: credentialRef(row), ownerUserId: 'owner' };
      await f.db.insertInto('routines_v1_credential_cleanup').values({ agent_id: row.agentId, routine_id: row.routineId, credential_ref: credentialRef(row), owner_user_id: row.ownerUserId }).execute();
      const stopped = await f.store.updateAuthored({ ...update(row, { enabled: false }, 'stop-leftover'), stopOnly: true });
      expect(stopped.enabled).toBe(false);
      expect(await f.store.pendingCleanup({ limit: 10 })).toContainEqual(job);
      // Saving a secret still waits for it, so the cleanup can't delete the new one.
      const effect = vi.fn(async () => {});
      await expect(f.store.withLockedWebhookSecret({ agentId: row.agentId, routineId: row.routineId, expectedRevision: stopped.revision, operation: 'set', secret: new Uint8Array([1]) }, effect)).rejects.toMatchObject({ toolCode: 'cleanup-pending' });
      expect(effect).not.toHaveBeenCalled();
    }
  });
  it('saves a secret for any task with app updates, and only those', async () => {
    const hook = await f.store.createAuthored(plainWebhookInput());
    await expect(f.store.withLockedWebhookSecret({ agentId: hook.agentId, routineId: hook.routineId, expectedRevision: hook.revision, operation: 'set', secret: new Uint8Array([1]) }, async () => {})).resolves.toEqual({ saved: true });
    const scheduled = await f.store.createAuthored(createInput());
    const effect = vi.fn(async () => {});
    for (const change of [{ operation: 'set' as const, secret: new Uint8Array([1]) }, { operation: 'delete' as const }]) {
      await expect(f.store.withLockedWebhookSecret({ agentId: scheduled.agentId, routineId: scheduled.routineId, expectedRevision: scheduled.revision, ...change }, effect)).rejects.toMatchObject({ toolCode: 'validation', field: 'webhook' });
    }
    expect(effect).not.toHaveBeenCalled();
  });
  // TASK-1026 D4. A stored `hmac` keeps signature checks on and has no control left to author it, so a
  // replacement webhook that leaves it out (an agent, an old client) mustn't turn checks off, delete the
  // secret or reset the evidence. Key order matters: the evidence resets when JSON.stringify differs.
  it('keeps a legacy signature setting and its secret when an edit replaces the webhook without it', async () => {
    const row = await f.store.createAuthored({ ...createInput('legacy-task'), definition: RoutineDefinitionSchema.parse({
      name: 'Inbox', promptBody: 'Keep the inbox under control.', kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.',
      schedule: { kind: 'interval', every: '15m' },
      webhook: { kind: 'webhook', path: '/hook', hmac: { header: 'x-signature', algorithm: 'sha256' }, respondWithin: '10m' },
    }) });
    const evidence = { lastAcceptedAt: now.toISOString(), signatureChecked: true, verifiedAt: null, buckets: [] };
    await sql`UPDATE routines_v1_definitions SET webhook_health = ${JSON.stringify(evidence)}::jsonb WHERE routine_id = ${row.routineId}`.execute(f.db);
    const raw = async (routineId: string) => (await sql<{ webhook_health: unknown; webhook_health_generation: string }>`
      SELECT webhook_health, webhook_health_generation FROM routines_v1_definitions WHERE routine_id = ${routineId}`.execute(f.db)).rows[0];
    const before = await raw(row.routineId);
    expect(before?.webhook_health).toEqual(evidence);
    const result = await f.store.updateAuthored(update(row, { webhook: { kind: 'webhook', path: '/hook', respondWithin: '10m' } }, 'omit-hmac'));
    expect(result.webhook).toStrictEqual(row.webhook);
    expect(JSON.stringify(result.webhook)).toBe(JSON.stringify(row.webhook));
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
    expect(await raw(row.routineId)).toEqual(before);
    // A client that still sends the single legacy `trigger` gets the same.
    const repeat = await f.store.createAuthored({ ...webhookInput(), agentId: 'b' });
    const kept = await f.store.updateAuthored(update(repeat, { trigger: { kind: 'webhook', path: '/hook' } }, 'omit-hmac-trigger'));
    expect(kept.webhook).toStrictEqual(repeat.webhook);
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([]);
  });
  it('refuses an edit that keeping the legacy setting would make too large to store', async () => {
    const row = await f.store.createAuthored(webhookInput());
    const webhook = { kind: 'webhook' as const, path: '/hook' };
    const size = (promptBody: string) => new TextEncoder().encode(JSON.stringify(RoutineDefinitionSchema.parse({ ...webhookInput().definition, promptBody, webhook }))).length;
    // Exactly at the limit without the setting, so only carrying it over pushes it past.
    const promptBody = 'x'.repeat(ROUTINE_DEFINITION_MAX_BYTES - size(''));
    expect(size(promptBody)).toBe(ROUTINE_DEFINITION_MAX_BYTES);
    await expect(f.store.updateAuthored(update(row, { promptBody, webhook }, 'grow'))).rejects.toMatchObject({ toolCode: 'validation', field: 'promptBody' });
    expect(await f.store.findOne(row)).toEqual(row);
  });
  it('removing app updates queues the secret for cleanup, with or without a legacy setting', async () => {
    for (const input of [plainWebhookInput(), { ...webhookInput(), agentId: 'b' }]) {
      const row = await f.store.createAuthored(input);
      const removed = await f.store.updateAuthored(update(row, { trigger: { kind: 'interval', every: '60s' } }, 'remove'));
      expect(removed.webhook).toBeNull();
      expect(await f.store.pendingCleanup({ limit: 10 })).toContainEqual({ agentId: row.agentId, routineId: row.routineId, credentialRef: credentialRef(row), ownerUserId: 'owner' });
      // Adding app updates back waits for it, so the cleanup can't delete a secret saved for them.
      await expect(f.store.updateAuthored(update(removed, { trigger: { kind: 'webhook', path: '/hook' } }, 'readd'))).rejects.toMatchObject({ toolCode: 'cleanup-pending' });
    }
    expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(2);
  });
  it('deleting a task with app updates queues its secret for cleanup', async () => {
    const row = await f.store.createAuthored(plainWebhookInput());
    expect(await f.store.deleteAuthored(update(row, {}))).toEqual({ deleted: true, cleanupPending: true });
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([{ agentId: 'a', routineId: row.routineId, credentialRef: credentialRef(row), ownerUserId: 'owner' }]);
    const scheduled = await f.store.createAuthored(createInput());
    expect(await f.store.deleteAuthored(update(scheduled, {}, 'delete-scheduled'))).toEqual({ deleted: true, cleanupPending: false });
    expect(await f.store.pendingCleanup({ limit: 10 })).toHaveLength(1);
  });
  it('purging an agent queues the secret of each of its tasks with app updates', async () => {
    const hook = await f.store.createAuthored(plainWebhookInput());
    await f.store.createAuthored(createInput());
    await f.store.purgeAgent('a');
    expect(await f.store.pendingCleanup({ limit: 10 })).toEqual([{ agentId: 'a', routineId: hook.routineId, credentialRef: credentialRef(hook), ownerUserId: 'owner' }]);
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

describe('task kind persistence', () => {
  it('persists kind and goodWhen through create and update, and they enter spec_hash', async () => {
    const created = await f.store.createAuthored(taskInput('task-a'));
    expect(created).toMatchObject({ kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' });
    expect(await f.store.findOne(created)).toEqual(created);
    await f.store.createAuthored(taskInput('task-b', 'Nothing waits more than an hour.'));
    const hashes = (await sql<{ spec_hash: string }>`SELECT spec_hash FROM routines_v1_definitions`.execute(f.db)).rows.map(r => r.spec_hash);
    expect(hashes).toHaveLength(2); expect(hashes[0]).not.toBe(hashes[1]);
    const edited = await f.store.updateAuthored(update(created, { goodWhen: 'new' }, 'good-when'));
    expect(edited).toMatchObject({ kind: 'stay-on-top', goodWhen: 'new' });
    expect(await f.store.findOne(created)).toEqual(edited);
    await expect(f.store.updateAuthored(update(edited, { trigger: { kind: 'webhook', path: '/x' } }, 'to-webhook'))).rejects.toMatchObject({ toolCode: 'validation' });
    expect(await f.store.findOne(created)).toEqual(edited);
    const repeat = await f.store.updateAuthored(update(edited, { kind: 'repeat', goodWhen: null }, 'to-repeat'));
    expect(await f.store.findOne(created)).toEqual(repeat); expect(repeat).toMatchObject({ kind: 'repeat', goodWhen: null });
  });
  it('the tick claim, a dispatch and a replayed receipt all carry a task’s kind and goodWhen', async () => {
    const input = taskInput('task-claim'); const created = await f.store.createAuthored(input);
    const task = { kind: 'stay-on-top', goodWhen: 'Nothing waits more than a day.' };
    expect(created).toMatchObject(task);
    expect(await f.store.createAuthored(input)).toEqual(created);
    expect(await f.store.findOperationReceipt({ agentId: 'a', actorUserId: 'editor', operation: 'create', requestId: 'task-claim', inputHash: createRequestHash(input) })).toEqual(created);
    const claimed = await f.store.claimDue({ now: new Date(now.getTime() + 3_600_000), limit: 10, claimWindowMinutes: 1 });
    expect(claimed).toEqual([expect.objectContaining({ routineId: created.routineId, ...task })]);
    const fire = { agentId: 'a', routineId: created.routineId, actorUserId: 'owner', expectedRevision: created.revision, source: 'manual' as const, requestId: 'fire', now };
    const accepted = await f.store.acceptDispatch(fire);
    expect(accepted).toMatchObject({ replayed: false, accepted: { row: task } });
    expect(await f.store.acceptDispatch(fire)).toEqual({ accepted: accepted!.accepted, replayed: true });
  });
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
