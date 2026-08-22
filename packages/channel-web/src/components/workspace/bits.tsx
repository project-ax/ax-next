/**
 * Agent-workspace — small shared pieces.
 *
 * Everything here composes shadcn primitives and semantic tokens. No raw
 * colours: "held for you" uses the project's existing `warning` token
 * (`tailwind.config.ts` / `index.css`, both themes), because waiting-on-a-human
 * is a real third state that is neither an error nor business as usual.
 */
import { AlertTriangle, Ban, Check, Hand, type LucideIcon } from 'lucide-react';
import { AvatarTile } from '@/components/AvatarTile';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  AgentRunState,
  PermissionRow,
  WorkspaceAgent,
} from '@/lib/workspace-types';

/**
 * Up to two initials from the agent's display name — the same convention the
 * shipped avatars use (`AgentChip` over `AvatarTile`), and the only identity
 * mark we actually have. The prototype keyed a lucide glyph off an `icon`
 * field the real agent record never carried: a picked-for-you icon is
 * decoration pretending to be information.
 */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function AgentTile({
  agent,
  size = 26,
}: {
  agent: Pick<WorkspaceAgent, 'name'>;
  size?: number;
}) {
  return (
    <AvatarTile size={size} shape="square">
      <span
        aria-hidden="true"
        style={{ fontSize: Math.max(9, Math.round(size * 0.38)) }}
        className="font-medium leading-none text-foreground/70"
      >
        {initials(agent.name)}
      </span>
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
