import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createRoutinesStore } from '../store.js';
import { createHmac } from 'node:crypto';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import type { HttpRequest, HttpResponse } from '@ax/http-server';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
const definition = (hmac?: {
  header: string;
  algorithm: 'sha256' | 'sha1';
  prefix?: string;
}) => RoutineDefinitionSchema.parse({ name: 'Hook', promptBody: 'Review {{payload.title}}', trigger: { kind: 'webhook', path: '/hook', events: ['push'], ...(hmac ? { hmac } : {}) } });
async function setup(hmac?: Parameters<typeof definition>[0]) {
  h = await createRoutineHarness({ invoke: async (ctx, bus) => { await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, contentBlocks: [{ type: 'text', text: 'done' }] }); return { kind: 'complete' }; } });
  const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.agentId, requestId: 'create', definition: definition(hmac) });
  const { token } = await h.bus.call<unknown, {
    token: string;
  }>('agents:ensure-webhook-token', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
  return { row, token };
}
async function request(token: string, options: {
  rawPath?: string;
  splat?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
} = {}) {
  const route = h.routes.find(r => r.path === '/webhooks/:token/*')!;
  expect(route).toBeDefined();
  expect(route.bypassCsrf).toBe(true);
  let code = 200;
  const splat = options.splat ?? 'hook';
  await route.handler({ path: options.rawPath ?? `/webhooks/${token}/${splat}`, params: { token, '*': splat }, headers: { 'content-type': 'application/json', ...options.headers }, body: Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body ?? '{"title":"test"}') } as HttpRequest, { status(value: number) { code = value; return this; }, end() { }, json() { } } as HttpResponse);
  return code;
}
describe('single registered request-time DB webhook route', () => {
  it('registers once and dispatches JSON and forms through the current DB definition', async () => {
    const { row, token } = await setup();
    expect(await request(token)).toBe(202);
    expect(await request(token, { body: 'title=form', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).toBe(202);
    await expect.poll(async () => (await h.bus.call<unknown, {
      fires: unknown[];
    }>('routines:recent-fires', h.owner, { agentId: row.agentId, routineId: row.routineId })).fires.length).toBe(2);
    expect(h.invokeCalls).toHaveLength(2);
    expect(h.routes.filter(r => r.path.startsWith('/webhooks/'))).toHaveLength(1);
  });
  it.each([{ algorithm: 'sha256', prefix: 'sha256=' }, { algorithm: 'sha1', prefix: 'sha1=' }, { algorithm: 'sha256', prefix: undefined }] as const)('checks raw $algorithm HMAC with prefix $prefix before accepting', async ({ algorithm, prefix }) => {
    const { token } = await setup({ header: 'X-Signature', algorithm, ...(prefix === undefined ? {} : { prefix }) });
    const body = '{"title": "signed"}';
    const signature = createHmac(algorithm, 'test-secret').update(body).digest('hex');
    expect(await request(token, { body, headers: { 'x-signature': `${prefix ?? ''}${signature}` } })).toBe(202);
    expect(await request(token, { body: body + ' ', headers: { 'x-signature': signature } })).toBe(401);
    expect(await request(token)).toBe(401);
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('rejects invalid tokens, raw splat paths, bodies and filtered events', async () => {
    const { token } = await setup();
    expect(await request('wrong')).toBe(404);
    for (const splat of ['../hook', '%68ook', 'a//hook', 'hook/', 'hook?x', ''])
      expect(await request(token, { splat })).toBe(404);
    expect(await request(token, { body: 'broken' })).toBe(400);
    expect(await request(token, { body: Buffer.alloc(1024 * 1024 + 1) })).toBe(413);
    expect(await request(token, { headers: { 'content-type': 'text/plain' } })).toBe(415);
    expect(await request(token, { headers: { 'x-github-event': 'ping' } })).toBe(204);
    expect(h.invokeCalls).toHaveLength(0);
    expect(await request(token, { headers: { 'x-github-event': 'push' } })).toBe(202);
  });
  it('rechecks disable, path edits, deletion and token rotation without registering new routes', async () => {
    let { row, token } = await setup();
    const count = h.routes.length;
    const update = async (patch: object) => { row = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: crypto.randomUUID(), patch }); };
    await update({ enabled: false });
    expect(await request(token)).toBe(404);
    await update({ enabled: true, trigger: { kind: 'webhook', path: '/renamed' } });
    expect(await request(token)).toBe(404);
    expect(await request(token, { splat: 'renamed' })).toBe(202);
    const rotated = await h.bus.call<unknown, {
      token: string;
    }>('agents:rotate-webhook-token', h.owner, { agentId: h.agentId, actor: { userId: h.owner.userId, isAdmin: false } });
    expect(await request(token, { splat: 'renamed' })).toBe(404);
    token = rotated.token;
    expect(await request(token, { splat: 'renamed' })).toBe(202);
    await h.bus.call('routines:delete', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: 'delete' });
    expect(await request(token, { splat: 'renamed' })).toBe(404);
    expect(h.routes.length).toBe(count);
  });
  it('routes the persisted definition after handler restart', async () => {
    const { token } = await setup();
    h = await h.restart();
    expect(await request(token)).toBe(202);
    expect(h.invokeCalls).toHaveLength(1);
    expect(h.routes.filter(r => r.path === '/webhooks/:token/*')).toHaveLength(1);
  });
  it('fails closed on a missing configured HMAC secret and rejects encoded token spelling', async () => {
    const { token } = await setup({ header: 'sig', algorithm: 'sha256' });
    const call = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation(async (name, ctx, input) => { if (name === 'credentials:get')
      throw new Error('missing'); return call(name, ctx, input); });
    expect(await request(token)).toBe(401);
    expect(h.invokeCalls).toHaveLength(0);
    expect(await request(token, { rawPath: `/webhooks/%${token.charCodeAt(0).toString(16)}${token.slice(1)}/hook` })).toBe(404);
  });
  it('resolves execution as the stored owner and records forbidden without deleting the definition', async () => {
    const { row, token } = await setup();
    await sql `UPDATE agents_v1_agents SET owner_id='someone-else' WHERE agent_id=${h.agentId}`.execute(h.db);
    expect(await request(token)).toBe(202);
    expect(h.invokeCalls).toHaveLength(0);
    const store = createRoutinesStore(h.db);
    expect(await store.findOne(row)).not.toBeNull();
    expect((await store.recentFires(row))[0]?.status).toBe('error');
  });
  it('keeps a team routine but refuses execution after the creator loses membership', async () => {
    await setup();
    const row = await h.bus.call<unknown, RoutineView>('routines:create', h.owner, { agentId: h.teamAgentId, requestId: 'team', definition: definition() });
    const { token } = await h.bus.call<unknown, {
      token: string;
    }>('agents:ensure-webhook-token', h.owner, { agentId: h.teamAgentId, actor: { userId: h.owner.userId, isAdmin: false } });
    h.setTeamFailure('missing');
    expect(await request(token)).toBe(202);
    expect(h.invokeCalls).toHaveLength(0);
    const store = createRoutinesStore(h.db);
    expect(await store.findOne(row)).not.toBeNull();
    expect((await store.recentFires(row))[0]?.status).toBe('error');
  });
});
