import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineDefinitionSchema, type RoutineView } from '@ax/routines-contract';
import { createRoutineHarness, type RoutineHarness } from './support/routine-harness.js';
import { createRoutinesStore } from '../store.js';
import { isHold, makeAgentContext } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import { createHttpServerPlugin } from '@ax/http-server';
import type { Clock } from '../clock.js';
import { captureExpectedStderr } from './support/expected-diagnostics.js';

let h: RoutineHarness;
afterEach(async () => { vi.restoreAllMocks(); await h?.close(); });
async function create(overrides = {}) {
  return h.bus.call<unknown, RoutineView>('routines:create', h.owner, {
    agentId: h.agentId, requestId: randomUUID(),
    definition: RoutineDefinitionSchema.parse({ name: 'Canary', promptBody: 'Check in', trigger: { kind: 'interval', every: '60s' }, silenceToken: 'HEARTBEAT_OK', ...overrides }),
  });
}
async function fire(row: RoutineView) {
  await h.bus.call('routines:fire-now', h.owner, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: randomUUID() });
}

describe('DB routine canary — real ACL, durable dispatch and turn completion', () => {
  it.each(['per-fire', 'shared'] as const)('creates, fires and silences a %s conversation without workspace writes', async conversation => {
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 'turn', contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
      return { kind: 'complete' };
    } });
    const calls = vi.spyOn(h.bus, 'call');
    const row = await create({ conversation });
    expect(row.routineId).not.toContain('/');
    const store = createRoutinesStore(h.db);
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    expect((await store.recentFires(row))[0]).toMatchObject({ status: 'silenced', conversationId: 'conversation', error: null });
    expect((await store.findOne(row))?.lastStatus).toBe('silenced');
    expect(calls.mock.calls.some(([hook]) => hook === 'conversations:drop-turn')).toBe(true);
    expect(calls.mock.calls.some(([hook]) => hook === 'conversations:hide')).toBe(conversation === 'per-fire');
    if (conversation === 'shared') expect(calls).toHaveBeenCalledWith('conversations:find-or-create', expect.anything(), expect.objectContaining({ externalKey: row.routineId }));
    expect(calls.mock.calls.some(([hook]) => hook === 'workspace:apply')).toBe(false);
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('keeps ordinary output visible and returns history through the current opaque identity', async () => {
    h = await createRoutineHarness();
    const row = await create();
    await fire(row);
    await expect.poll(async () => (await createRoutinesStore(h.db).recentFires(row))[0]?.status).toBe('ok');
    expect(await h.bus.call('routines:recent-fires', h.owner, { agentId: row.agentId, routineId: row.routineId })).toMatchObject({ fires: [expect.objectContaining({ status: 'ok' })] });
    await expect(h.bus.call('routines:fire-now', h.teamAdmin, { agentId: row.agentId, routineId: row.routineId, expectedRevision: row.revision, requestId: randomUUID() })).rejects.toThrow();
    expect(h.invokeCalls).toHaveLength(1);
  });
  it('persists connector warnings even when the response is silenced, then clears them on the next clean run', async () => {
    let skipped = true;
    h = await createRoutineHarness({ invoke: async (ctx, bus) => {
      if (skipped) await bus.fire('chat:connectors-skipped', ctx, { reqId: ctx.reqId, connectors: [{ connectorId: 'gmail', name: 'Gmail', reason: 'not-signed-in' }] });
      await bus.fire('chat:turn-end', ctx, { reqId: ctx.reqId, turnId: 'turn', contentBlocks: [{ type: 'text', text: 'HEARTBEAT_OK' }] });
      return { kind: 'complete' };
    } });
    const row = await create(); const store = createRoutinesStore(h.db);
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    expect((await store.findOne(row))?.lastWarning).toContain('Gmail');
    skipped = false;
    await fire(row);
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(2);
    expect((await store.findOne(row))?.lastWarning).toBeNull();
  });
  it('stops a saved definition without editing its prompt and deletes it through DB services', async () => {
    h = await createRoutineHarness();
    const row = await create();
    const stopped = await h.bus.call<unknown, RoutineView>('routines:update', h.owner, { agentId: row.agentId, routineId: row.routineId, requestId: randomUUID(), expectedRevision: row.revision, patch: { enabled: false } });
    expect(stopped.promptBody).toBe(row.promptBody);
    await expect(fire(stopped)).rejects.toMatchObject({ toolCode: 'disabled' });
    expect(await h.bus.call('routines:delete', h.owner, { agentId: row.agentId, routineId: row.routineId, requestId: randomUUID(), expectedRevision: stopped.revision })).toEqual({ deleted: true, cleanupPending: false });
    expect(await createRoutinesStore(h.db).findOne(row)).toBeNull();
  });
});


