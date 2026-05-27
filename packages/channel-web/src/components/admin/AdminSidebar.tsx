// packages/channel-web/src/components/admin/AdminSidebar.tsx
import {
  ChevronLeft,
  KeyRound,
  Cpu,
  User,
  Server,
  UsersRound,
  ShieldCheck,
  Library,
  Inbox,
  Plug,
  Key,
} from 'lucide-react';
import { BrandMark } from '../BrandMark';
import { SidebarSectionLabel } from '../SidebarSectionLabel';
import { AdminNavItem } from './AdminNavItem';
import { cn } from '@/lib/utils';

export type AdminTabId =
  // User tabs (every user) — the Settings surface (TASK-42).
  | 'connections'
  | 'keys'
  // Admin tabs (admins only).
  | 'providers'
  | 'model-config'
  | 'auth-providers'
  | 'agents'
  | 'catalog'
  | 'admit-queue'
  | 'mcp-servers'
  | 'teams';

type NavItem = { id: AdminTabId; label: string; icon: typeof KeyRound };

const USER_NAV: NavItem[] = [
  { id: 'connections', label: 'Connections', icon: Plug },
  { id: 'keys', label: 'Keys', icon: Key },
];

const ADMIN_NAV: NavItem[] = [
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'model-config', label: 'Model config', icon: Cpu },
  { id: 'auth-providers', label: 'Auth providers', icon: ShieldCheck },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'catalog', label: 'Catalog', icon: Library },
  { id: 'admit-queue', label: 'Admit queue', icon: Inbox },
  { id: 'mcp-servers', label: 'MCP servers', icon: Server },
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
