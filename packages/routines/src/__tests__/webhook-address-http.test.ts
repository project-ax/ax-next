import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import { registerRoutinesAdminRoutes } from '../../../routines-admin-routes/src/routes.js';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';

let h: RoutineHarness;
afterEach(async () => { await h?.close(); });
describe('task address setup and replacement through real HTTP', () => {
  it('lets a member manage only their task and revokes both old addresses without disturbing a teammate', async () => {
    h = await createRoutineHarness({ authenticatedUserId: 'member', invoke: async (ctx, bus) => {
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); return { kind: 'complete' };
    } });
    const create = (path: string, ctx = h.teamMember) => h.bus.call<unknown, RoutineView>('routines:create', ctx, { agentId: h.teamAgentId, requestId: path,
      definition: RoutineDefinitionSchema.parse({ name: path, promptBody: 'Review {{payload.title}}', schedule: null, webhook: { kind: 'webhook', path, hmac: { header: 'sig', algorithm: 'sha256' } } }) });
    const mine = await create('/mine'), theirs = await create('/theirs', h.teamAdmin);
    const shared = await h.bus.call<unknown, { token: string }>('agents:ensure-webhook-token', h.teamAdmin, { agentId: h.teamAgentId, actor: { userId: h.teamAdmin.userId, isAdmin: false } });
    await registerRoutinesAdminRoutes(h.bus, h.owner);
    const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
    const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
    const transport = await createTestHarness({ plugins: [server] });
    try {
      for (const route of h.routes) await transport.bus.call('http:register-route', h.owner, route);
      const base = `http://127.0.0.1:${server.boundPort()}`;
      const endpoint = (row: RoutineView) => `/settings/routines/${row.agentId}/${row.routineId}/receiver`;
      const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { origin: 'http://localhost', 'x-requested-with': 'ax-admin', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const response = await request(endpoint(mine)); expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const address = await response.json() as { url: string; version: string; legacyActive: boolean };
      expect(address.legacyActive).toBe(false);
      expect(address.url).not.toContain(shared.token);
      expect((await request(endpoint(theirs))).status).toBe(404);
      expect((await request(endpoint(theirs) + '/replace', 'POST', { expectedVersion: address.version })).status).toBe(404);
      for (const ctx of [h.teamAdmin, h.owner]) await expect(h.bus.call('routines:webhook-address', ctx, { agentId: mine.agentId, routineId: mine.routineId })).rejects.toMatchObject({ toolCode: 'forbidden' });
      const body = '{"title":"signed update"}', sig = createHmac('sha256', 'test-secret').update(body).digest('hex');
      const post = (url: string) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', sig }, body });
      expect((await post(`/webhooks/${shared.token}/mine`)).status).toBe(404);
      expect((await post(address.url + '/theirs')).status).toBe(404);
      expect((await post(address.url + '/mine')).status).toBe(202);
      await expect.poll(() => h.invokeCalls.length).toBe(1);
      // Existing jobs at v17 have this marker; the actual backfill is tested separately.
      await h.db.updateTable('routines_v1_definitions').set({ webhook_legacy_enabled: true }).where('agent_id', '=', mine.agentId).execute();
      expect((await post(`/webhooks/${shared.token}/mine`)).status).toBe(202);
      const nextResponse = await request(endpoint(mine) + '/replace', 'POST', { expectedVersion: address.version });
      expect(nextResponse.status).toBe(200);
      expect(nextResponse.headers.get('cache-control')).toBe('no-store');
      const next = await nextResponse.json() as typeof address;
      expect(next.legacyActive).toBe(false);
      expect((await post(address.url + '/mine')).status).toBe(404);
      expect((await post(`/webhooks/${shared.token}/mine`)).status).toBe(404);
      expect((await post(`/webhooks/${shared.token}/theirs`)).status).toBe(202);
      expect((await post(next.url + '/mine')).status).toBe(202);
      expect((await request(endpoint(mine) + '/replace', 'POST', { expectedVersion: address.version })).status).toBe(409);
      const generic = await (await request(`/settings/routines/${mine.agentId}`)).json();
      expect(JSON.stringify(generic)).not.toContain(next.url);
      h.setTeamRole('member', null);
      expect((await request(endpoint(mine))).status).toBe(404);
      expect((await request(endpoint(mine) + '/replace', 'POST', { expectedVersion: next.version })).status).toBe(404);
    } finally { await transport.close(); listening.restore(); }
  }, 120000);
});
