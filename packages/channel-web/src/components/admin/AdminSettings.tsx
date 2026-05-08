/**
 * AdminSettings — main in-place settings shell (tab nav + content routing).
 *
 * Renders as a full replacement of the main content pane — NOT a modal
 * or overlay. Fills the `.pane` area.
 *
 * Default tab is 'provider-keys' every render (no persistence).
 * One row of tabs on the left nav; content in the right panel.
 */
import { useState } from 'react';
import { ProviderKeysTab } from './ProviderKeysTab';
import { ModelConfigTab } from './ModelConfigTab';
import { AgentForm } from './AgentForm';
import { McpServerForm } from './McpServerForm';
import { TeamList } from './TeamList';

type TabId = 'provider-keys' | 'model-config' | 'agents' | 'mcp-servers' | 'teams';

interface Tab {
  id: TabId;
  label: string;
  /** Editorial title shown above the tab content. */
  title: string;
  /** Short caption explaining what the tab is for. */
  caption: string;
}

const TABS: Tab[] = [
  {
    id: 'provider-keys',
    label: 'Provider Keys',
    title: 'Provider keys',
    caption:
      'Manage shared API keys for the model providers wired into this deployment.',
  },
  {
    id: 'model-config',
    label: 'Model Config',
    title: 'Model configuration',
    caption:
      'Pick which model handles each role. Only providers with a configured key appear.',
  },
  {
    id: 'agents',
    label: 'Agents',
    title: 'Agents',
    caption: 'Define the agents available across this deployment.',
  },
  {
    id: 'mcp-servers',
    label: 'MCP Servers',
    title: 'MCP servers',
    caption: 'Register Model Context Protocol servers that agents can call into.',
  },
  {
    id: 'teams',
    label: 'Teams',
    title: 'Teams',
    caption: 'Group users so an agent can be scoped to a team rather than a person.',
  },
];

export interface AdminSettingsProps {
  onClose: () => void;
}

export function AdminSettings({ onClose }: AdminSettingsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('provider-keys');
  const active = TABS.find((t) => t.id === activeTab) ?? TABS[0]!;

  return (
    <div className="admin-settings">
      <nav className="admin-settings-nav">
        <button className="admin-settings-back" onClick={onClose}>
          ← Back to chat
        </button>
        <div className="admin-settings-title">Admin Settings</div>
        <ul className="admin-settings-tabs" role="tablist">
          {TABS.map((tab) => (
            <li key={tab.id} role="presentation">
              <button
                role="tab"
                aria-selected={activeTab === tab.id}
                className="admin-settings-tab"
                data-active={activeTab === tab.id || undefined}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="admin-settings-content" role="tabpanel">
        <div className="admin-canary-banner" role="status">
          <span className="admin-canary-banner-tag">Advisory</span>
          <span className="admin-canary-banner-text">
            The canary scanner isn't wired in yet. Until it is, this deployment
            has no automated secret-leak veto and no LLM-output redaction. We
            trust ourselves with our internal data, but we wouldn't ship this to
            outside users yet — and neither should you. Tracked for Week&nbsp;13+.
          </span>
        </div>
        <header className="admin-section-head" key={active.id}>
          <div className="admin-section-eyebrow">
            <span className="admin-section-eyebrow-mark" aria-hidden="true" />
            Admin · {active.label}
          </div>
          <h1 className="admin-section-title">{active.title}</h1>
          <p className="admin-section-caption">{active.caption}</p>
        </header>
        <div className="admin-section-body" key={`body-${active.id}`}>
          {activeTab === 'provider-keys' && <ProviderKeysTab />}
          {activeTab === 'model-config' && <ModelConfigTab />}
          {activeTab === 'agents' && <AgentForm />}
          {activeTab === 'mcp-servers' && <McpServerForm />}
          {activeTab === 'teams' && <TeamList />}
        </div>
      </div>
    </div>
  );
}
