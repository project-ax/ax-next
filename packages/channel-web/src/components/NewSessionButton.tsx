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

  // Visually mirrors a SidebarRow (admin nav item / chat session row) so
  // the rail reads as one consistent stack. Doesn't *use* SidebarRow
  // directly because SidebarRow assumes a px-1 wrapper around it; this
  // button sits as a direct child of <aside>, so it carries its own
  // 4px outer margin (mx-1) instead.
  return (
    <button
      className="
        new-session-btn group mx-1 mb-1.5
        flex items-center gap-2.5 px-2.5 py-2 rounded-sm
        text-[13px] text-foreground/75
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
        className="w-3.5 h-3.5 shrink-0 text-muted-foreground group-hover:text-foreground/75 transition-colors"
      >
        <path
          d="M8 3 L8 13 M3 8 L13 8"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <span className="flex-1 min-w-0 text-left [body.sidebar-collapsed_&]:hidden">new session</span>
      <span
        className="
          font-mono text-[10.5px] tracking-[0.02em] text-ink-ghost
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
