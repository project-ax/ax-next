import { expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { registerRoutineServices } from '../services.js';
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
