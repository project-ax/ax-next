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
        // Phase B (2026-04-29): runner-owned-sessions metadata reads.
        'conversations:get-metadata',
        'conversations:store-runner-session',
        // Phase F (2026-05-03): post-creation title update for the
        // auto-title pipeline + future user-driven rename UI.
        'conversations:set-title',
        // Phase A (routines foundation, 2026-05-14): mark a conversation
        // hidden so it disappears from list queries but remains readable
        // by id. Half-wired window OPEN: caller lands in Phase B
        // (@ax/routines plugin).
        'conversations:hide',
        // Phase A (routines foundation, 2026-05-14): drop a single turn
        // from a conversation's runner-native transcript. Ships as a stub
        // — runner-native jsonl rewrite lands in Phase B alongside its
        // first caller. Half-wired window OPEN through Phase B.
        'conversations:drop-turn',
      ],
      // database:get-instance is hard — we run our own migration on init.
      // agents:resolve is hard — every hook gates through it (Invariant J1).
      // workspace:list + workspace:read are hard — Phase D conversations:get
      // reads transcripts from the runner-native jsonl in the workspace.
      calls: [
        'agents:resolve',
        'database:get-instance',
        'workspace:list',
        'workspace:read',
      ],
      // chat:turn-end subscriber bumps last_activity_at only (Phase D
      // dropped the conversation_turns auto-append).
      // session:terminate subscriber clears bound rows (Task 14).
      subscribes: ['chat:turn-end', 'session:terminate'],
    });
  });
});
