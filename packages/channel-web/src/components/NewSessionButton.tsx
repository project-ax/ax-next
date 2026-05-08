/**
 * NewSessionButton — extracted from Sidebar so the click handler can
 * actually create a session.
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
      aui.threads().switchToNewThread();
    } catch (err) {
      console.warn('[new-session-btn] switchToNewThread failed', err);
    }
    sessionStoreActions.newLocalConversation();
  };

  return (
    <button
      className="
        new-session-btn group mx-2 mb-1.5
        flex items-center gap-2 px-3 py-2 rounded-md
        text-[12.5px] tracking-[0.01em] text-muted-foreground
        hover:bg-muted hover:text-foreground
        focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none
        transition-colors
        [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-2
      "
      type="button"
      onClick={handleClick}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className="w-[13px] h-[13px] shrink-0 text-muted-foreground group-hover:text-foreground transition-colors"
      >
        <path
          d="M8 3 L8 13 M3 8 L13 8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="min-w-0 [body.sidebar-collapsed_&]:hidden">new session</span>
      <span
        className="
          ml-auto font-mono text-[10.5px] tracking-[0.02em] text-ink-ghost
          opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100
          transition-opacity
          [body.sidebar-collapsed_&]:hidden
        "
      >
        ⌘N
      </span>
    </button>
  );
}
