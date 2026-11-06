import { describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { registerRoutineServices } from '../services.js';
import { preflightRoutineCall } from '../tools.js';
import { fullTaskEventPayload } from '../task-event-content.js';
import type { RepeatUpdate } from '../repeat-updates.js';
import type { RoutinesStore } from '../store.js';

it('rechecks the live update binding after a delayed blob read before returning private bytes', async () => {
  const bus = new HookBus();
  let allowed = true;
  const event = { eventId: 'update_1', receivedAt: new Date(0), blobRef: 'a'.repeat(64), byteLength: 7, mayBeOwnChange: false };
  const readTaskEvent = vi.fn(async () => allowed ? event : null);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  bus.registerService('blob:get', 'test', async () => { started(); await held; return { bytes: Buffer.from('PRIVATE') }; });
  registerRoutineServices({ bus, store: { readTaskEvent } as unknown as RoutinesStore, now: () => new Date(0) });
  const ctx = makeAgentContext({ agentId: 'a', userId: 'owner', conversationId: 'c', source: 'routine', sessionId: 's' });
  const pending = bus.call('routines:read-update', ctx, { agentId: 'a', eventId: 'update_1' });
  await entered;
  // A report, owner change or run closure revoked the original binding while
  // storage was awaited. Successful storage is not continuing authorization.
  allowed = false;
  release();
  await expect(pending).rejects.toMatchObject({ toolCode: 'not-found' });
  expect(readTaskEvent).toHaveBeenCalledTimes(2);
});

describe('the app update that started a repeat run (TASK-1050)', () => {
  type Scope = { agentId: string; conversationId: string; actorUserId: string; eventId: string };
  const ctx = makeAgentContext({ agentId: 'a', userId: 'owner', conversationId: 'c', source: 'routine', sessionId: 's' });
  const scope: Scope = { agentId: 'a', conversationId: 'c', actorUserId: 'owner', eventId: 'delivery_1' };
  const bytes = Buffer.from(JSON.stringify({ row: { promptBody: 'ROW_PRIVATE' }, payload: { title: 'TES-3' } }));
  const update: RepeatUpdate = { eventId: 'delivery_1', receivedAt: new Date(0), blobRef: 'a'.repeat(64), byteLength: bytes.byteLength };
  /** The services over a store stub where no check-in holds the id, and `blob:get` answering through `blob`. */
  function services(readRepeatUpdate: (input: Scope) => Promise<RepeatUpdate | null>, blob: () => Promise<unknown> = async () => ({ bytes })) {
    const bus = new HookBus();
    const blobGet = vi.fn(blob);
    bus.registerService('blob:get', 'test', blobGet);
    const store = { readTaskEvent: vi.fn(async (_input: Scope) => null), readRepeatUpdate: vi.fn(readRepeatUpdate) };
    registerRoutineServices({ bus, store: store as unknown as RoutinesStore, now: () => new Date(0) });
    return { bus, store, blobGet };
  }

  it('reads a repeat run’s own app update', async () => {
    const { bus, store } = services(async () => update);
    await expect(bus.call('routines:read-update', ctx, { agentId: 'a', eventId: 'delivery_1' })).resolves.toEqual({
      eventId: 'delivery_1', receivedAt: '1970-01-01T00:00:00.000Z', payload: fullTaskEventPayload(Buffer.from('{"title":"TES-3"}')),
    });
    expect(store.readRepeatUpdate).toHaveBeenCalledTimes(2);
    expect(store.readRepeatUpdate).toHaveBeenNthCalledWith(1, scope);
    expect(store.readRepeatUpdate).toHaveBeenNthCalledWith(2, scope);
  });

  it('rechecks the run after a delayed blob read, before returning the update', async () => {
    let allowed = true;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { bus, store } = services(async () => allowed ? update : null, async () => { started(); await held; return { bytes }; });
    const pending = bus.call('routines:read-update', ctx, { agentId: 'a', eventId: 'delivery_1' });
    // A refusal before the blob read fails here at once, instead of waiting out the test's timeout.
    await Promise.race([entered, pending]);
    // The run ended or the routine changed owner while storage was awaited.
    allowed = false;
    release();
    await expect(pending).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(store.readRepeatUpdate).toHaveBeenCalledTimes(2);
  });

  it('refuses an id that is neither a check-in’s update nor the run’s own, before any blob read', async () => {
    const { bus, store, blobGet } = services(async () => null);
    await expect(bus.call('routines:read-update', ctx, { agentId: 'a', eventId: 'delivery_1' })).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(store.readTaskEvent).toHaveBeenCalledWith(scope);
    expect(store.readRepeatUpdate).toHaveBeenCalledWith(scope);
    expect(blobGet).not.toHaveBeenCalled();
  });

  it('never lets a check-in update revoked mid-read fall through to the repeat lookup', async () => {
    const bus = new HookBus();
    let allowed = true;
    const event = { eventId: 'delivery_1', receivedAt: new Date(0), blobRef: 'a'.repeat(64), byteLength: 7, mayBeOwnChange: false };
    const store = { readTaskEvent: vi.fn(async () => allowed ? event : null), readRepeatUpdate: vi.fn(async () => update) };
    bus.registerService('blob:get', 'test', async () => { allowed = false; return { bytes: Buffer.from('PRIVATE') }; });
    registerRoutineServices({ bus, store: store as unknown as RoutinesStore, now: () => new Date(0) });
    await expect(bus.call('routines:read-update', ctx, { agentId: 'a', eventId: 'delivery_1' })).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(store.readRepeatUpdate).not.toHaveBeenCalled();
  });

  it('lets the tool’s pre-check through for the run’s own update, and refuses an id that is neither', async () => {
    const call = { id: 'read', name: 'routine_read_update', input: { eventId: 'delivery_1' } };
    const own = services(async () => update);
    await expect(preflightRoutineCall({ bus: own.bus, store: own.store as unknown as RoutinesStore, ctx, call })).resolves.toBeUndefined();
    expect(own.store.readRepeatUpdate).toHaveBeenCalledWith(scope);
    const neither = services(async () => null);
    await expect(preflightRoutineCall({ bus: neither.bus, store: neither.store as unknown as RoutinesStore, ctx, call })).rejects.toMatchObject({ toolCode: 'not-found' });
    expect(neither.blobGet).not.toHaveBeenCalled();
  });
});
