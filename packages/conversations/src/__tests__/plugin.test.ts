import { describe, expect, it } from 'vitest';
import { createConversationsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Task 1 (scaffold) only ships the manifest. We assert the manifest
// shape directly — no bootstrap, no live postgres — to mirror the
// `@ax/agents` pattern (`packages/agents/src/__tests__/plugin.test.ts`,
// "manifest matches the documented surface"). Hook-level tests land
// alongside Task 2's implementations.
// ---------------------------------------------------------------------------

describe('@ax/conversations plugin manifest', () => {
  it('declares the five conversations:* registers, agents:resolve call, and chat:turn-end subscription', () => {
    const plugin = createConversationsPlugin();
    expect(plugin.manifest).toEqual({
      name: '@ax/conversations',
      version: '0.0.0',
      registers: [
        'conversations:create',
        'conversations:append-turn',
        'conversations:get',
        'conversations:list',
        'conversations:delete',
      ],
      calls: ['agents:resolve'],
      subscribes: ['chat:turn-end'],
    });
  });

  it('init runs without booting external resources (Task 2 wires the hooks)', async () => {
    // The scaffold init is a no-op. Calling it directly with a stub bus
    // proves the plugin is constructable without postgres/agents loaded
    // — the harness boot path will exercise the real wiring once Task 2
    // lands and `database:get-instance` becomes a hard call.
    const plugin = createConversationsPlugin();
    const calls: string[] = [];
    const stubBus = {
      // Empty stand-in; the scaffold's init never touches it. We track
      // any call so that a regression (e.g. somebody adding a hook impl
      // here without updating the test) trips immediately.
      registerService: () => {
        calls.push('registerService');
      },
      subscribe: () => {
        calls.push('subscribe');
      },
      call: async () => {
        calls.push('call');
        return undefined;
      },
      fire: async () => {
        calls.push('fire');
        return { errors: [] };
      },
    };
    await plugin.init({
      bus: stubBus as never,
      config: {},
    });
    expect(calls).toEqual([]);
  });
});
