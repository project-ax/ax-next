import { useState } from 'react';
import { AdminSidebar, type AdminTabId } from './AdminSidebar';
import { AdminPane } from './AdminPane';
import { AdminPaneHeader } from './AdminPaneHeader';
import { ProviderKeysTab } from './ProviderKeysTab';
import { ModelConfigTab } from './ModelConfigTab';
import { AuthProvidersTab } from './AuthProvidersTab';
import { AgentForm } from './AgentForm';
import { McpServerForm } from './McpServerForm';
import { TeamList } from './TeamList';
import { SkillsTab } from './SkillsTab';

export interface AdminShellProps {
  onClose: () => void;
}

interface TabMeta {
  eyebrow: string;
  title: string;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  'provider-keys': { eyebrow: 'Admin', title: 'Provider keys' },
  'model-config': { eyebrow: 'Admin', title: 'Model config' },
  'auth-providers': { eyebrow: 'Admin', title: 'Auth providers' },
  agents: { eyebrow: 'Admin', title: 'Agents' },
  skills: { eyebrow: 'Admin', title: 'Skills' },
  'mcp-servers': { eyebrow: 'Admin', title: 'MCP servers' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
};

export function AdminShell({ onClose }: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>('provider-keys');
  const meta = TAB_META[activeTab];

  return (
    <div className="flex flex-1 min-w-0 h-full bg-background">
      <AdminSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onBackToChat={onClose}
      />
      <AdminPane
        header={<AdminPaneHeader eyebrow={meta.eyebrow} title={meta.title} />}
      >
        {activeTab === 'provider-keys' && <ProviderKeysTab />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'auth-providers' && <AuthProvidersTab />}
        {activeTab === 'agents' && <AgentForm />}
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'mcp-servers' && <McpServerForm />}
        {activeTab === 'teams' && <TeamList />}
      </AdminPane>
    </div>
  );
}
