import { describe, it, expect } from 'vitest';
import { rowToConversation } from '../store.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). The Conversation public type gains three nullable
// fields — runnerType, runnerSessionId, lastActivityAt. rowToConversation
// maps them through. (Phase B also added workspaceRef; TASK-995 removed it.)
// Testing in isolation here keeps the row-mapping contract honest without
// spinning up a postgres container.
// ---------------------------------------------------------------------------

describe('rowToConversation Phase A fields', () => {
  const now = new Date('2026-05-14T12:00:00Z');
  const base = {
    conversation_id: 'cnv_h1',
    user_id: 'u1',
    agent_id: 'a1',
    title: null,
    active_session_id: null,
    active_req_id: null,
    runner_type: null,
    runner_session_id: null,
    last_activity_at: null,
    external_key: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };

  it('maps hidden=true and hidden=false', () => {
    expect(rowToConversation({ ...base, hidden: true }).hidden).toBe(true);
    expect(rowToConversation({ ...base, hidden: false }).hidden).toBe(false);
  });

  it('maps external_key string and null', () => {
    expect(
      rowToConversation({ ...base, hidden: false, external_key: 'routine:019c8e8d-abc0-7000-8000-000000000001' }).externalKey,
    ).toBe('routine:019c8e8d-abc0-7000-8000-000000000001');
    expect(rowToConversation({ ...base, hidden: false, external_key: null }).externalKey).toBeNull();
  });
});

describe('rowToConversation Phase B fields', () => {
  it('maps runner_type / runner_session_id / last_activity_at, and has no workspaceRef', () => {
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
      last_activity_at: now,
      hidden: false,
      external_key: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(conv.runnerType).toBe('claude-sdk');
    expect(conv.runnerSessionId).toBe('sess_xyz');
    expect(conv.lastActivityAt).toBe(now.toISOString());
    // TASK-995: the frozen workspaceRef copy is gone from the public type.
    expect(conv).not.toHaveProperty('workspaceRef');
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
      last_activity_at: null,
      hidden: false,
      external_key: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    });
    expect(conv.runnerType).toBeNull();
    expect(conv.runnerSessionId).toBeNull();
    expect(conv.lastActivityAt).toBeNull();
  });
});
