import { sql } from 'kysely';
import { runRoutinesMigration } from '../migrations.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { RoutineDefinitionSchema, RoutineWebhookStatusOutputSchema, type RoutineView, type RoutineWebhookStatus } from '@ax/routines-contract';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { createRoutinesStore } from '../store.js';
import { registerRoutinesAdminRoutes } from '../../../routines-admin-routes/src/routes.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';
import { systemClock } from '../clock.js';
let h: RoutineHarness;
let now = new Date('2031-01-01T12:00:20Z');
afterEach(async () => { await h?.close(); });
const clock = { now: () => now, sleep: systemClock.sleep };
async function create(app?: 'stripe' | 'slack' | 'zendesk', ctx = h.owner) {
  return h.bus.call<unknown, RoutineView>('routines:create', ctx, { agentId: ctx === h.owner ? h.agentId : h.teamAgentId, requestId: `new-${app ?? 'other'}`,
    definition: RoutineDefinitionSchema.parse({ name: 'App updates', promptBody: 'Check updates', kind: 'stay-on-top', goodWhen: 'Handled',
      schedule: { kind: 'interval', every: '1h' }, webhook: { kind: 'webhook', path: `/${app ?? 'other'}`, ...(app ? { hmac: { app } } : {}) } }) });
}
const status = (row: RoutineView, ctx = h.owner) => h.bus.call<unknown, RoutineWebhookStatus>('routines:webhook-status', ctx, { agentId: row.agentId, routineId: row.routineId });
async function address(row: RoutineView, ctx = h.owner) { return h.bus.call<unknown, { token: string; version: string }>('routines:webhook-address', ctx, { agentId: row.agentId, routineId: row.routineId }); }
function signed(app: 'stripe' | 'slack' | 'zendesk', body: string) {
  const timestamp = app === 'zendesk' ? now.toISOString() : String(Math.floor(now.getTime() / 1000));
  const prefix = app === 'stripe' ? `${timestamp}.` : app === 'slack' ? `v0:${timestamp}:` : timestamp;
  const sig = createHmac('sha256', 'test-secret').update(prefix).update(body).digest(app === 'zendesk' ? 'base64' : 'hex');
  return app === 'stripe' ? { 'stripe-signature': `t=${timestamp},v1=${sig}` } : app === 'slack' ? { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': `v0=${sig}` } : { 'x-zendesk-webhook-signature-timestamp': timestamp, 'x-zendesk-webhook-signature': sig };
}
async function http(effect: (base: string) => Promise<void>) {
  if (!h.routes.some(route => route.path === '/settings/routines/:agentId/:routineId/receiver/status')) await registerRoutinesAdminRoutes(h.bus, h.owner);
  const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
  const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
  const transport = await createTestHarness({ plugins: [server] });
  try {
    for (const route of h.routes) await transport.bus.call('http:register-route', h.owner, route);
    await effect(`http://127.0.0.1:${server.boundPort()}`);
  } finally { await transport.close(); listening.restore(); }
}
describe('private durable webhook connection evidence', () => {
  it('records only accepted signed provider tests, counts failures, and survives restart without claiming execution', async () => {
    now = new Date('2031-01-01T12:00:20Z'); h = await createRoutineHarness({ clock, authenticatedUserId: 'owner' });
    for (const app of ['stripe', 'slack', 'zendesk'] as const) {
      const row = await create(app), receiver = await address(row);
      await http(async base => {
        const body = '{"private":"DO-NOT-RETAIN-IN-HEALTH"}';
        const send = (headers: Record<string, string>) => fetch(`${base}/webhooks/${receiver.token}/${app}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
        expect((await send({})).status).toBe(401);
        expect((await status(row)).lastAcceptedAt).toBeNull();
        expect((await send(signed(app, body))).status).toBe(202);
        expect(h.invokeCalls).toHaveLength(0); // Durable nudge, no runner execution claim.
        const endpoint = `${base}/settings/routines/${row.agentId}/${row.routineId}/receiver/status`;
        const response = await fetch(endpoint);
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        expect(RoutineWebhookStatusOutputSchema.parse(await response.json())).toMatchObject({ lastAcceptedAt: now.toISOString(), signatureChecked: true, app, refusals: [{ reason: 'signature', count: 1 }] });
      });
      const health = await h.db.selectFrom('routines_v1_definitions').select('webhook_health').where('routine_id', '=', row.routineId).executeTakeFirstOrThrow();
      expect(JSON.stringify(health)).not.toMatch(/DO-NOT|test-secret|signature.*v0=|rt_/);
    }
    h = await h.restart();
    const rows = await createRoutinesStore(h.db).list({ agentId: h.agentId });
    for (const row of rows.filter(row => row.webhook !== null)) {
      expect(await h.bus.call('routines:webhook-status', h.owner, { agentId: row.agentId, routineId: row.routineId })).toMatchObject({ lastAcceptedAt: now.toISOString(), signatureChecked: true, refusals: [{ reason: 'signature', count: 1 }] });
    }
  }, 120000);
  it('upgrades existing schema19 tasks without changing addresses, schedules or retained inbox entries', async () => {
    now = new Date('2031-01-01T12:00:20Z'); h = await createRoutineHarness({ clock, authenticatedUserId: 'owner' });
    const row = await create(), receiver = await address(row), store = createRoutinesStore(h.db);
    await http(async base => { expect((await fetch(`${base}/webhooks/${receiver.token}/other`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"existing":true}' })).status).toBe(202); });
    const before = await store.findOne(row);
    const inbox = await h.db.selectFrom('routines_v1_task_events').selectAll().execute();
    await sql`ALTER TABLE routines_v1_definitions DROP COLUMN webhook_health, DROP COLUMN webhook_health_generation`.execute(h.db);
    await sql`DELETE FROM routines_schema_versions WHERE version=20`.execute(h.db);
    await runRoutinesMigration(h.db); await runRoutinesMigration(h.db);
    expect(await store.findOne(row)).toEqual(before);
    expect(await address(row)).toEqual(receiver);
    expect(await h.db.selectFrom('routines_v1_task_events').selectAll().execute()).toEqual(inbox);
    expect(await status(row)).toMatchObject({ setupReady: true, lastAcceptedAt: null, refusals: [] });
  }, 120000);
  it('distinguishes Slack address verification and filters from accepted task input', async () => {
    now = new Date('2031-01-01T12:00:20Z'); h = await createRoutineHarness({ clock, authenticatedUserId: 'owner' });
    const row = await create('slack'), receiver = await address(row);
    await http(async base => {
      const body = '{"type":"url_verification","challenge":"fixture-challenge"}';
      const send = (headers: Record<string, string>) => fetch(`${base}/webhooks/${receiver.token}/slack`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
      expect((await send({})).status).toBe(401);
      expect((await status(row)).verifiedAt).toBeNull();
      const ok = await send(signed('slack', body)); expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ challenge: 'fixture-challenge' });
      expect(await status(row)).toMatchObject({ verifiedAt: now.toISOString(), lastAcceptedAt: null, signatureChecked: false });
      expect(await h.db.selectFrom('routines_v1_task_events').selectAll().execute()).toEqual([]);
    });
  }, 120000);
  it('serializes refusal increments, bounds 60-minute retention, and never marks failures connected', async () => {
    now = new Date('2031-01-01T12:00:20Z'); h = await createRoutineHarness({ clock, authenticatedUserId: 'owner' });
    const row = await create(), receiver = await address(row), store = createRoutinesStore(h.db), stored = (await store.findOne(row))!;
    const proof = { kind: 'task' as const, token: receiver.token, generation: (await store.webhookGeneration(stored))! };
    await Promise.all(Array.from({ length: 20 }, () => store.observeWebhook({ row: stored, address: proof, observation: 'capacity', now }, async () => true)));
    expect(await status(row)).toMatchObject({ lastAcceptedAt: null, refusals: [{ reason: 'capacity', count: 20 }] });
    for (let i = 0; i < 65; i++) {
      now = new Date(now.getTime() + 60000);
      await store.observeWebhook({ row: stored, address: proof, observation: 'signature', now }, async () => true);
    }
    expect(await status(row)).toMatchObject({ lastAcceptedAt: null, refusals: [{ reason: 'signature', count: 60 }] });
    const raw = await h.db.selectFrom('routines_v1_definitions').select('webhook_health').where('routine_id', '=', row.routineId).executeTakeFirstOrThrow();
    expect((raw.webhook_health as { buckets: unknown[] }).buckets).toHaveLength(60);
    now = new Date(now.getTime() + 3600000);
    expect((await status(row)).refusals).toEqual([]);
    await store.pruneWebhookRefusals(now);
    const pruned = await h.db.selectFrom('routines_v1_definitions').select('webhook_health').where('routine_id', '=', row.routineId).executeTakeFirstOrThrow();
    expect((pruned.webhook_health as { buckets: unknown[] }).buckets).toEqual([]);
  }, 120000);
  it('fences old credential/address observations and denies other owners, team admins and demoted members', async () => {
    now = new Date('2031-01-01T12:00:20Z'); h = await createRoutineHarness({ clock, authenticatedUserId: 'owner' });
    const row = await create('stripe', h.teamMember), receiver = await address(row, h.teamMember), store = createRoutinesStore(h.db), stored = (await store.findOne(row))!;
    const proof = { kind: 'task' as const, token: receiver.token, generation: (await store.webhookGeneration(stored))! };
    await store.observeWebhook({ row: stored, address: proof, observation: 'accepted', now }, async () => true);
    for (const ctx of [h.teamAdmin, h.owner]) await expect(status(row, ctx)).rejects.toMatchObject({ toolCode: 'forbidden' });
    await expect(store.webhookStatus({ ...row, actorUserId: 'peer', now })).rejects.toMatchObject({ toolCode: 'not-found' });
    const uncertain = new Error('Vault response was lost');
    await expect(store.withLockedWebhookSecret({ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, operation: 'set', secret: Buffer.from('new-secret') }, async () => { throw uncertain; })).rejects.toBe(uncertain);
    expect((await status(row, h.teamMember)).lastAcceptedAt).toBeNull();
    await h.bus.call('routines:set-webhook-secret', h.teamMember, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, operation: 'set', secret: Buffer.from('new-secret') });
    await store.observeWebhook({ row: stored, address: proof, observation: 'accepted', now }, async () => true);
    expect((await status(row, h.teamMember)).lastAcceptedAt).toBeNull();
    expect(await store.admitTaskEvent({ row: stored, address: proof, payload: {}, deliveryId: null, now }, async () => { throw new Error('Must not persist'); })).toBe('missing');
    await h.bus.call('routines:replace-webhook-address', h.teamMember, { agentId: row.agentId, routineId: row.routineId, expectedVersion: receiver.version });
    await store.observeWebhook({ row: stored, address: proof, observation: 'signature', now }, async () => true);
    expect((await status(row, h.teamMember)).refusals).toEqual([]);
    h.setTeamRole('member', null);
    await expect(status(row, h.teamMember)).rejects.toBeDefined();
  }, 120000);
});
