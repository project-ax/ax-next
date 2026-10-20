import {
  Activity,
  Bot,
  ChevronDown,
  Inbox,
  PanelLeft,
  Plus,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { UserMenu } from '@/components/UserMenu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useRailPreference } from '@/lib/use-rail-preference';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { NEW_AGENT_OPENER_ATTR } from '@/lib/new-agent-return-focus';
import { StateDot, StateDotSlot, stateWord } from './bits';
import { IconTooltip } from './IconTooltip';

interface Props {
  agents: WorkspaceAgent[];
  route: 'today' | 'agent' | 'activity';
  activeAgentId: string | null;
  pendingCount: number;
  rosterOpen: boolean;
  onRoster: (open: boolean) => void;
  onToday: () => void;
  onActivity: () => void;
  onAgent: (id: string) => void;
  onOpenAdminSettings?: (() => void) | undefined;
  onCreateAgent?: (() => void) | undefined;
}

interface NavProps extends Props {
  onNavigate?: (() => void) | undefined;
  collapsed?: boolean;
  onCollapse?: (() => void) | undefined;
}

export function WorkspaceSidebarNav({
  agents,
  route,
  activeAgentId,
  pendingCount,
  rosterOpen,
  onRoster,
  onToday,
  onActivity,
  onAgent,
  onOpenAdminSettings,
  onCreateAgent,
  onNavigate,
  collapsed = false,
  onCollapse,
}: NavProps) {
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
  ) => (
    <IconTooltip label={label} side="right">
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
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
          {iconRow('Activity', Activity, onActivity, route === 'activity')}
          {iconRow(
            'Agents',
            Bot,
            () => {
              onCollapse?.();
              onRoster(true);
            },
            route === 'agent',
          )}
          {onCreateAgent && (
            <IconTooltip label="New agent" side="right">
              <Button
                variant="ghost"
                size="icon"
                aria-label="New agent"
                onClick={go(onCreateAgent)}
                {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
              >
                <Plus aria-hidden="true" />
              </Button>
            </IconTooltip>
          )}
        </nav>
      ) : (
        <nav
          aria-label="Workspace"
          className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-5 py-2"
        >
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
            onClick={go(onActivity)}
            className={row()}
            data-active={route === 'activity'}
          >
            <Activity data-icon="inline-start" aria-hidden="true" />
            Activity
          </Button>
          <Collapsible
            className="mt-3.5"
            open={rosterOpen}
            onOpenChange={onRoster}
          >
            <CollapsibleTrigger asChild>
              <Button variant="navigation" className={row()}>
                <Bot data-icon="inline-start" aria-hidden="true" />
                Agents
                <span className="ml-auto text-[12px] text-muted-foreground">
                  {agents.length}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'transition-transform',
                    !rosterOpen && '-rotate-90',
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-0.5">
              {agents.map((a) => (
                <Button
                  key={a.id}
                  variant="navigation"
                  data-active={route === 'agent' && activeAgentId === a.id}
                  onClick={go(() => onAgent(a.id))}
                  className="h-10 w-full gap-2.5 pl-8 pr-2 max-md:min-h-11"
                >
                  <StateDotSlot>
                    <StateDot state={a.state} />
                  </StateDotSlot>
                  <span className="truncate" title={a.name}>
                    {a.name}
                  </span>
                  <span className="sr-only">
                    , {stateWord(a.state).toLowerCase()}
                  </span>
                </Button>
              ))}
              {agents.length === 0 && (
                <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">
                  No agents yet.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
          {onCreateAgent && (
            <Button
              variant="navigation"
              onClick={go(onCreateAgent)}
              className={row()}
              {...{ [NEW_AGENT_OPENER_ATTR]: '' }}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              New agent
            </Button>
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
