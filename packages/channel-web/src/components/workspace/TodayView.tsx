/**
 * Today — the queue of things waiting on a human, and nothing else.
 *
 * Three deliberate properties:
 *
 *   1. The headline is TEMPLATED FROM COUNTS, never generated prose. "Nothing
 *      has gone wrong" being wrong once ends the relationship, so the only
 *      claims made here are ones derived directly from rows that were counted.
 *
 *   2. There is no "Done" filter. Done was a third renderer over the same event
 *      stream that Activity already owns; the reassurance it carried lives in
 *      the sub-line instead, and the footer links to the real feed.
 *
 *   3. Nothing here is a fixture. The halted-agent row that used to sit at the
 *      top of the queue is gone: it hardcoded a specific mail-server failure,
 *      down to the timestamps, and no agent can reach the `stopped` state yet
 *      anyway. AW-11/AW-2 bring the real halted state and this row back with
 *      it, written from the record instead of from prose.
 */
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Decision, WorkspaceAgent } from '@/lib/workspace-api';
import { DecisionRow } from './DecisionRow';
import { Elapsed, StateDot } from './bits';

const WORDS = [
  'Nothing',
  'One decision',
  'Two decisions',
  'Three decisions',
  'Four decisions',
  'Five decisions',
];

interface Props {
  decisions: Decision[];
  agents: WorkspaceAgent[];
  filter: 'needs' | 'working';
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  onOpenAgent: (id: string) => void;
  /**
   * The three ways out of a decision. OPTIONAL, and all three must be supplied
   * before a single `DecisionRow` renders — the shell supplies none today,
   * because `/api/workspace/state` returns `decisions: []` and there is no
   * route behind approve/dismiss/undo. AW-11 supplies them along with the
   * decisions themselves. Deliberately NOT defaulted to no-op handlers: a
   * button that swallows a click is worse than a button that is not there.
   */
  onApprove?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onUndo?: (id: string) => void;
  onSeeActivity: () => void;
}

export function TodayView({
  decisions,
  agents,
  filter,
  expandedId,
  onExpand,
  onOpenAgent,
  onApprove,
  onDismiss,
  onUndo,
  onSeeActivity,
}: Props) {
  const actionable =
    onApprove !== undefined && onDismiss !== undefined && onUndo !== undefined;

  const open = actionable
    ? decisions.filter((d) => d.status === 'pending' || d.status === 'stale')
    : [];
  const justResolved = actionable
    ? decisions.filter(
        (d) =>
          (d.status === 'executed' || d.status === 'dismissed') &&
          d.resolvedAt !== null &&
          Date.now() - Date.parse(d.resolvedAt) < 60_000,
      )
    : [];
  const working = agents.filter((a) => a.state === 'working');

  const headline =
    open.length === 0
      ? 'Nothing is waiting on you.'
      : `${WORDS[open.length] ?? `${open.length} decisions`} ${open.length === 1 ? 'is' : 'are'} waiting on you.`;

  const agentFor = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-6">
      <div className="mb-6 flex flex-col gap-2.5">
        <h1 className="max-w-[620px] text-[21px] font-medium leading-snug tracking-[-0.02em] text-pretty">
          {headline}
        </h1>
        <div className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground">
          <CheckCircle2 size={14} className="shrink-0 text-primary" />
          <span>
            {working.length} agents working · {open.length} waiting on you
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {filter === 'needs' ? (
          <>
            {actionable &&
              open.map((d) => {
                const agent = agentFor(d.agentId);
                if (!agent) return null;
                return (
                  <DecisionRow
                    key={d.id}
                    decision={d}
                    agent={agent}
                    expanded={expandedId === d.id}
                    onToggle={() => onExpand(expandedId === d.id ? null : d.id)}
                    onOpenAgent={() => onOpenAgent(d.agentId)}
                    onApprove={() => onApprove(d.id)}
                    onDismiss={() => onDismiss(d.id)}
                    onUndo={() => onUndo(d.id)}
                  />
                );
              })}
            {actionable &&
              justResolved.map((d) => {
                const agent = agentFor(d.agentId);
                if (!agent) return null;
                return (
                  <DecisionRow
                    key={d.id}
                    decision={d}
                    agent={agent}
                    expanded={false}
                    onToggle={() => {}}
                    onOpenAgent={() => onOpenAgent(d.agentId)}
                    onApprove={() => onApprove(d.id)}
                    onDismiss={() => onDismiss(d.id)}
                    onUndo={() => onUndo(d.id)}
                  />
                );
              })}
            {open.length === 0 && justResolved.length === 0 && (
              <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
                Nothing needs you right now.
              </div>
            )}
          </>
        ) : working.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
            Nobody is mid-task right now.
          </div>
        ) : (
          working.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpenAgent(a.id)}
              className="flex w-full items-center gap-3 border-b border-rule-soft px-5 py-3.5 text-left last:border-b-0"
            >
              <StateDot state="working" />
              <span className="shrink-0 text-[13px] font-medium">{a.name}</span>
              {/*
                `now` is null until something real produces the activity line
                (AW-8/AW-14). The name and the state dot already say "working";
                a placeholder phrase here would read as a report.
              */}
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                {a.now ?? ''}
              </span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground">
                {a.counter
                  ? `${a.counter.done} of ${a.counter.total} ${a.counter.unit}`
                  : ''}
              </span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground">
                <Elapsed since={a.startedAt} />
              </span>
            </button>
          ))
        )}
      </div>

      <div className="flex items-center gap-3 px-1 pt-3.5 text-[12.5px] text-muted-foreground">
        <span>
          {filter === 'needs'
            ? 'Open a line to see the detail and act on it.'
            : 'Read-only — nothing here asks anything of you.'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSeeActivity}
          className="ml-auto h-7 gap-1.5 text-[12px] text-primary"
        >
          Everything they did
          <ArrowRight size={11} />
        </Button>
      </div>
    </div>
  );
}
