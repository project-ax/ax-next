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
}

const TABS: Tab[] = [
  { id: 'provider-keys', label: 'Provider Keys' },
  { id: 'model-config', label: 'Model Config' },
  { id: 'agents', label: 'Agents' },
  { id: 'mcp-servers', label: 'MCP Servers' },
  { id: 'teams', label: 'Teams' },
];

export interface AdminSettingsProps {
  onClose: () => void;
}

export function AdminSettings({ onClose }: AdminSettingsProps) {
  const [activeTab, setActiveTab] = useState<TabId>('provider-keys');

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
        {activeTab === 'provider-keys' && <ProviderKeysTab />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'agents' && <AgentForm />}
        {activeTab === 'mcp-servers' && <McpServerForm />}
        {activeTab === 'teams' && <TeamList />}
      </div>
    </div>
  );
}
