/**
 * NewSessionButton — extracted from Sidebar so the click handler can
 * actually create a session. The JSX matches the original stub byte-for-
 * byte so the existing CSS rules carry without diff.
 *
 * On click: read the currently-selected (or pending) agent from the
 * agent-store, POST `/api/chat/sessions { agentId }`, then activate the
 * new id and bump the SessionList's version counter. If no agent is
 * selected (cold start with empty agent list), the click is a no-op —
 * the agent chip should hydrate before the button is reachable in
 * practice, but we don't crash if it doesn't.
 */
import { useAgentStore } from '../lib/agent-store';
import { sessionStoreActions } from '../lib/session-store';

export function NewSessionButton() {
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  const activeAgentId = pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;

  const handleClick = async (): Promise<void> => {
    if (!activeAgentId) return;
    try {
      await sessionStoreActions.createAndActivate(activeAgentId);
    } catch (err) {
      console.warn('[new-session-btn] create failed', err);
    }
  };

  return (
    <button
      className="new-session-btn"
      type="button"
      onClick={() => {
        void handleClick();
      }}
    >
      <span className="plus" aria-hidden="true">
        +
      </span>
      <span className="label">new session</span>
      <span className="kbd">⌘N</span>
    </button>
  );
}
