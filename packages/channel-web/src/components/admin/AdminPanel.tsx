/**
 * AdminPanel — modal chrome for the admin views.
 *
 * Routes by `view` ∈ { 'agents' | 'mcp-servers' | 'teams' | null }. Task 22
 * wires the agents form; tasks 23 and 24 fill in the other two slots.
 *
 * The overlay click-outside closes the panel; the × button does the same.
 * Escape-to-close and focus-trap polish are deferred (the panel is admin-
 * only, low-traffic, and the design-handoff doesn't lean on them).
 *
 * Top-of-panel banner: per the Week 10–12 plan (scope decision 7), MVP
 * ships without `@ax/scanner-canary`. Operators see this banner every
 * time they open admin until canary lands in Week 13+.
 */
import { useState } from 'react';
import type { AdminView } from '../../lib/admin';
import { AgentForm } from './AgentForm';
import { McpServerForm } from './McpServerForm';
import { TeamList } from './TeamList';
import { CredentialsList } from '../credentials/CredentialsList';
import { CredentialAddMenu } from '../credentials/CredentialAddMenu';

const TITLES: Record<Exclude<AdminView, null>, string> = {
  agents: 'Agents',
  'mcp-servers': 'MCP Servers',
  teams: 'Teams',
  credentials: 'Credentials',
};

export function AdminPanel({
  view,
  onClose,
}: {
  view: AdminView;
  onClose: () => void;
}) {
  // Bumped on each successful credential add → CredentialsList re-fetches.
  // Lives in this component (not CredentialsList) so the list and the add
  // menu can be siblings without prop-drilling a parent state.
  const [credentialsRefreshKey, setCredentialsRefreshKey] = useState(0);
  if (!view) return null;
  return (
    <div
      className="admin-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="admin-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-panel-title"
      >
        <div className="admin-panel-header">
          <h2 id="admin-panel-title" className="admin-panel-title">
            Admin · {TITLES[view]}
          </h2>
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
          <div className="admin-canary-banner" role="status">
            <span aria-hidden="true" className="admin-canary-banner-icon">
              ⚠
            </span>
            <span>
              Heads up: the canary scanner isn't wired in yet. Until it
              is, this deployment has no automated secret-leak veto and
              no LLM-output redaction. We trust ourselves with our
              internal data, but we wouldn't ship this to outside users
              yet — and neither should you. Tracked for Week 13+.
            </span>
          </div>
          {view === 'agents' && <AgentForm />}
          {view === 'mcp-servers' && <McpServerForm />}
          {view === 'teams' && <TeamList />}
          {view === 'credentials' && (
            <div className="credentials-panel">
              <CredentialAddMenu
                variant="admin"
                onAdded={() => setCredentialsRefreshKey((n) => n + 1)}
              />
              <CredentialsList
                variant="admin"
                refreshKey={credentialsRefreshKey}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
