/**
 * Agent-workspace prototype — small shared pieces.
 *
 * Everything here composes shadcn primitives and semantic tokens. No raw
 * colours: "held for you" gets the `warning` token added for exactly this
 * surface, because waiting-on-a-human is a real third state that is neither an
 * error nor business as usual.
 */
import {
  AlertTriangle,
  Ban,
  CalendarDays,
  Check,
  CircleDashed,
  CornerUpLeft,
  Hand,
  Hash,
  Mail,
  Plane,
  type LucideIcon,
} from 'lucide-react';
import { AvatarTile } from '@/components/AvatarTile';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  AgentRunState,
  PermissionRow,
  WorkspaceAgent,
} from '../../../mock/workspace-types';

const ICONS: Record<string, LucideIcon> = {
  mail: Mail,
  hash: Hash,
  'calendar-days': CalendarDays,
  'corner-up-left': CornerUpLeft,
  plane: Plane,
};

export function AgentTile({
  agent,
  size = 26,
}: {
  agent: Pick<WorkspaceAgent, 'icon'>;
  size?: number;
}) {
  const Icon = ICONS[agent.icon] ?? CircleDashed;
  return (
    <AvatarTile size={size} shape="square">
      <Icon size={Math.round(size * 0.5)} className="text-foreground/70" />
    </AvatarTile>
  );
}

/** Colour is the state, so the dot needs no label to be scannable in a list. */
export function StateDot({
  state,
  className,
}: {
  state: AgentRunState | 'held';
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'h-[7px] w-[7px] shrink-0 rounded-full',
        state === 'working' && 'bg-primary',
        state === 'waiting' && 'bg-warning',
        state === 'held' && 'bg-warning',
        state === 'resting' && 'bg-ink-ghost',
        state === 'stopped' && 'bg-destructive',
        className,
      )}
    />
  );
}

export function AgentStateLabel({ agent }: { agent: WorkspaceAgent }) {
  if (agent.paused) return <Badge variant="secondary">Paused</Badge>;
  if (agent.state === 'stopped') return <Badge variant="destructive">Stopped</Badge>;
  if (agent.state === 'waiting')
    return (
      <Badge variant="secondary" className="bg-warning-soft text-warning">
        Waiting on you
      </Badge>
    );
  if (agent.state === 'working') return <Badge variant="secondary">Working</Badge>;
  return <Badge variant="secondary">Resting</Badge>;
}

/**
 * Elapsed, never remaining.
 *
 * The design this came from showed a progress bar and "~2 min left". An agent
 * cannot know either number, and one wrong ETA costs more trust than the widget
 * could ever earn. What it CAN report honestly is how long it has been going
 * and how far through a countable list it is.
 */
export function Elapsed({ since }: { since: string | null }) {
  if (!since) return null;
  const ms = Date.now() - Date.parse(since);
  const mins = Math.max(0, Math.round(ms / 60_000));
  return (
    <span>
      {mins < 1 ? 'just started' : `started ${mins} min ago`}
    </span>
  );
}

const VERDICT: Record<
  PermissionRow['verdict'],
  { Icon: LucideIcon; tone: string; label: string }
> = {
  allow: { Icon: Check, tone: 'text-primary', label: 'Allowed' },
  hold: { Icon: Hand, tone: 'text-warning', label: 'Held for you' },
  deny: { Icon: Ban, tone: 'text-destructive', label: 'Never' },
};

/**
 * A permission row, rendered from the policy record rather than authored prose.
 * A row whose sentence could not be generated says so out loud — an omitted
 * capability reads as "it cannot do that", which is the dangerous direction to
 * be wrong in.
 */
export function PermissionLine({ row }: { row: PermissionRow }) {
  const v = VERDICT[row.verdict];
  return (
    <div className="flex items-start gap-2.5 py-1 text-[13px]">
      <v.Icon
        size={13}
        aria-label={v.label}
        className={cn('mt-[3px] shrink-0', v.tone)}
      />
      <span className="min-w-0">
        <span className="text-muted-foreground">{row.sentence}</span>
        {row.source === null ? (
          <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-warning">
            <AlertTriangle size={10} />
            no rule mapped
          </span>
        ) : (
          <span className="ml-1.5 font-mono text-[10.5px] text-ink-ghost">
            {row.source}
          </span>
        )}
      </span>
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 text-[11.5px] font-medium text-muted-foreground first:mt-0">
      {children}
    </div>
  );
}
