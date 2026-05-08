// packages/channel-web/src/components/admin/AdminSidebar.tsx
import { ChevronLeft, KeyRound, Cpu, User, Server, UsersRound } from 'lucide-react';
import { BrandMark } from '../BrandMark';
import { AdminNavItem } from './AdminNavItem';
import { cn } from '@/lib/utils';


export type AdminTabId =
  | 'provider-keys'
  | 'model-config'
  | 'agents'
  | 'mcp-servers'
  | 'teams';

const NAV: Array<{ id: AdminTabId; label: string; icon: typeof KeyRound }> = [
  { id: 'provider-keys', label: 'Provider keys', icon: KeyRound },
  { id: 'model-config', label: 'Model config', icon: Cpu },
  { id: 'agents', label: 'Agents', icon: User },
  { id: 'mcp-servers', label: 'MCP servers', icon: Server },
  { id: 'teams', label: 'Teams', icon: UsersRound },
];

export interface AdminSidebarProps {
  activeTab: AdminTabId;
  onTabChange: (tab: AdminTabId) => void;
  onBackToChat: () => void;
}

export function AdminSidebar({ activeTab, onTabChange, onBackToChat }: AdminSidebarProps) {
  return (
    <aside className="w-[240px] shrink-0 border-r border-border bg-background flex flex-col font-sans">
      <div className="px-3 pt-3.5 pb-2 flex items-center justify-between gap-2">
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
        <div className="text-[10.5px] tracking-[0.12em] uppercase text-ink-ghost px-4 py-2 font-medium">
          Admin
        </div>
        <ul className="flex flex-col gap-px px-1 list-none m-0 p-0">
          {NAV.map((item) => (
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
      </div>
    </aside>
  );
}
