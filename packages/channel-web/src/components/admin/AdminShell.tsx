import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useIsCompact } from '@/lib/use-compact';
import { ModelsTab } from './ModelsTab';
import { useLayoutEffect, useRef, useState } from 'react';
import { ADMIN_NAV, AdminSidebar, type AdminTabId } from './AdminSidebar';
import { AdminPane } from './AdminPane';
import { AdminPaneHeader } from './AdminPaneHeader';
import { ProvidersPanel } from './ProvidersPanel';
import { ModelConfigTab } from './ModelConfigTab';
import { AuthProvidersTab } from './AuthProvidersTab';
import { AgentForm } from './AgentForm';
import { TeamList } from './TeamList';
import { BrandingTab } from './BrandingTab';
import { UsageTab } from './UsageTab';
import { StorageTab } from './StorageTab';
import { SkillsTab } from '../settings/SkillsTab';
import { ConnectorsTab } from '../settings/ConnectorsTab';
import { SitesTab } from '../settings/SitesTab';
import { RoutinesTab } from '../routines/RoutinesTab';

export interface AdminShellProps {
  /**
   * Admins get the full set of admin tabs (Connectors among them — only admins
   * define connectors); every user gets the Settings tabs (Skills, Sites,
   * Agents, …). The admin-only tabs are gated here AND on the
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
  /**
   * The tab to open on (TASK-627: the rail's paused-memory "Fix this" opens
   * AI model keys). An admin-only tab is honoured only for an admin; anyone
   * else lands on the default, the same as the in-shell nav would allow.
   */
  initialTab?: AdminTabId | undefined;
}

/** The tabs only an admin's nav shows. */
const ADMIN_ONLY_TABS: ReadonlySet<AdminTabId> = new Set(ADMIN_NAV.map((item) => item.id));

interface TabMeta {
  eyebrow: string;
  title: string;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  models: { eyebrow: 'Admin', title: 'Available models' },
  skills: { eyebrow: 'Settings', title: 'Skills' },
  sites: { eyebrow: 'Settings', title: 'Sites' },
  connectors: { eyebrow: 'Admin', title: 'Connectors' },
  agents: { eyebrow: 'Settings', title: 'Agents' },
  routines: { eyebrow: 'Settings', title: 'Routines' },
  storage: { eyebrow: 'Settings', title: 'Storage' },
  providers: { eyebrow: 'Admin', title: 'AI model keys' },
  'model-config': { eyebrow: 'Admin', title: 'Helper model' },
  'auth-providers': { eyebrow: 'Admin', title: 'Sign-in methods' },
  teams: { eyebrow: 'Admin', title: 'Teams' },
  branding: { eyebrow: 'Admin', title: 'Branding' },
  usage: { eyebrow: 'Admin', title: 'Usage and limits' },
};

export function AdminShell({
  isAdmin,
  onClose,
  backLabel = 'chat',
  initialTab,
}: AdminShellProps) {
  const [activeTab, setActiveTab] = useState<AdminTabId>(() =>
    initialTab !== undefined &&
    // A tab this shell doesn't know (a retired id such as the pre-slice-2a
    // `connectors-user`) would render no title and no body. Land on the
    // default instead.
    Object.hasOwn(TAB_META, initialTab) &&
    (isAdmin || !ADMIN_ONLY_TABS.has(initialTab))
      ? initialTab
      : 'skills',
  );
  const meta = TAB_META[activeTab];
  const compact = useIsCompact();
  const [navOpen, setNavOpen] = useState(false);

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
      {compact ? (
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" aria-describedby={undefined} className="flex w-[280px] flex-col gap-0 p-0">
            <SheetTitle className="sr-only">Settings navigation</SheetTitle>
            <AdminSidebar activeTab={activeTab} isAdmin={isAdmin}
              onTabChange={(tab) => { setActiveTab(tab); setNavOpen(false); }}
              onBack={onClose} backLabel={backLabel} />
          </SheetContent>
        </Sheet>
      ) : <AdminSidebar activeTab={activeTab} isAdmin={isAdmin} onTabChange={setActiveTab} onBack={onClose} backLabel={backLabel} />}
      <AdminPane
        header={
          <AdminPaneHeader
            eyebrow={meta.eyebrow}
            title={meta.title}
            headingRef={headingRef}
            badge={compact ? (
              <Button type="button" variant="ghost" size="icon" aria-label="Open settings navigation" onClick={() => setNavOpen(true)}>
                <Menu aria-hidden="true" />
              </Button>
            ) : undefined}
          />
        }
      >
        {activeTab === 'skills' && <SkillsTab isAdmin={isAdmin} />}
        {activeTab === 'sites' && <SitesTab />}
        {activeTab === 'connectors' && isAdmin && <ConnectorsTab />}
        {activeTab === 'providers' && <ProvidersPanel />}
        {activeTab === 'model-config' && <ModelConfigTab />}
        {activeTab === 'models' && <ModelsTab onOpenKeys={() => setActiveTab('providers')} />}
        {activeTab === 'auth-providers' && <AuthProvidersTab />}
        {activeTab === 'agents' && <AgentForm isAdmin={isAdmin} />}
        {activeTab === 'routines' && <RoutinesTab isAdmin={isAdmin} />}
        {activeTab === 'teams' && <TeamList />}
        {activeTab === 'branding' && <BrandingTab />}
        {activeTab === 'usage' && <UsageTab />}
        {activeTab === 'storage' && <StorageTab isAdmin={isAdmin} />}
      </AdminPane>
    </div>
  );
}
