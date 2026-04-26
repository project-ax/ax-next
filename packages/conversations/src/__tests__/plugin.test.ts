import { describe, expect, it } from 'vitest';
import { createConversationsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts
// (testcontainers postgres) and acl.test.ts (mocked agents:resolve gate).
// ---------------------------------------------------------------------------

describe('@ax/conversations plugin manifest', () => {
  it('declares the five conversations:* registers, agents:resolve + database:get-instance calls, and chat:turn-end subscription', () => {
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
      // database:get-instance is hard — we run our own migration on init.
      // agents:resolve is hard — every hook gates through it (Invariant J1).
      calls: ['agents:resolve', 'database:get-instance'],
      // chat:turn-end subscriber wires in Task 3 (auto-append).
      subscribes: ['chat:turn-end'],
    });
  });
});
