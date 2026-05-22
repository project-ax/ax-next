import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStoreActions, useSessionStore } from '../lib/session-store.js';
import { renderHook, act } from '@testing-library/react';

describe('sessionStoreActions.applyTitle', () => {
  beforeEach(() => {
    act(() => {
      sessionStoreActions.setSessions([
        { id: 'cnv_1', title: 'New Chat', agent_id: 'a', user_id: 'u', created_at: 1, updated_at: 1 },
        { id: 'cnv_2', title: 'Kept', agent_id: 'a', user_id: 'u', created_at: 1, updated_at: 1 },
      ]);
    });
  });

  it('updates the matching row title', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => sessionStoreActions.applyTitle('cnv_1', 'Real Title'));
    expect(result.current.sessions.find((s) => s.id === 'cnv_1')?.title).toBe('Real Title');
    expect(result.current.sessions.find((s) => s.id === 'cnv_2')?.title).toBe('Kept');
  });

  it('no-ops for an unknown conversation id', () => {
    const { result } = renderHook(() => useSessionStore());
    const before = result.current.sessions;
    act(() => sessionStoreActions.applyTitle('cnv_missing', 'X'));
    expect(result.current.sessions).toBe(before); // same reference — no state churn
  });

  it('no-ops when the title is unchanged', () => {
    const { result } = renderHook(() => useSessionStore());
    const before = result.current.sessions;
    act(() => sessionStoreActions.applyTitle('cnv_2', 'Kept'));
    expect(result.current.sessions).toBe(before);
  });
});
