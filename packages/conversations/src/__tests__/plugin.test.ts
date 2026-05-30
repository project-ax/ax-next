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
        // Phase B (2026-05-14): runner-native jsonl rewrite. Half-wired
        // window CLOSED — first caller is @ax/routines silence-token logic.
        'conversations:drop-turn',
        // Phase A (routines foundation, 2026-05-14): stable per-(user,
        // agent, key) conversation lookup for `conversation: shared`
        // routines. Half-wired window OPEN: caller lands in Phase B.
        'conversations:find-or-create',
        // TASK-66 (2026-05-30): host-internal append to the display event
        // log. Caller (this plugin's own subscribers) + consumer
        // (conversations:get) both ship in the same PR.
        'conversations:append-event',
        // TASK-67 (2026-05-30): the resume transcript store (resume SoT).
        // Host-internal; callers are the host's session.* IPC handlers,
        // consumers are the runner delta-ship + resume rebuild (same PR).
        'conversations:append-transcript',
        'conversations:replace-transcript',
        'conversations:get-transcript',
      ],
      // database:get-instance is hard — we run our own migration on init.
      // agents:resolve is hard — every hook gates through it (Invariant J1).
      // TASK-75 (2026-05-30): the `workspace:*` calls are GONE. conversations:
      // get's git-jsonl transcript read was deleted in TASK-70 (the resume
      // jsonl left git in TASK-67), and conversations:drop-turn now rewrites
      // the transcript-ROW store instead of the git workspace jsonl — so
      // workspace:list/read/apply are no longer called (I5: minimal caps).
      calls: [
        'agents:resolve',
        'database:get-instance',
      ],
      // chat:turn-end subscriber bumps last_activity_at AND persists the
      // turn's display frame (TASK-66). session:terminate clears bound rows
      // (Task 14). chat:turn-error + chat:permission-request persist the
      // host-only display events the jsonl never sees (TASK-66).
      subscribes: [
        'chat:turn-end',
        'session:terminate',
        'chat:turn-error',
        'chat:permission-request',
      ],
    });
  });
});
