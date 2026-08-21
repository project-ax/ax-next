/**
 * Today — the queue of things waiting on a human, and nothing else.
 *
 * Two deliberate departures from the design this came from:
 *
 *   1. The headline is TEMPLATED FROM COUNTS, never generated prose. "Nothing
 *      has gone wrong" being wrong once ends the relationship, so the only
 *      claims made here are ones derived directly from rows that were counted.
 *
 *   2. There is no "Done" filter. Done was a third renderer over the same event
 *      stream that Activity already owns; the reassurance it carried lives in
 *      the sub-line instead, and the footer links to the real feed. The filter
 *      pod also now counts one kind of thing per segment rather than mixing
 *      decisions, agents, and events.
 */
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
  onFilter: (f: 'needs' | 'working') => void;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  onOpenAgent: (id: string) => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  onRestart: (agentId: string) => void;
  onSeeActivity: () => void;
}

export function TodayView({
  decisions,
  agents,
  filter,
  onFilter,
  expandedId,
  onExpand,
  onOpenAgent,
  onApprove,
  onDismiss,
  onUndo,
  onRestart,
  onSeeActivity,
}: Props) {
  const open = decisions.filter(
    (d) => d.status === 'pending' || d.status === 'stale',
  );
  const justResolved = decisions.filter(
    (d) =>
      (d.status === 'executed' || d.status === 'dismissed') &&
      d.resolvedAt !== null &&
      Date.now() - Date.parse(d.resolvedAt) < 60_000,
  );
  const stopped = agents.filter((a) => a.state === 'stopped');
  const working = agents.filter((a) => a.state === 'working' && !a.paused);
  const needsCount = open.length + stopped.length;

  const headline =
    stopped.length > 0
      ? `${stopped[0]!.name} has stopped${open.length ? `, and ${open.length === 1 ? 'one decision is' : `${open.length} decisions are`} waiting` : ' and needs you'}.`
      : open.length === 0
        ? 'Nothing is waiting on you.'
        : `${WORDS[open.length] ?? `${open.length} decisions`} ${open.length === 1 ? 'is' : 'are'} waiting on you.`;

  const agentFor = (id: string) => agents.find((a) => a.id === id)!;

  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-6">
      <div className="mb-6 flex flex-col gap-2.5">
        <h1 className="max-w-[620px] text-[21px] font-medium leading-snug tracking-[-0.02em] text-pretty">
          {headline}
        </h1>
        {stopped.length > 0 ? (
          <div className="flex max-w-[620px] items-start gap-2.5 rounded-md bg-destructive-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed">
            <AlertTriangle
              size={14}
              className="mt-[3px] shrink-0 text-destructive"
            />
            <span>
              {stopped[0]!.stoppedReason} Everything else is fine —{' '}
              {working.length} agents still working.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 text-[13.5px] text-muted-foreground">
            <CheckCircle2 size={14} className="shrink-0 text-primary" />
            <span>
              {working.length} agents working · {open.length} waiting on you
            </span>
          </div>
        )}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && onFilter(v as 'needs' | 'working')}
          className="rounded-lg bg-muted p-[3px]"
        >
          <ToggleGroupItem value="needs" className="h-7 px-3 text-[12px]">
            Needs you {needsCount}
          </ToggleGroupItem>
          <ToggleGroupItem value="working" className="h-7 px-3 text-[12px]">
            Working {working.length}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {filter === 'needs' ? (
          <>
            {stopped.map((a) => (
              <StoppedAgentRow
                key={a.id}
                agent={a}
                expanded={expandedId === `agent:${a.id}`}
                onToggle={() =>
                  onExpand(expandedId === `agent:${a.id}` ? null : `agent:${a.id}`)
                }
                onOpenAgent={() => onOpenAgent(a.id)}
                onRestart={() => onRestart(a.id)}
              />
            ))}
            {open.map((d) => (
              <DecisionRow
                key={d.id}
                decision={d}
                agent={agentFor(d.agentId)}
                expanded={expandedId === d.id}
                onToggle={() => onExpand(expandedId === d.id ? null : d.id)}
                onOpenAgent={() => onOpenAgent(d.agentId)}
                onApprove={() => onApprove(d.id)}
                onDismiss={() => onDismiss(d.id)}
                onUndo={() => onUndo(d.id)}
              />
            ))}
            {justResolved.map((d) => (
              <DecisionRow
                key={d.id}
                decision={d}
                agent={agentFor(d.agentId)}
                expanded={false}
                onToggle={() => {}}
                onOpenAgent={() => onOpenAgent(d.agentId)}
                onApprove={() => {}}
                onDismiss={() => {}}
                onUndo={() => onUndo(d.id)}
              />
            ))}
            {needsCount === 0 && justResolved.length === 0 && (
              <div className="px-5 py-10 text-center text-[13.5px] text-muted-foreground">
                Nothing needs you. Your agents keep working.
              </div>
            )}
          </>
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
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                {a.now}
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

/**
 * A halted agent is not a decision — there is no proposed call to approve — but
 * it belongs at the top of the same queue, because from the user's side it is
 * the same question: something stopped and wants an answer.
 */
function StoppedAgentRow({
  agent,
  expanded,
  onToggle,
  onOpenAgent,
  onRestart,
}: {
  agent: WorkspaceAgent;
  expanded: boolean;
  onToggle: () => void;
  onOpenAgent: () => void;
  onRestart: () => void;
}) {
  return (
    <div className="border-b border-rule-soft bg-destructive-soft/50 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left"
      >
        <StateDot state="stopped" />
        <span className="shrink-0 text-[13px] font-medium">{agent.name}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-destructive">
          Stopped — two nudges were rejected by the mail server
        </span>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">
          9:12 AM
        </span>
      </button>
      {expanded && (
        <div className="px-5 pb-5 pl-[46px]">
          <p className="max-w-[660px] text-[13.5px] leading-relaxed text-muted-foreground">
            I tried to send the nudges to Legal and Sam twice. The mail server
            refused both times, so I stopped rather than keep retrying. Nothing
            else in my queue has run since.
          </p>
          <div className="mt-3 max-w-[660px] rounded-md bg-muted px-4 py-3.5">
            <div className="mb-1.5 text-[11.5px] text-muted-foreground">
              Error returned to {agent.name} · 9:12 AM and 9:14 AM
            </div>
            <div className="font-mono text-[12px]">
              550 5.7.1 Relay access denied — smtp.northwind.co
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onRestart}>
              Retry now
            </Button>
            <Button size="sm" variant="ghost" onClick={onOpenAgent}>
              Leave it stopped
            </Button>
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
