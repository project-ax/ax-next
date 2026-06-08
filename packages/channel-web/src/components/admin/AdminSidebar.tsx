// packages/channel-web/src/components/admin/AdminSidebar.tsx
import {
  ChevronLeft,
  KeyRound,
  Cpu,
  User,
  UsersRound,
  ShieldCheck,
  Plug,
  Wrench,
  ListChecks,
} from 'lucide-react';
import { BrandMark } from '../BrandMark';
import { SidebarSectionLabel } from '../SidebarSectionLabel';
import { AdminNavItem } from './AdminNavItem';
import { cn } from '@/lib/utils';

export type AdminTabId =
  // User tabs (every user) — the agent-centric Settings surface: Skills ·
  // Connectors · Agents. Each connector is the single home for its own key(s);
  // the separate Credentials tab was folded out (credentials-into-connectors).
  // Agents are owner-scoped, so every user lists + manages their OWN agents here
  // (attaching their own personal connectors/skills; workspace ones stay admin).
  | 'skills'
  | 'connectors-user'
  | 'agents'
  | 'routines'
  // Admin tabs (admins only) — genuinely workspace-level config with no user
  // counterpart. The former catalog / admit-queue / connector-registry surfaces
  // were folded out of the nav (settings-unified epic); their admin curation
  // now lives inline inside the user Skills/Connectors tabs.
  | 'providers'
  | 'model-config'
  | 'auth-providers'
  | 'teams';

type NavItem = { id: AdminTabId; label: string; icon: typeof KeyRound };

const USER_NAV: NavItem[] = [
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'connectors-user', label: 'Connectors', icon: Plug },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'routines', label: 'Routines', icon: ListChecks },
];

const ADMIN_NAV: NavItem[] = [
  { id: 'providers', label: 'AI model keys', icon: KeyRound },
  { id: 'model-config', label: 'Default AI model', icon: Cpu },
  { id: 'auth-providers', label: 'Sign-in methods', icon: ShieldCheck },
  { id: 'teams', label: 'Teams', icon: UsersRound },
];

export interface AdminSidebarProps {
  activeTab: AdminTabId;
  isAdmin: boolean;
  onTabChange: (tab: AdminTabId) => void;
  onBackToChat: () => void;
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
  onBackToChat,
}: AdminSidebarProps) {
  return (
    <aside className="w-[240px] shrink-0 border-r border-border bg-background flex flex-col font-sans">
      <div className="px-3 pt-3.5 pb-2 min-h-[48px] flex items-center justify-between gap-2">
        <BrandMark word="ax" />
        <button
          type="button"
          onClick={onBackToChat}
          className={cn(
            'cursor-pointer inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-xl text-[11.5px]',
            'text-muted-foreground bg-muted border border-transparent',
            'hover:text-foreground hover:bg-background hover:border-border transition-colors',
          )}
        >
          <ChevronLeft className="w-[11px] h-[11px]" strokeWidth={1.4} />
          chat
        </button>
      </div>
      <div className="flex-1 overflow-hidden pt-2.5 pb-2 flex flex-col">
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
