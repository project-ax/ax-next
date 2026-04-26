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
});
