/**
 * FleetCard — one agent on the wall.
 *
 * Identity + status badge + a one-line "what it's doing" + an honest progress
 * hint (a determinate bar when we can estimate a turn phase, an indeterminate
 * shimmer when we can't — we never fake a percentage) + a time label + two
 * actions: Details (opens the detail sheet) and a context action that depends on
 * the agent's kind/status (Chat / Watch PR / Review request / Pick up).
 */
import { ArrowRight, ExternalLink } from 'lucide-react';
import type { FleetAgent } from '../../lib/fleet-data';
import { STATUS_META } from './status-meta';
import { AvatarTile } from '../AvatarTile';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';

export function FleetCard({
  agent,
  onDetails,
  onEnterChat,
}: {
  agent: FleetAgent;
  onDetails: (id: string) => void;
  onEnterChat: (id: string) => void;
}) {
  const meta = STATUS_META[agent.status];
  const timeLabel = agent.status === 'idle' ? agent.lastLabel : agent.startedLabel;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-ink-ghost">
      {/* Identity row */}
      <div className="flex items-center gap-2.5">
        <AvatarTile size={26}>
          <span
            className="h-1.5 w-1.5 rounded-full bg-primary"
            style={agent.color ? { background: agent.color } : undefined}
          />
        </AvatarTile>
        <span className="min-w-0 flex-1 truncate text-[15px] tracking-[-0.01em] text-foreground">
          {agent.name}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            meta.badge,
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden="true" />
          {meta.label}
        </span>
      </div>

      {/* Activity line */}
      <p className="mt-3 line-clamp-2 text-[13.5px] leading-snug text-foreground">{agent.activity}</p>

      {/* Status-specific middle */}
      {agent.status === 'working' && <WorkingHint agent={agent} />}
      {agent.status === 'waiting' && agent.request && (
        <p className="mt-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-[12.5px] text-foreground">
          {agent.name} {agent.request}.
        </p>
      )}
      {agent.status === 'error' && (
        <p className="mt-2 rounded-md bg-destructive-soft px-2.5 py-1.5 text-[12.5px] text-foreground">
          Stopped mid-task — the sandbox went away before the turn finished. Nothing was lost.
        </p>
      )}

      {/* Footer: time + actions */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {agent.taskId ? `${agent.taskId} · ` : ''}
          {timeLabel}
          {agent.prNumber ? ` · PR #${agent.prNumber}${agent.prState ? ` (${agent.prState})` : ''}` : ''}
        </span>
        <Button variant="ghost" size="sm" className="h-8 px-2.5" onClick={() => onDetails(agent.id)}>
          Details
        </Button>
        <ContextAction agent={agent} onEnterChat={onEnterChat} />
      </div>
    </div>
  );
}

function WorkingHint({ agent }: { agent: FleetAgent }) {
  return (
    <div className="mt-3">
      {typeof agent.progress === 'number' ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-primary transition-all duration-700"
            style={{ width: `${agent.progress}%` }}
          />
        </div>
      ) : (
        // Indeterminate: we can't estimate the phase, so shimmer rather than lie.
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        </div>
      )}
      {agent.phase && (
        <p className="mt-1.5 font-mono text-[11px] tracking-[0.01em] text-muted-foreground">
          {agent.phase}…
        </p>
      )}
    </div>
  );
}

function ContextAction({
  agent,
  onEnterChat,
}: {
  agent: FleetAgent;
  onEnterChat: (id: string) => void;
}) {
  if (agent.status === 'waiting') {
    return (
      <Button size="sm" className="h-8 px-2.5" onClick={() => onEnterChat(agent.id)}>
        Review request
      </Button>
    );
  }
  if (agent.status === 'error') {
    return (
      <Button variant="outline" size="sm" className="h-8 px-2.5" onClick={() => onEnterChat(agent.id)}>
        Pick up
      </Button>
    );
  }
  if (agent.kind === 'worker') {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 px-2.5"
        disabled={!agent.prNumber}
        onClick={() => agent.prNumber && window.open(`#pr-${agent.prNumber}`, '_blank')}
      >
        Watch PR <ExternalLink className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return (
    <Button size="sm" className="h-8 gap-1.5 px-2.5" onClick={() => onEnterChat(agent.id)}>
      Chat <ArrowRight className="h-3.5 w-3.5" />
    </Button>
  );
}
