import { useLayoutEffect, useRef, useState } from 'react';
import { AdminSidebar, type AdminTabId } from './AdminSidebar';
import { AdminPane } from './AdminPane';
import { AdminPaneHeader } from './AdminPaneHeader';
import { ProvidersPanel } from './ProvidersPanel';
import { ModelConfigTab } from './ModelConfigTab';
import { AuthProvidersTab } from './AuthProvidersTab';
import { AgentForm } from './AgentForm';
import { TeamList } from './TeamList';
import { BrandingTab } from './BrandingTab';
import { SkillsTab } from '../settings/SkillsTab';
import { ConnectorsTab } from '../settings/ConnectorsTab';
import { RoutinesTab } from '../routines/RoutinesTab';

export interface AdminShellProps {
  /**
   * Admins get the full set of admin tabs; every user gets the Settings tabs
   * (Skills, Connectors — each connector owns its own key(s), so there's no
   * separate Credentials tab). The admin-only tabs are gated here AND on the
   * server — every /admin/* route enforces role === 'admin' regardless of what
   * the in-shell nav shows, so hiding the tabs is a UX nicety, not the boundary.
   */
  isAdmin: boolean;
  onClose: () => void;
  /**
   * What the back button calls the place you came from. It said "chat"
   * unconditionally, which was fine while chat was the only shell that could
   * open Settings — and became a wrong sign the moment the workspace could,
   * pointing people at a surface that is being retired.
   *
   * Naming the destination (rather than a bare "Back") is the existing design
   * and worth keeping; it just has to be the CALLER's destination.
   */
  backLabel?: string;
}

interface TabMeta {
  eyebrow: string;
  title: string;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  skills: { eyebrow: 'Settings', title: 'Skills' },
  'connectors-user': { eyebrow: 'Settings', title: 'Connectors' },
  agents: { eyebrow: 'Settings', title: 'Agents' },
  routines: { eyebrow: 'Settings', title: 'Routines' },
  providers: { eyebrow: 'Admin', title: 'AI model keys' },
  'model-config': { eyebrow: 'Admin', title: 'Helper model' },
  'auth-providers': { eyebrow: 'Admin', title: 'Sign-in methods' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
  branding: { eyebrow: 'Admin', title: 'Branding' },
};

export function AdminShell({ isAdmin, onClose, backLabel = 'chat' }: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>('skills');
  const meta = TAB_META[activeTab];

  // TASK-510 — opening Settings takes focus INTO it.
  //
  // Settings is a pane swap (see `App.tsx`): the menu item that opened it is
  // destroyed in the same commit that mounts this shell, so nothing holds the
  // keyboard and a screen-reader user is left on `<body>` in a surface they
  // were never taken to. The page heading is the target, not the first
  // focusable (the back button): it announces WHERE you are, and it is the
  // one title present on every tab (TASK-446).
  //
  // Mount-only on purpose: switching tabs leaves focus on the nav item the
  // person chose, which is where they are working.
  //
  // A LAYOUT effect, not a passive one (TASK-451): a passive effect runs a
  // task after the commit, a window in which the heading is on screen and
  // focus is still on `<body>`.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex flex-1 min-w-0 h-full bg-background">
      <AdminSidebar
        activeTab={activeTab}
        isAdmin={isAdmin}
        onTabChange={setActiveTab}
        onBack={onClose}
        backLabel={backLabel}
      />
      <AdminPane
        header={
          <AdminPaneHeader
            eyebrow={meta.eyebrow}
            title={meta.title}
            headingRef={headingRef}
          />
        }
      >
        {activeTab === 'skills' && <SkillsTab isAdmin={isAdmin} />}
        {activeTab === 'connectors-user' && <ConnectorsTab isAdmin={isAdmin} />}
        {activeTab === 'providers' && <ProvidersPanel />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'auth-providers' && <AuthProvidersTab />}
        {activeTab === 'agents' && <AgentForm isAdmin={isAdmin} />}
        {activeTab === 'routines' && <RoutinesTab isAdmin={isAdmin} />}
        {activeTab === 'teams' && <TeamList />}
        {activeTab === 'branding' && <BrandingTab />}
      </AdminPane>
    </div>
  );
}
