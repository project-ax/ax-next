// packages/channel-web/src/components/admin/AdminSidebar.tsx
import {
  ArrowLeft,
  ChevronDown,
  KeyRound,
  Cpu,
  Layers,
  User,
  UsersRound,
  ShieldCheck,
  Plug,
  Wrench,
  ListChecks,
  Palette,
  Gauge,
  HardDrive,
  Globe,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AdminNavItem } from './AdminNavItem';
import { cn } from '@/lib/utils';

export type AdminTabId =
  // User tabs (every user) — the agent-centric Settings surface: Skills ·
  // Sites · Agents. Sites holds the two per-person site lists (Allowed sites,
  // Sites we read without asking) that used to sit under Connectors.
  // Agents are owner-scoped, so every user lists + manages their OWN agents here
  // (attaching connectors/skills; signing in happens in each agent's rail).
  | 'skills'
  | 'sites'
  | 'agents'
  | 'routines'
  // TASK-690 — every person's own storage bar; an admin also sees the limit
  // form and everyone's usage inside the same tab, so the admin nav stays put.
  | 'storage'
  // Admin tabs (admins only) — genuinely workspace-level config with no user
  // counterpart. Connectors is one since slice 2a: only admins define
  // connectors (each connector is still the single home for its own key(s)).
  | 'connectors'
  | 'providers'
  | 'models'
  | 'model-config'
  | 'auth-providers'
  | 'teams'
  | 'branding'
  | 'usage';

type NavItem = { id: AdminTabId; label: string; icon: typeof KeyRound };

const USER_NAV: NavItem[] = [
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'sites', label: 'Sites', icon: Globe },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'routines', label: 'Routines', icon: ListChecks },
  { id: 'storage', label: 'Storage', icon: HardDrive },
];

export const ADMIN_NAV: NavItem[] = [
  // Slice 2a — only admins define connectors, so it leads the Admin group.
  { id: 'connectors', label: 'Connectors', icon: Plug },
  { id: 'providers', label: 'AI model keys', icon: KeyRound },
  { id: 'models', label: 'Models', icon: Layers },
  { id: 'model-config', label: 'Helper model', icon: Cpu },
  { id: 'auth-providers', label: 'Sign-in methods', icon: ShieldCheck },
  { id: 'teams', label: 'Teams', icon: UsersRound },
  { id: 'branding', label: 'Branding', icon: Palette },
  // TASK-692 — who used what, the two per-person limits, and the pause switch.
  { id: 'usage', label: 'Usage', icon: Gauge },
];

export interface AdminSidebarProps {
  activeTab: AdminTabId;
  isAdmin: boolean;
  onTabChange: (tab: AdminTabId) => void;
  onBack: () => void;
  /** Names the destination — "chat", "workspace". See AdminShell. */
  backLabel: string;
}

function NavSection({ items, activeTab, onTabChange }: {
  items: NavItem[]; activeTab: AdminTabId; onTabChange: (tab: AdminTabId) => void;
}) {
  return <ul className="m-0 flex list-none flex-col gap-2 p-0">
    {items.map((item) => <li key={item.id}>
      <AdminNavItem icon={item.icon} label={item.label} active={activeTab === item.id} onClick={() => onTabChange(item.id)} />
    </li>)}
  </ul>;
}

export function AdminSidebar({ activeTab, isAdmin, onTabChange, onBack, backLabel }: AdminSidebarProps) {
  const adminActive = ADMIN_NAV.some((item) => item.id === activeTab);
  const [expanded, setExpanded] = useState(adminActive);
  // Returning to a personal screen closes the workspace group. Manual expansion
  // still lets an admin find those pages from a personal screen.
  const [previousTab, setPreviousTab] = useState(activeTab);
  if (previousTab !== activeTab) {
    setPreviousTab(activeTab);
    setExpanded(adminActive);
  }
  return (
    <aside className="flex h-full w-full md:w-[220px] shrink-0 flex-col border-r border-border bg-background p-4 font-sans">
      <Button type="button" variant="ghost" className="shrink-0 justify-start px-0" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <ArrowLeft aria-hidden="true" />
        <span className="capitalize">{backLabel}</span>
      </Button>
      <nav aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto pt-6">
        <p className="mb-6 text-sm font-medium">Settings</p>
        <NavSection items={USER_NAV} activeTab={activeTab} onTabChange={onTabChange} />
        {isAdmin && <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-8">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" className="group mb-2 w-full justify-between px-0">
              <span>Administration</span>
              <ChevronDown aria-hidden="true" className={cn('transition-transform', !expanded && '-rotate-90')} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <NavSection items={ADMIN_NAV} activeTab={activeTab} onTabChange={onTabChange} />
          </CollapsibleContent>
        </Collapsible>}
      </nav>
    </aside>
  );
}
