import { describe, expect, it } from 'vitest';
import { createConversationsPlugin } from '../plugin.js';

// ---------------------------------------------------------------------------
// Manifest assertion. Hook-level integration tests live in store.test.ts
// (testcontainers postgres) and acl.test.ts (mocked agents:resolve gate).
// ---------------------------------------------------------------------------

describe('@ax/conversations plugin manifest', () => {
  it('declares all conversations:* registers, agents:resolve + database:get-instance calls, and chat:turn-end + session:terminate subscriptions', () => {
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
        // Task 7 (Week 10–12): browser SSE consumer authorizes a route
        // param `:reqId` against this row before subscribing to the
        // chunk feed.
        'conversations:get-by-req-id',
        // Task 14 (Week 10–12): active_session_id lifecycle (J6).
        'conversations:bind-session',
        'conversations:unbind-session',
      ],
      // database:get-instance is hard — we run our own migration on init.
      // agents:resolve is hard — every hook gates through it (Invariant J1).
      calls: ['agents:resolve', 'database:get-instance'],
      // chat:turn-end subscriber wires in Task 3 (auto-append).
      // session:terminate subscriber wires in Task 14 (clear bound rows).
      subscribes: ['chat:turn-end', 'session:terminate'],
    });
  });
});
