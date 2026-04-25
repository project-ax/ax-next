/**
 * Sidebar — left rail shell.
 *
 * Structure-only for the parts that haven't been earned yet. Live wiring
 * so far: agent chip + menu (Task 12), session list + new-session button
 * (Task 13), inline rename + delete (Task 14), user menu (Task 21).
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
import { UserMenu } from './UserMenu';
import type { AdminView } from '../lib/admin';

export function Sidebar({
  onOpenAdmin,
}: { onOpenAdmin?: ((view: AdminView) => void) | undefined } = {}) {
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
      <UserMenu onOpenAdmin={onOpenAdmin} />
    </aside>
  );
}
