/**
 * The rail — what it is doing, what it may do alone, and what you have talked
 * about before.
 *
 * "What it may do alone" is the most important block on the surface: an
 * autonomy product lives or dies on whether the human believes they know the
 * blast radius. Every row is generated from the policy record and carries the
 * rule that produced it, so a sentence drifting from the enforced policy shows
 * up rather than lying quietly. Until that generator exists (AW-14) the block
 * says it cannot show the policy — it never describes the agent's reach from
 * an empty array, in either direction.
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
          An empty list describes THE ABSENCE OF THE VIEW, never the agent's
          reach.

          This block used to say "Nothing yet — it can talk to you and nothing
          else. It will ask before it does anything for the first time." Both
          halves were false. A default agent is bootstrapped with the wildcard
          tool scope plus web tools, connectors and egress grants, so it can do
          a great deal more than talk; and the ask-before-acting behaviour (the
          `hold` verdict and the approvals substrate behind it) has not been
          built. Understating blast radius is the dangerous direction to be
          wrong in — the honest answer to "what may it do alone?" while the
          policy rail is unbuilt (AW-14) is "we can't tell you yet".
        */}
        {permissions.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            We can&apos;t show this yet. When it&apos;s ready, this list will
            say exactly what {agent.name} may do on its own — generated from the
            rules that actually enforce it, so the two can&apos;t drift. Until
            then, treat this as unknown rather than empty.
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
