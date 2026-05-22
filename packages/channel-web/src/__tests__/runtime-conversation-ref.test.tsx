/**
 * useAxChatRuntime — conversationId targeting on session selection.
 *
 * Regression test for the "selecting an old chat starts a NEW conversation"
 * bug (and its sibling "agent has no history"): the runtime mirrors the
 * sidebar's active session into the transport's `getConversationId` resolver
 * so the next POST /api/chat/messages targets the selected conversation
 * instead of minting a fresh one.
 *
 * We mock the assistant-ui runtime layer (which useAxChatRuntime composes but
 * whose internals are irrelevant here) and the transport (so we can capture
 * the `getConversationId` resolver the runtime wires in).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { sessionStoreActions } from '../lib/session-store';

// Capture the options the runtime passes to the transport constructor — the
// `getConversationId` resolver is what the AI SDK calls before every send.
let capturedOpts: { getConversationId?: () => string | null } | undefined;
vi.mock('../lib/transport', () => ({
  AxChatTransport: class {
    constructor(opts: { getConversationId?: () => string | null }) {
      capturedOpts = opts;
    }
  },
}));

// useAxChatRuntime only calls useRemoteThreadListRuntime at the top level; the
// per-thread hook (which touches useAui/useChat) runs inside that runtime,
// which we stub out. The other named imports must exist but aren't invoked.
vi.mock('@assistant-ui/react', () => ({
  useRemoteThreadListRuntime: () => ({}),
  useAui: () => ({}),
  useAuiState: () => undefined,
}));
vi.mock('@assistant-ui/react-ai-sdk', () => ({ useAISDKRuntime: () => ({}) }));
vi.mock('@ai-sdk/react', () => ({ useChat: () => ({}) }));

import { useAxChatRuntime } from '../lib/runtime';

beforeEach(() => {
  capturedOpts = undefined;
  sessionStoreActions.setActiveSession(null, false);
});

describe('useAxChatRuntime conversationId targeting', () => {
  it('targets the selected conversation after the sidebar activates it', () => {
    renderHook(() => useAxChatRuntime('user-1'));

    // Fresh shell: no active session → the next POST mints a new conversation.
    expect(capturedOpts?.getConversationId?.()).toBeNull();

    // User clicks an existing conversation in the sidebar.
    act(() => {
      sessionStoreActions.setActiveSession('cnv_existing', true);
    });

    // The transport must now POST against cnv_existing — NOT null (which the
    // server would treat as "mint a new conversation", losing history).
    expect(capturedOpts?.getConversationId?.()).toBe('cnv_existing');
  });

  it('clears the target back to null on a fresh-session / agent switch', () => {
    renderHook(() => useAxChatRuntime('user-1'));

    act(() => {
      sessionStoreActions.setActiveSession('cnv_existing', true);
    });
    expect(capturedOpts?.getConversationId?.()).toBe('cnv_existing');

    // "+ New chat" / agent switch clears the active pointer; the next message
    // should mint a fresh conversation again.
    act(() => {
      sessionStoreActions.newLocalConversation();
    });
    expect(capturedOpts?.getConversationId?.()).toBeNull();
  });
});
