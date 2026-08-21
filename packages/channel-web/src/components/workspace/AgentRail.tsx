/**
 * The rail — what it is doing, what it may do alone, how it has behaved, and
 * what you have talked about before.
 *
 * "What it may do alone" is the most important block on the surface: an
 * autonomy product lives or dies on whether the human believes they know the
 * blast radius. Every row is generated from the policy record and carries the
 * rule that produced it, so a sentence drifting from the enforced policy shows
 * up rather than lying quietly.
 *
 * "Right now" deliberately has no progress bar and no ETA. See `Elapsed`.
 */
import { Card, CardContent } from '@/components/ui/card';
import type { AgentDetail } from '@/lib/workspace-api';
import { Elapsed, PermissionLine, SectionLabel } from './bits';

interface Props {
  detail: AgentDetail;
  openPastId: string | null;
  onOpenPast: (id: string | null) => void;
}

export function AgentRail({ detail, openPastId, onOpenPast }: Props) {
  const { agent, permissions, stats, past } = detail;

  return (
    <aside className="w-[296px] shrink-0 overflow-y-auto border-l border-border px-5 pb-6">
      <SectionLabel>Right now</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="text-[13px]">{agent.now}</div>
          <div className="flex justify-between text-[12px] text-muted-foreground">
            <span>
              {agent.counter
                ? `${agent.counter.done} of ${agent.counter.total} ${agent.counter.unit}`
                : agent.state === 'resting'
                  ? 'nothing queued'
                  : '—'}
            </span>
            <Elapsed since={agent.startedAt} />
          </div>
        </CardContent>
      </Card>

      <SectionLabel>What it may do alone</SectionLabel>
      <div className="flex flex-col">
        {permissions.map((p) => (
          <PermissionLine key={p.sentence} row={p} />
        ))}
      </div>

      <SectionLabel>This week</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2 p-3.5">
          {stats.map((s) => (
            <div
              key={s.label}
              className="flex justify-between text-[13px] text-muted-foreground"
            >
              {s.label}
              <span className="font-medium text-foreground">{s.value}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <SectionLabel>Previous conversations</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-0.5 p-2">
          {past.length === 0 && (
            <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">
              None yet.
            </span>
          )}
          {past.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenPast(openPastId === c.id ? null : c.id)}
              className={
                openPastId === c.id
                  ? 'truncate rounded-md bg-primary-soft px-2 py-1.5 text-left text-[12.5px] text-primary'
                  : 'truncate rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-muted'
              }
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </CardContent>
      </Card>

      <p className="mt-5 rounded-lg bg-muted px-3.5 py-3 text-[12px] leading-relaxed text-muted-foreground">
        {agent.footer}
      </p>
    </aside>
  );
}
