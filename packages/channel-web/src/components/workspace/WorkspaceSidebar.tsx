/**
 * The sidebar. Three destinations and a roster.
 *
 * Note what is NOT here: a conversation list. Conversations moved inside the
 * agent they belong to, which is the structural change the whole refresh is
 * about. The roster is the navigation now.
 */
import { ChevronDown, ChevronUp, Inbox, Bot, Activity } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { AvatarTile } from '@/components/AvatarTile';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent } from '@/lib/workspace-api';
import { StateDot } from './bits';

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
}

export function WorkspaceSidebar({
  agents,
  route,
  activeAgentId,
  pendingCount,
  rosterOpen,
  onRoster,
  onToday,
  onActivity,
  onAgent,
}: Props) {
  const row = (active: boolean) =>
    cn(
      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px]',
      active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60',
    );

  return (
    <aside className="flex w-[236px] shrink-0 flex-col border-r border-border">
      <div className="flex h-14 items-center px-4">
        <BrandMark size="md" />
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        <button type="button" onClick={onToday} className={row(route === 'today')}>
          <Inbox size={14} className="shrink-0" />
          Today
          {pendingCount > 0 && (
            <Badge className="ml-auto h-5 min-w-5 justify-center bg-warning-soft px-1.5 text-[11px] text-warning hover:bg-warning-soft">
              {pendingCount}
            </Badge>
          )}
        </button>

        <button
          type="button"
          onClick={onActivity}
          className={row(route === 'activity')}
        >
          <Activity size={14} className="shrink-0" />
          Activity
        </button>

        <button
          type="button"
          onClick={() => onRoster(!rosterOpen)}
          className={row(route === 'agent')}
        >
          <Bot size={14} className="shrink-0" />
          Agents
          <span className="ml-auto text-[11.5px] text-muted-foreground">
            {agents.length}
          </span>
          {rosterOpen ? (
            <ChevronUp size={12} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={12} className="text-muted-foreground" />
          )}
        </button>

        {rosterOpen &&
          agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onAgent(a.id)}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-md pl-8 pr-2.5 text-left text-[13px]',
                route === 'agent' && activeAgentId === a.id
                  ? 'bg-primary-soft text-primary'
                  : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              <StateDot state={a.paused ? 'resting' : a.state} />
              <span className="truncate">{a.name}</span>
            </button>
          ))}
      </nav>

      <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
        <AvatarTile size={26} shape="round">
          <span className="text-[10px] font-medium">DK</span>
        </AvatarTile>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px]">Dana Keeler</div>
          <div className="truncate text-[11.5px] text-muted-foreground">
            VP Operations
          </div>
        </div>
      </div>
    </aside>
  );
}
