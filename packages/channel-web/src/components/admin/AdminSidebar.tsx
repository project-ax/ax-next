// packages/channel-web/src/components/admin/AdminSidebar.tsx
import {
  ChevronLeft,
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
import { BrandMark } from '../BrandMark';
import { SidebarSectionLabel } from '../SidebarSectionLabel';
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

function NavSection({
  label,
  items,
  activeTab,
  onTabChange,
}: {
  label: string;
  items: NavItem[];
  activeTab: AdminTabId;
  onTabChange: (t: AdminTabId) => void;
}) {
  return (
    <>
      <SidebarSectionLabel className="px-4 py-2">{label}</SidebarSectionLabel>
      <ul className="flex flex-col gap-px px-1 list-none m-0 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <AdminNavItem
              icon={item.icon}
              label={item.label}
              active={activeTab === item.id}
              onClick={() => onTabChange(item.id)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

export function AdminSidebar({
  activeTab,
  isAdmin,
  onTabChange,
  onBack,
  backLabel,
}: AdminSidebarProps) {
  return (
    <aside className="ax-panel h-full w-[258px] shrink-0 bg-sidebar flex flex-col font-sans">
      <div className="px-5 pt-5 pb-3 min-h-[48px] flex items-center justify-between gap-2">
        <BrandMark />
        <button
          type="button"
          onClick={onBack}
          className={cn(
            'cursor-pointer inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-xl text-[11.5px]',
            'text-muted-foreground bg-muted border border-transparent',
            'hover:text-foreground hover:bg-background hover:border-border transition-colors',
          )}
        >
          <ChevronLeft className="w-[11px] h-[11px]" strokeWidth={1.4} />
          {backLabel}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-2.5 pb-2 flex flex-col">
        <NavSection
          label="Settings"
          items={USER_NAV}
          activeTab={activeTab}
          onTabChange={onTabChange}
        />
        {isAdmin && (
          <NavSection
            label="Admin"
            items={ADMIN_NAV}
            activeTab={activeTab}
            onTabChange={onTabChange}
          />
        )}
      </div>
    </aside>
  );
}
