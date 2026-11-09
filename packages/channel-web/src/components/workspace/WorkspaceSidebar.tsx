import { useEffect, useState } from 'react';
import { Inbox, ListChecks, PanelLeft, Plus, Search } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { UserMenu } from '@/components/UserMenu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRailPreference } from '@/lib/use-rail-preference';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import type { SidebarChatList } from '@/lib/sidebar-chats';
import { AgentSwitcher } from './AgentSwitcher';
import { IconTooltip } from './IconTooltip';
import { SidebarChats } from './SidebarChats';

interface Props {
  agents: WorkspaceAgent[];
  route: 'today' | 'tasks' | 'agent';
  /**
   * The agent the switcher shows and whose chats are listed: the open one on
   * an agent route, otherwise the last one opened. `null` only with no agents.
   */
  selectedAgentId: string | null;
  pendingCount: number;
  onToday: () => void;
  onTasks: () => void;
  onAgent: (id: string) => void;
  onOpenAdminSettings?: (() => void) | undefined;
  onCreateAgent?: (() => void) | undefined;
  onOpenAgentSettings?: ((id: string) => void) | undefined;
  onAgentDeleted?: ((id: string) => void) | undefined;
  chats: SidebarChatList | null;
  chatsError: boolean;
  onOpenChat: (conversationId: string | null) => void;
  onNewChat: () => void;
  onChatsChanged: () => void;
}

interface NavProps extends Props {
  onNavigate?: (() => void) | undefined;
  collapsed?: boolean;
  onCollapse?: (() => void) | undefined;
}

export function WorkspaceSidebarNav({
  agents,
  route,
  selectedAgentId,
  pendingCount,
  onToday,
  onTasks,
  onAgent,
  onOpenAdminSettings,
  onCreateAgent,
  onOpenAgentSettings,
  onAgentDeleted,
  chats,
  chatsError,
  onOpenChat,
  onNewChat,
  onChatsChanged,
  onNavigate,
  collapsed = false,
  onCollapse,
}: NavProps) {
  const selected =
    agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
  /*
    The collapsed rail's Search widens the sidebar and opens the box in one
    press. `SidebarChats` only mounts once expanded, so it reads this as its
    starting state; cleared after, so a later expand does not reopen it.
  */
  const [searchOnExpand, setSearchOnExpand] = useState(false);
  useEffect(() => {
    if (!collapsed && searchOnExpand) setSearchOnExpand(false);
  }, [collapsed, searchOnExpand]);
  const go = (act: () => void) => () => {
    act();
    onNavigate?.();
  };
  const row = () =>
    cn(
      'h-10 w-full gap-2.5 px-2 max-md:min-h-11',
    );
  const iconRow = (
    label: string,
    Icon: typeof Inbox,
    action: () => void,
    active = false,
    needsYou = false,
    disabled = false,
  ) => (
    <IconTooltip label={label} side="right">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        disabled={disabled}
        onClick={go(action)}
        className={cn(
          'relative rounded-sm',
          active && 'bg-primary-soft text-primary',
        )}
      >
        <Icon aria-hidden="true" />
        {needsYou && (
          <span
            className="absolute right-2 top-2 size-1.5 rounded-full bg-warning"
            aria-hidden="true"
          />
        )}
      </Button>
    </IconTooltip>
  );
  return (
    <>
      <div
        className={cn(
          'flex h-20 shrink-0 items-center gap-2 px-5',
          collapsed && 'justify-center px-0',
        )}
      >
        {!collapsed && <BrandMark size="md" workspace />}
        {onCollapse && (
          <IconTooltip
            label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            side="right"
            className={collapsed ? '' : 'ml-auto'}
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
              onClick={onCollapse}
              className={cn(
                'size-7 rounded-sm text-muted-foreground',
                !collapsed && 'ml-auto',
              )}
            >
              <PanelLeft aria-hidden="true" />
            </Button>
          </IconTooltip>
        )}
      </div>
      {collapsed ? (
        <nav
          aria-label="Workspace"
          className="flex flex-1 flex-col items-center gap-1 py-2"
        >
          {iconRow(
            'Today',
            Inbox,
            onToday,
            route === 'today',
            pendingCount > 0,
          )}
          {iconRow('Tasks', ListChecks, onTasks, route === 'tasks')}
          <div className="mt-3.5 flex flex-col items-center gap-1">
            <AgentSwitcher
              agents={agents}
              selected={selected}
              onSelect={onAgent}
              onCreateAgent={onCreateAgent}
              collapsed
              onNavigate={onNavigate}
            />
            {selected !== null && (
              <>
                {/* Held while a message posts or a reply streams, like the expanded list's. */}
                {iconRow('New chat', Plus, onNewChat, false, false, chats?.busy === true)}
                {iconRow('Search chats', Search, () => {
                  setSearchOnExpand(true);
                  onCollapse?.();
                })}
              </>
            )}
          </div>
        </nav>
      ) : (
        <nav
          aria-label="Workspace"
          className="flex min-h-0 flex-1 flex-col px-5 py-2"
        >
          <div className="flex shrink-0 flex-col gap-0.5">
            <Button
              variant="navigation"
              onClick={go(onToday)}
              className={row()}
              data-active={route === 'today'}
            >
              <Inbox data-icon="inline-start" aria-hidden="true" />
              Today
              {pendingCount > 0 && (
                <Badge
                  variant="warning"
                  className="ml-auto h-5 min-w-5 justify-center px-1.5 text-[11px]"
                >
                  {pendingCount}
                </Badge>
              )}
            </Button>
            <Button
              variant="navigation"
              onClick={go(onTasks)}
              className={row()}
              data-active={route === 'tasks'}
            >
              <ListChecks data-icon="inline-start" aria-hidden="true" />
              Tasks
            </Button>
          </div>
          {/*
            Today and Tasks sit ABOVE the switcher on purpose: they span every
            agent, and anything below it reads as belonging to the one picked.
          */}
          <div className="mt-3.5 shrink-0 border-t border-border pt-3.5">
            <AgentSwitcher
              agents={agents}
              selected={selected}
              onSelect={onAgent}
              onCreateAgent={onCreateAgent}
              onOpenSettings={onOpenAgentSettings}
              onDeleted={onAgentDeleted}
              onNavigate={onNavigate}
            />
          </div>
          {selected !== null && (
            <div className="mt-1 flex min-h-0 flex-1 flex-col">
              <SidebarChats
                agentId={selected.id}
                chats={chats}
                error={chatsError}
                showSelection={route === 'agent'}
                startSearching={searchOnExpand}
                onOpen={onOpenChat}
                onNew={onNewChat}
                onChanged={onChatsChanged}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </nav>
      )}
      <UserMenu
        onOpenAdminSettings={onOpenAdminSettings}
        collapsed={collapsed}
      />
    </>
  );
}

export function WorkspaceSidebar(props: Props) {
  const [collapsed, setCollapsed] = useRailPreference('sidebar');
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        'ax-panel flex shrink-0 flex-col bg-sidebar',
        collapsed ? 'w-14' : 'w-[258px]',
      )}
    >
      <WorkspaceSidebarNav
        {...props}
        collapsed={collapsed}
        onCollapse={() => setCollapsed(!collapsed)}
      />
    </aside>
  );
}
