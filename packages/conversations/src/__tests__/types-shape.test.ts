import { describe, it, expect } from 'vitest';
import { rowToConversation } from '../store.js';

// ---------------------------------------------------------------------------
// Phase B (2026-04-29). The Conversation public type gains four nullable
// fields — runnerType, runnerSessionId, workspaceRef, lastActivityAt.
// rowToConversation maps them through. Testing in isolation here keeps the
// row-mapping contract honest without spinning up a postgres container.
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
    workspace_ref: null,
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

  // W3a (§4.4). A chat's project; NULL (or a row that predates the column,
  // which a fixture models by omitting it) reads as null, never undefined.
  it('maps project_id string, null and absent', () => {
    expect(rowToConversation({ ...base, hidden: false, project_id: 'prj_1' }).projectId).toBe('prj_1');
    expect(rowToConversation({ ...base, hidden: false, project_id: null }).projectId).toBeNull();
    expect(rowToConversation({ ...base, hidden: false }).projectId).toBeNull();
  });
});

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
      hidden: false,
      external_key: null,
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
      hidden: false,
      external_key: null,
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
