/**
 * AgentMenu — popover anchored under the agent chip.
 *
 * Pure presentational: it reads the agent list + active id from the
 * store and forwards picks back to the parent. The deferred-switch
 * decision lives in `agent-store.ts`'s `pickAgent`, not here.
 *
 * Class names track `design_handoff_tide/Tide Sessions.html` for the
 * `.agent-menu` popover. Row-level class names use the
 * `agent-menu-row*` namespace (vs. the design's `.agent-row`) so the
 * menu's row CSS lives in one obvious naming family.
 */
import type { Agent } from '../../mock/agents';

export interface AgentMenuProps {
  agents: Agent[];
  /** The agent that should render with a checkmark (pending OR selected). */
  activeId: string | null;
  onPick: (agentId: string) => void;
}

export function AgentMenu({ agents, activeId, onPick }: AgentMenuProps) {
  return (
    <div className="agent-menu" role="menu">
      <div className="agent-menu-label">switch agent</div>
      <div className="agent-menu-rows">
        {agents.map((agent) => (
          <button
            key={agent.id}
            className="agent-menu-row"
            role="menuitem"
            type="button"
            onClick={() => onPick(agent.id)}
          >
            <span className="agent-menu-row-avatar" aria-hidden="true">
              <span className="dot" />
            </span>
            <div className="agent-menu-row-text">
              <div className="agent-menu-row-name">{agent.name}</div>
              <div className="agent-menu-row-desc">{agent.desc}</div>
            </div>
            {activeId === agent.id && (
              <span className="agent-menu-row-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="agent-menu-foot agent-menu-note">
        a new session starts on your next message
      </div>
    </div>
  );
}
