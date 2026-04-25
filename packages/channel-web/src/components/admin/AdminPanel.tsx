/**
 * AdminPanel — modal chrome for the admin views.
 *
 * Routes by `view` ∈ { 'agents' | 'mcp-servers' | 'teams' | null }. Task 22
 * wires the agents form; tasks 23 and 24 fill in the other two slots.
 *
 * The overlay click-outside closes the panel; the × button does the same.
 * Escape-to-close and focus-trap polish are deferred (the panel is admin-
 * only, low-traffic, and the design-handoff doesn't lean on them).
 */
import type { AdminView } from '../../lib/admin';
import { AgentForm } from './AgentForm';

const TITLES: Record<Exclude<AdminView, null>, string> = {
  agents: 'Agents',
  'mcp-servers': 'MCP Servers',
  teams: 'Teams',
};

export function AdminPanel({
  view,
  onClose,
}: {
  view: AdminView;
  onClose: () => void;
}) {
  if (!view) return null;
  return (
    <div
      className="admin-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="admin-panel" role="dialog" aria-modal="true">
        <div className="admin-panel-header">
          <h2 className="admin-panel-title">Admin · {TITLES[view]}</h2>
          <button
            type="button"
            className="admin-panel-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="admin-panel-body">
          {view === 'agents' && <AgentForm />}
          {view === 'mcp-servers' && (
            <div className="admin-stub">
              MCP Servers form lands in Task 23.
            </div>
          )}
          {view === 'teams' && (
            <div className="admin-stub">
              Teams placeholder lands in Task 24.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
