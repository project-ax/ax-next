import { describe, it, expect } from 'vitest';
import { rowToConversation } from '../store.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). The Conversation public type gains four nullable
// fields — runnerType, runnerSessionId, workspaceRef, lastActivityAt.
// rowToConversation maps them through. Testing in isolation here keeps the
// row-mapping contract honest without spinning up a postgres container.
// ---------------------------------------------------------------------------

describe('rowToConversation Phase B fields', () => {
  it('maps runner_type / runner_session_id / workspace_ref / last_activity_at', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const conv = rowToConversation({
      conversation_id: 'cnv_abc',
      user_id: 'u1',
      agent_id: 'a1',
      title: null,
      active_session_id: null,
      active_req_id: null,
      runner_type: 'claude-sdk',
      runner_session_id: 'sess_xyz',
      workspace_ref: 'wsp_local',
      last_activity_at: now,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(conv.runnerType).toBe('claude-sdk');
    expect(conv.runnerSessionId).toBe('sess_xyz');
    expect(conv.workspaceRef).toBe('wsp_local');
    expect(conv.lastActivityAt).toBe(now.toISOString());
  });

  it('maps null Phase B fields as null', () => {
    const now = new Date('2026-04-29T12:00:00Z');
    const conv = rowToConversation({
      conversation_id: 'cnv_abc',
      user_id: 'u1',
      agent_id: 'a1',
      title: null,
      active_session_id: null,
      active_req_id: null,
      runner_type: null,
      runner_session_id: null,
      workspace_ref: null,
      last_activity_at: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(conv.runnerType).toBeNull();
    expect(conv.runnerSessionId).toBeNull();
    expect(conv.workspaceRef).toBeNull();
    expect(conv.lastActivityAt).toBeNull();
  });
});
