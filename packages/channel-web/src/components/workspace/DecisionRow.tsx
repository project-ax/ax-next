/**
 * One decision in the Today queue.
 *
 * Collapsed it is a scannable line. Expanded it shows the paragraph, the actual
 * artifact (the email body, the invite), what the agent promises not to do
 * until told, and the three ways out.
 *
 * The two states worth studying are the ones a happy-path mockup never shows:
 *
 *   - `stale` — approving re-checked the world and found it had moved, so
 *     nothing was executed and the row re-opens saying what changed. The
 *     primary button changes its wording, because approving now means
 *     something different than it did a second ago.
 *   - resolved-with-undo — for ten seconds after an irreversible outward
 *     action, taking it back is one click and does not require finding the
 *     Activity feed.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { UNDO_WINDOW_MS } from '../../../mock/decision-machine';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import { StateDot } from './bits';

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return `${h}h ago`;
}

/**
 * Where this decision came from, in the user's terms. Worth surfacing: it is
 * the difference between "your agent paused mid-conversation" and "something
 * ran at 3am and stopped to ask", and it explains why one continues in place
 * and the other lands in a queue.
 */
function provenance(d: Decision, agentName: string): string {
  return d.attendance === 'attended'
    ? `Held in your conversation with ${agentName} — it is still waiting there`
    : `Held during an unattended run · ${agentName} ended its turn rather than wait`;
}

interface Props {
  decision: Decision;
  agent: WorkspaceAgent;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent: () => void;
  onApprove: () => void;
  onDismiss: () => void;
  onUndo: () => void;
}

export function DecisionRow({
  decision: d,
  agent,
  expanded,
  onToggle,
  onOpenAgent,
  onApprove,
  onDismiss,
  onUndo,
}: Props) {
  const resolved = d.status === 'executed' || d.status === 'dismissed';
  const [undoLeft, setUndoLeft] = useState<number>(0);

  useEffect(() => {
    if (!resolved || !d.resolvedAt) {
      setUndoLeft(0);
      return;
    }
    const tick = () => {
      const left = UNDO_WINDOW_MS - (Date.now() - Date.parse(d.resolvedAt!));
      setUndoLeft(Math.max(0, Math.ceil(left / 1000)));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [resolved, d.resolvedAt]);

  if (resolved) {
    return (
      <div className="flex items-center gap-3 border-b border-rule-soft px-5 py-3.5 last:border-b-0">
        <StateDot state={d.status === 'executed' ? 'working' : 'resting'} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
          {d.status === 'executed' ? d.approvedText : d.dismissedText}
        </span>
        {undoLeft > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onUndo}
            className="h-7 gap-1.5 text-[12px] text-primary"
          >
            <RotateCcw size={11} />
            Undo · {undoLeft}s
          </Button>
        )}
      </div>
    );
  }

  const stale = d.status === 'stale';

  return (
    <div
      className={cnRow(stale)}
      data-testid={`decision-${d.id}`}
      data-status={d.status}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left"
      >
        <StateDot state={stale ? 'stopped' : 'held'} />
        <span className="shrink-0 text-[13px] font-medium">{agent.name}</span>
        <span
          className={
            stale
              ? 'min-w-0 flex-1 truncate text-[13.5px] text-destructive'
              : 'min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground'
          }
        >
          {stale ? 'Needs another look — the world moved' : d.summary}
        </span>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">
          {ago(d.createdAt)}
        </span>
        {expanded ? (
          <ChevronUp size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="px-5 pb-5 pl-[46px]">
          {stale && d.staleReason && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription className="text-[13px] leading-relaxed">
                <strong className="font-medium">Nothing was sent.</strong>{' '}
                {d.staleReason} Read it again before you approve — approving now
                acts on the situation as it stands.
              </AlertDescription>
            </Alert>
          )}

          <p className="max-w-[660px] text-[13.5px] leading-relaxed text-muted-foreground">
            {d.detail}
          </p>

          {d.preview && (
            <div className="mt-3 max-w-[660px] rounded-md bg-muted px-4 py-3.5">
              <div className="mb-1.5 text-[11.5px] text-muted-foreground">
                {d.preview.meta}
              </div>
              <div className="text-[13px] leading-relaxed">{d.preview.body}</div>
            </div>
          )}

          {/*
            The freshness label describes what was true at hold-time. Once the
            guard has tripped that sentence is false, and repeating it under an
            alert that says the opposite is worse than saying nothing — so the
            clause is dropped on a stale row rather than shown stale.
          */}
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            {provenance(d, agent.name)}
            {!stale && d.freshness && ` · checked against: ${d.freshness.label}`}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onApprove}>
              {stale ? `${d.primaryLabel} anyway` : d.primaryLabel}
            </Button>
            <Button size="sm" variant="secondary" onClick={onOpenAgent}>
              {d.secondaryLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {d.ghostLabel}
            </Button>
            <span className="ml-1 text-[11.5px] text-muted-foreground">
              Nothing happens until you choose
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenAgent}
              className="ml-auto gap-1.5 text-primary"
            >
              Open {agent.name}
              <ArrowRight size={11} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function cnRow(stale: boolean): string {
  return stale
    ? 'border-b border-rule-soft bg-destructive-soft/50 last:border-b-0'
    : 'border-b border-rule-soft last:border-b-0';
}
