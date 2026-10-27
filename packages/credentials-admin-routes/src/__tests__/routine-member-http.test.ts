import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, HookBus, makeAgentContext, PluginError } from '@ax/core';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createCredentialsStoreDbPlugin } from '@ax/credentials-store-db';
import { createCredentialsPlugin } from '@ax/credentials';
import { RoutineDefinitionSchema } from '@ax/routines-contract';
import { createHttpServerPlugin } from '../../../http-server/src/plugin.js';
import { registerRoutineServices } from '../../../routines/src/services.js';
import type { RoutinesStore } from '../../../routines/src/store.js';
import type { StoredRoutine } from '../../../routines/src/types.js';
import { setDestinationCredential, removeDestinationCredential, routineSecretConfigured } from '../../../channel-web/src/lib/credentials.js';
import { registerDestinationRoutes } from '../destination-routes.js';
import { registerAdminCredentialsRoutes } from '../admin-routes.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const destination = { kind: 'routine-hmac' as const, agentId: 'agent', routineId: 'task' };
const scope = { scope: 'agent' as const, ownerId: 'agent' };
const target = { destination, scope, expectedRevision: 'revision' };
const body = { destination, scope: 'agent', ownerId: 'agent', expectedRevision: 'revision' };
const ownStatus = '/settings/destinations/routine-hmac/credential?agentId=agent&routineId=task';
const keyContext = makeAgentContext({ userId: 'member', agentId: 'agent', sessionId: 'secret-http' });
let h: { bus: HookBus; close(): Promise<void> };
let origin: string;
let previousKey: string | undefined;

beforeEach(async () => {
  previousKey = process.env.AX_CREDENTIALS_KEY;
  process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  const http = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: [] });
  const bus = new HookBus();
  const kernel = await bootstrap({ bus, plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' }), createCredentialsStoreDbPlugin(), createCredentialsPlugin(), http], config: {} });
  h = { bus, close: () => kernel.shutdown() };
  bus.registerService('auth:require-user', 'test', async (_ctx, { req }) => {
        const id = req.headers['x-test-user'];
        if (!['member', 'peer', 'admin'].includes(id)) throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'No test session' });
        return { user: { id, isAdmin: id === 'admin' } };
      });
  bus.registerService('agents:resolve', 'test', async (_ctx, input) => {
        if (input.agentId !== 'agent') throw new PluginError({ code: 'not-found', plugin: 'test', message: 'No agent' });
        return { agent: { id: 'agent', ownerType: 'team', ownerId: 'team' } };
      });
  bus.registerService('agents:can-manage-routines', 'test', async ctx => ({ allowed: true, stopOthers: ctx.userId === 'admin' }));
  const row: StoredRoutine = {
    ...RoutineDefinitionSchema.parse({ name: 'Member webhook', promptBody: 'Review the update.', trigger: { kind: 'webhook', path: '/member', hmac: { header: 'sig', algorithm: 'sha256' } } }),
    agentId: 'agent', routineId: 'task', revision: 'revision', ownerUserId: 'member', definitionId: null, definitionUpdatedAt: null,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, lastWarning: null, task: null, noRecentUpdate: null, steps: [], finishBy: null, finishByTimeZone: null, done: null,
  };
  // The HTTP adapter, credentials vault and row authority are real. The fixed
  // routine repository is isolated here; Postgres locking has its own canary.
  const store = {
    findOne: async input => input.agentId === row.agentId && input.routineId === row.routineId ? row : null,
    withLockedWebhookSecret: async (input, effect) => {
      expect(input).toMatchObject({ agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision });
      await effect();
      return { saved: true };
    },
  } as unknown as RoutinesStore;
  registerRoutineServices({ bus: h.bus, store, now: () => new Date() });
  await registerDestinationRoutes(h.bus, keyContext);
  await registerAdminCredentialsRoutes(h.bus, keyContext);
  origin = `http://127.0.0.1:${http.boundPort()}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  if (previousKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
  else process.env.AX_CREDENTIALS_KEY = previousKey;
});

const request = (path: string, actor = 'member', init: RequestInit = {}) => nativeFetch(`${origin}${path}`, {
  ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin', 'x-test-user': actor, ...init.headers },
});
const seed = () => h.bus.call('credentials:set', keyContext, { scope: 'agent', ownerId: 'agent', ref: 'routine:agent:task:hmac', kind: 'api-key', payload: new TextEncoder().encode('test signing secret') });
function useRealClient(actor = 'member') {
  vi.spyOn(globalThis, 'fetch').mockImplementation((path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-test-user', actor);
    return nativeFetch(new URL(String(path), origin), { ...init, headers });
  });
}

describe('authenticated own routine signing secrets through actual HTTP admission', () => {
  it('saves a non-admin owner’s secret through the actual wire client', async () => {
    useRealClient();
    await expect(setDestinationCredential({ ...target, slot: { kind: 'api-key' }, payload: 'test signing secret' })).resolves.toBeUndefined();
    await expect(routineSecretConfigured(destination)).resolves.toBe(true);
    const response = await request(ownStatus);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true });
  });
  it('removes a non-admin owner’s existing secret through the actual wire client', async () => {
    await seed();
    useRealClient();
    await expect(removeDestinationCredential(target)).resolves.toBeUndefined();
    await expect(routineSecretConfigured(destination)).resolves.toBe(false);
    const response = await request(ownStatus);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false });
  });
  it('returns only the owner’s configured flag and keeps the global list restricted', async () => {
    await seed();
    const response = await request(ownStatus);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true });
    const global = await request('/admin/credentials');
    expect(global.status).toBe(403);
    expect(JSON.stringify(await global.json())).not.toContain('routine:');
  });
  it.each(['peer', 'admin'])('refuses another creator’s secret/status for %s, including an administrator', async actor => {
    await seed();
    for (const method of ['POST', 'DELETE']) {
      const response = await request('/settings/destinations/routine-hmac/credential', actor, { method, body: JSON.stringify({ ...body, ...(method === 'POST' ? { kind: 'api-key', payloadB64: 'bm90LXRoZWlyLWtleQ==' } : {}) }) });
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain('test signing secret');
    }
    expect((await request(ownStatus, actor)).status).toBe(404);
    const stored = await h.bus.call('credentials:get', keyContext, { userId: 'member', ref: 'routine:agent:task:hmac' });
    expect(stored).toBe('test signing secret');
  });
  it('keeps every other admin destination and the removed account settings route restricted', async () => {
    for (const kind of ['provider', 'skill-slot', 'account', 'routine-hmac']) {
      expect((await request(`/admin/destinations/${kind}/credential`, 'member', { method: 'POST', body: '{}' })).status).toBe(403);
    }
    expect((await request('/settings/destinations/account/credential', 'member', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request('/settings/destinations/provider/credential?agentId=agent&routineId=task')).status).toBe(404);
    expect((await request(ownStatus, '')).status).toBe(401);
  });
  it('reports a metadata outage as a failure instead of claiming no secret is set', async () => {
    const original = h.bus.call.bind(h.bus);
    vi.spyOn(h.bus, 'call').mockImplementation((hook, ...args) => {
      if (hook === 'credentials:list') throw new PluginError({ code: 'unavailable', plugin: 'test', message: 'PRIVATE metadata unavailable' });
      return original(hook, ...args);
    });
    const response = await request(ownStatus);
    expect(response.status).toBe(503);
    const output = await response.json();
    expect(output).not.toHaveProperty('configured');
    expect(JSON.stringify(output)).not.toContain('PRIVATE');
  });
});
