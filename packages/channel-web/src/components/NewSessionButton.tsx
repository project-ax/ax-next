/**
 * NewSessionButton — extracted from Sidebar so the click handler can
 * actually create a session. The JSX matches the original stub byte-for-
 * byte so the existing CSS rules carry without diff.
 *
 * On click: drive assistant-ui to a fresh local thread (so the active
 * `Thread` view goes blank — "One conversation. Say anything."), then
 * clear the local active-session pointer and bump the SessionList's
 * version counter. The chat-flow server mints the conversationId on the
 * first user message via POST /api/chat/messages with conversationId=null,
 * so we don't issue a network call here.
 */
import { useAui } from '@assistant-ui/react';
import { useAgentStore } from '../lib/agent-store';
import { sessionStoreActions } from '../lib/session-store';

export function NewSessionButton() {
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  const aui = useAui();
  const activeAgentId = pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;

  const handleClick = (): void => {
    if (!activeAgentId) return;
    try {
      // Bridge into assistant-ui's RemoteThreadList so the visible
      // thread actually changes. Without this the click only resets
      // local store state — the chat pane keeps showing whatever
      // thread the runtime had active.
      aui.threads().switchToNewThread();
    } catch (err) {
      console.warn('[new-session-btn] switchToNewThread failed', err);
    }
    sessionStoreActions.newLocalConversation();
  };

  return (
    <button
      className="new-session-btn"
      type="button"
      onClick={handleClick}
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 3 L8 13 M3 8 L13 8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="label">new session</span>
      <span className="kbd">⌘N</span>
    </button>
  );
}
