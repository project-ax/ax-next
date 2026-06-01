import { useState } from 'react';
import { AdminSidebar, type AdminTabId } from './AdminSidebar';
import { AdminPane } from './AdminPane';
import { AdminPaneHeader } from './AdminPaneHeader';
import { ProvidersPanel } from './ProvidersPanel';
import { ModelConfigTab } from './ModelConfigTab';
import { AuthProvidersTab } from './AuthProvidersTab';
import { AgentForm } from './AgentForm';
import { TeamList } from './TeamList';
import { SkillsTab } from '../settings/SkillsTab';
import { ConnectorsTab } from '../settings/ConnectorsTab';
import { CredentialsTab } from '../settings/CredentialsTab';

export interface AdminShellProps {
  /**
   * Admins get the full set of admin tabs; every user gets the three Settings
   * tabs (Skills, Connectors, Credentials). The admin-only tabs are gated here
   * AND on the server — every /admin/* route enforces role === 'admin'
   * regardless of what the in-shell nav shows, so hiding the tabs is a UX
   * nicety, not the boundary.
   */
  isAdmin: boolean;
  onClose: () => void;
}

interface TabMeta {
  eyebrow: string;
  title: string;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  skills: { eyebrow: 'Settings', title: 'Skills' },
  'connectors-user': { eyebrow: 'Settings', title: 'Connectors' },
  credentials: { eyebrow: 'Settings', title: 'Credentials' },
  providers: { eyebrow: 'Admin', title: 'AI model keys' },
  'model-config': { eyebrow: 'Admin', title: 'Default AI model' },
  'auth-providers': { eyebrow: 'Admin', title: 'Sign-in methods' },
  agents: { eyebrow: 'Admin', title: 'Agents' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
};

export function AdminShell({ isAdmin, onClose }: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>('skills');
  const meta = TAB_META[activeTab];

  return (
    <div className="flex flex-1 min-w-0 h-full bg-background">
      <AdminSidebar
        activeTab={activeTab}
        isAdmin={isAdmin}
        onTabChange={setActiveTab}
        onBackToChat={onClose}
      />
      <AdminPane
        header={<AdminPaneHeader eyebrow={meta.eyebrow} title={meta.title} />}
      >
        {activeTab === 'skills' && <SkillsTab />}
        {activeTab === 'connectors-user' && <ConnectorsTab isAdmin={isAdmin} />}
        {activeTab === 'credentials' && <CredentialsTab />}
        {activeTab === 'providers' && <ProvidersPanel />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'auth-providers' && <AuthProvidersTab />}
        {activeTab === 'agents' && <AgentForm />}
        {activeTab === 'teams' && <TeamList />}
      </AdminPane>
    </div>
  );
}
