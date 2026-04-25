/**
 * Sidebar — left rail shell.
 *
 * Structure-only for the parts that haven't been earned yet. Live wiring
 * so far: agent chip + menu (Task 12), session list + new-session button
 * (Task 13), inline rename + delete (Task 14). Coming next: user menu
 * (21).
 *
 * The collapse toggle used to live in `.sidebar-head`; Task 16 moved it
 * to the session header per the Tide design — the toggle belongs at the
 * top of the main pane, not inside the sidebar.
 *
 * Class names match `design_handoff_tide/Tide Sessions.html` so the
 * CSS rules in `index.css` (also copied verbatim from that file) carry
 * over without visual drift.
 */
import { AgentChip, useHydrateAgents } from './AgentChip';
import { NewSessionButton } from './NewSessionButton';
import { SessionList } from './SessionList';

export function Sidebar() {
  // Fetch /api/agents once on mount so the chip + menu can render names.
  useHydrateAgents();
  return (
    <aside className="sidebar" data-testid="sidebar" id="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-word">tide</span>
        </div>
      </div>
      <AgentChip />
      <NewSessionButton />
      <div className="sessions-scroll" role="navigation" aria-label="sessions">
        <SessionList />
      </div>
      <div className="user-row-wrap">
        <button
          className="user-row"
          aria-haspopup="true"
          aria-expanded="false"
          type="button"
        >
          <span className="user-avatar" aria-hidden="true">
            A
          </span>
          <span className="user-meta">
            <span className="user-name">Alice</span>
          </span>
          <span className="user-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {/* user-menu popover placeholder — Task 21 wires it */}
      </div>
    </aside>
  );
}
