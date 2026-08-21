/**
 * The event stream, rendered once.
 *
 * The design this came from had three components showing the same rows: a
 * "Done" filter on Today, a per-agent "What it did" tab, and a global Activity
 * page. That is one source of truth rendered three ways, which is exactly the
 * shape that drifts. Here there is one feed and a filter; the per-agent tab is
 * this component with `agentId` set.
 */
import {
  AlertTriangle,
  Check,
  CheckCheck,
  CircleDashed,
  Hand,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';

const KIND: Record<ActivityEvent['kind'], { Icon: LucideIcon; tone: string }> = {
  done: { Icon: Check, tone: 'text-primary' },
  held: { Icon: Hand, tone: 'text-warning' },
  approved: { Icon: CheckCheck, tone: 'text-primary' },
  dismissed: { Icon: X, tone: 'text-muted-foreground' },
  working: { Icon: CircleDashed, tone: 'text-primary' },
  stopped: { Icon: AlertTriangle, tone: 'text-destructive' },
};

interface Props {
  events: ActivityEvent[];
  agents: WorkspaceAgent[];
  /** When set, the feed is scoped to one agent and drops the agent column. */
  agentId?: string;
  onOpenAgent?: (id: string) => void;
}

export function ActivityFeed({ events, agents, agentId, onOpenAgent }: Props) {
  const rows = agentId ? events.filter((e) => e.agentId === agentId) : events;
  const days = [...new Set(rows.map((e) => e.day))];
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
        Nothing recorded yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {days.map((day) => {
        const dayRows = rows.filter((e) => e.day === day);
        return (
          <div key={day}>
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-[12.5px] font-medium">{day}</span>
              <span className="text-[11.5px] text-muted-foreground">
                {dayRows.length}
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              {dayRows.map((e) => {
                const k = KIND[e.kind];
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-3 border-b border-rule-soft px-5 py-3 last:border-b-0"
                  >
                    <k.Icon size={13} className={cn('shrink-0', k.tone)} />
                    {!agentId && (
                      <button
                        type="button"
                        onClick={() => onOpenAgent?.(e.agentId)}
                        className="shrink-0 text-[13px] font-medium hover:text-primary hover:underline hover:underline-offset-2"
                      >
                        {name(e.agentId)}
                      </button>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                      {e.text}
                    </span>
                    {e.tag && (
                      <Badge variant="secondary" className="shrink-0 text-[11px]">
                        {e.tag}
                      </Badge>
                    )}
                    <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                      {e.time}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
