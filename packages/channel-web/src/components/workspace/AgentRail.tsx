/**
 * The rail — what it is doing, what it may do alone, and what you have talked
 * about before.
 *
 * "What it may do alone" is the most important block on the surface: an
 * autonomy product lives or dies on whether the human believes they know the
 * blast radius. Every row is generated from the policy record and carries the
 * rule that produced it, so a sentence drifting from the enforced policy shows
 * up rather than lying quietly.
 *
 * "Right now" deliberately has no progress bar and no ETA. See `Elapsed`.
 *
 * There is no "This week" panel. It read a `stats` array the wire no longer
 * carries, and rendering it with zeros would be worse than dropping it: "you
 * overruled it: 0" is a claim, and we are not counting overrules. The panel
 * comes back when the counters do, not before.
 */
import { Card, CardContent } from '@/components/ui/card';
import type { AgentDetail } from '@/lib/workspace-api';
import { Elapsed, PermissionLine, SectionLabel } from './bits';

interface Props {
  detail: AgentDetail;
  openPastId: string | null;
  onOpenPast: (id: string | null) => void;
}

const STATE_WORD: Record<string, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  resting: 'Resting',
  stopped: 'Stopped',
};

export function AgentRail({ detail, openPastId, onOpenPast }: Props) {
  const { agent, permissions, past } = detail;
  /*
    `now` is null until an activity line has a real producer (AW-8/AW-14). A
    null renders as the state word ALONE — no counter row, no em-dash. An
    em-dash where a sentence goes reads as "we know something and are not
    saying"; the truth is that nothing is reporting yet.
  */
  const activity = agent.now;

  return (
    <aside className="w-[296px] shrink-0 overflow-y-auto border-l border-border px-5 pb-6">
      <SectionLabel>Right now</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="text-[13px]">
            {activity ?? STATE_WORD[agent.state] ?? 'Resting'}
          </div>
          {activity !== null && (
            <div className="flex justify-between text-[12px] text-muted-foreground">
              <span>
                {agent.counter
                  ? `${agent.counter.done} of ${agent.counter.total} ${agent.counter.unit}`
                  : ''}
              </span>
              <Elapsed since={agent.startedAt} />
            </div>
          )}
        </CardContent>
      </Card>

      <SectionLabel>What it may do alone</SectionLabel>
      <div className="flex flex-col">
        {/*
          An empty list here must SAY it is empty. Rendering nothing reads as
          "there is nothing to know", when the fact is "it has been granted
          nothing yet" — the same understate-the-reach failure the unmapped-rule
          row exists to prevent, just at the other end of the range.
        */}
        {permissions.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Nothing yet — it can talk to you and nothing else. It will ask before
            it does anything for the first time.
          </p>
        ) : (
          permissions.map((p) => <PermissionLine key={p.sentence} row={p} />)
        )}
      </div>

      <SectionLabel>Previous conversations</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-0.5 p-2">
          {past.length === 0 && (
            <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">
              None yet — this is the first one.
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
    </aside>
  );
}