describe('registered approval-to-tick-to-webhook cutover canary', () => {
  it('holds a real owner tool, releases approval, ticks, reads Settings edits, signs a static webhook and deletes without workspace writes', async () => {
    let now = Date.parse('2026-10-09T12:00:00Z');
    let wake: (() => void) | undefined;
    const clock: Clock = {
      now: () => new Date(now),
      sleep: (_ms, signal) => new Promise<void>(resolve => {
        const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve(); };
        if (signal.aborted) return finish();
        wake = finish; signal.addEventListener('abort', finish, { once: true });
      }),
    };
    h = await createRoutineHarness({ clock, strictCredentials: true });
    const ctx = makeAgentContext({ ...h.owner, agentId: h.agentId, conversationId: 'conversation' });
    const calls = vi.spyOn(h.bus, 'call');
    await expect.poll(() => Boolean(wake)).toBe(true);
    const call = { id: 'canary-call', name: 'routine_create', input: {
      requestId: 'canary-create', definition: RoutineDefinitionSchema.parse({
        name: 'Approved canary', promptBody: 'Check progress.', trigger: { kind: 'interval', every: '1m' },
      }),
    } };
    const held = await h.bus.fire('tool:pre-call', ctx, call);
    expect(isHold(held)).toBe(true);
    if (!isHold(held)) throw new Error('Expected a real decision hold');
    const store = createRoutinesStore(h.db);
    expect((await store.list({ agentId: h.agentId })).filter(row => row.definitionId === null)).toHaveLength(0);
    await h.bus.call('decisions:approve', ctx, { decisionId: held.hold.decisionId, userId: ctx.userId, approvalScope: 'once' });
    await expect(h.bus.call('tool:execute:routine_create', ctx, call)).rejects.toMatchObject({ toolCode: 'approval-required' });
    h.advance(11_000);
    const row = await h.bus.call<unknown, RoutineView>('tool:execute:routine_create', ctx, call);
    expect(await h.bus.call('tool:execute:routine_create', ctx, call)).toEqual(row);
    expect((await store.list({ agentId: h.agentId })).filter(item => item.definitionId === null)).toHaveLength(1);
    now += 60_000; wake!();
    await expect.poll(async () => (await store.recentFires(row)).length).toBe(1);
    await expect.poll(() => Boolean(wake)).toBe(true);
    expect((await store.recentFires(row))[0]).toMatchObject({ status: 'ok', renderedPrompt: 'Check progress.' });
    const changed = await h.bus.call<unknown, RoutineView>('routines:update', ctx, {
      agentId: h.agentId, routineId: row.routineId, expectedRevision: row.revision,
      requestId: 'settings-edit', patch: { promptBody: 'Exact Settings edit — preserve this punctuation.', trigger: {
        kind: 'webhook', path: '/canary', events: ['push'], hmac: { header: 'X-Signature', algorithm: 'sha256', prefix: 'sha256=' },
      } },
    });
    expect(await h.bus.call('tool:execute:routine_get', ctx, { id: 'get', name: 'routine_get', input: { routineId: row.routineId } })).toEqual(changed);
    await expect(h.bus.call('routines:get', h.teamAdmin, { agentId: h.agentId, routineId: row.routineId })).rejects.toThrow();
    await h.bus.call('routines:set-webhook-secret', ctx, { agentId: h.agentId, routineId: row.routineId, expectedRevision: changed.revision, operation: 'set', secret: Buffer.from('canary-only-key') });
    const { token } = await h.bus.call<unknown, { token: string }>('agents:ensure-webhook-token', ctx, { agentId: h.agentId, actor: { userId: ctx.userId, isAdmin: false } });
    const listening = captureExpectedStderr(message => message.startsWith('[ax/http-server] listening on http://127.0.0.1:'));
    const server = createHttpServerPlugin({ host: '127.0.0.1', port: 0, cookieKey: Buffer.alloc(32, 1), allowedOrigins: ['http://localhost'] });
    const http = await createTestHarness({ plugins: [server] });
    try {
      await http.bus.call('http:register-route', http.ctx(), h.routes.find(route => route.path === '/webhooks/:token/*')!);
      const body = '{"event":"push","title":"canary"}';
      const signature = createHmac('sha256', 'canary-only-key').update(body).digest('hex');
      const post = () => fetch(`http://127.0.0.1:${server.boundPort()}/webhooks/${token}/canary`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-signature': `sha256=${signature}` } });
      now += 1_000;
      expect((await post()).status).toBe(202);
      await expect.poll(async () => (await store.recentFires(row)).length).toBe(2);
      expect((await store.recentFires(row))[0]).toMatchObject({ status: 'ok', renderedPrompt: changed.promptBody });
      expect(await h.bus.call('routines:delete', ctx, { agentId: h.agentId, routineId: row.routineId, expectedRevision: changed.revision, requestId: 'delete-canary' })).toEqual({ deleted: true, cleanupPending: true });
      const secretRef = h.credentialCalls.find(item => item.operation === 'set')!.ref;
      expect(h.credentialCalls).toContainEqual({ operation: 'delete', ref: secretRef });
      await expect(h.bus.call('credentials:get', ctx, { ref: secretRef })).rejects.toThrow();
      const invocations = h.invokeCalls.length;
      expect((await post()).status).toBe(404);
      now += 60_000; wake!();
      await expect.poll(() => Boolean(wake)).toBe(true);
      expect(h.invokeCalls).toHaveLength(invocations);
      expect(await store.findOne(row)).toBeNull();
      expect(calls.mock.calls.some(([hook]) => hook === 'workspace:apply')).toBe(false);
      expect(listening.messages).toHaveLength(1);
    } finally { await http.close(); listening.restore(); }
  });
});
