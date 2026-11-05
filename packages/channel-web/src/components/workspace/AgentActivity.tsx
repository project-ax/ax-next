import { Card, CardContent } from '@/components/ui/card';
import { useAgentRail } from '@/lib/workspace-rail';
import type { AgentDetail, AgentRailData } from '@/lib/workspace-api';
import { Elapsed, SectionLabel, StateDot, stateWord } from './bits';

/**
 * The side panel's Activity view: what the agent is doing right now, and the
 * week's one honest counter. Moved out of the old Chats tab when chats went to
 * the sidebar; the two blocks below are unchanged.
 */
export function AgentActivity({
  agent,
  busy = false,
}: {
  agent: AgentDetail['agent'];
  busy?: boolean;
}) {
  const { rail, loading, error } = useAgentRail(agent.id, agent.state, busy);
  return (
    <div className="flex flex-col gap-0.5">
      <SectionLabel>Right now</SectionLabel>
      <RightNow agent={agent} rail={rail} loading={loading} error={error} />
      <ThisWeek rail={rail} loading={loading} error={error} />
    </div>
  );
}

/**
 * "Right now" — a phrase, a REAL counter, and how long it has been going.
 *
 * Never a percentage, never an ETA, and never a counter the tool did not report
 * (design H2). When the step stream goes quiet the phrase is REPLACED by the
 * elapsed silence and the counter disappears with it: a hung agent that keeps
 * saying "Reading email" for forty minutes is worse than one that says nothing,
 * and a counter frozen at 29 of 41 is a claim that stopped being true.
 *
 * With no activity to report the line is the state word ALONE — no counter row,
 * no em-dash. An em-dash where a sentence goes reads as "we know something and
 * are not saying"; the truth is that nothing is reporting.
 */
function RightNow({
  agent,
  rail,
  loading,
  error,
}: {
  agent: AgentDetail['agent'];
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  const line = rail?.activity.activity ?? null;
  /*
    The word agrees with the line under it (TASK-818). Both are the same server
    signal (the server calls an agent working exactly when it has an activity
    line), but they are read at different moments, and the rail's read can be
    the newer one: a panel opened mid-turn. "Resting" over "Working on your
    request" is two answers at once; when this card HAS a line, the agent is
    working. Only "resting" yields: waiting and stopped are stronger claims the
    line does not contradict.
  */
  const word =
    agent.state === 'resting' && line !== null ? 'working' : agent.state;
  return (
    <>
      <Card className="rounded-md bg-muted shadow-none">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <StateDot state={word} />
            {stateWord(word)}
          </div>
          <div className="text-[13px]">{line?.phrase ?? ''}</div>
          {line !== null && (
            <div className="flex justify-between text-[12px] text-muted-foreground">
              <span>
                {line.counter
                  ? `${line.counter.done} of ${line.counter.total} ${line.counter.unit}`
                  : ''}
              </span>
              <Elapsed since={line.startedAt} />
            </div>
          )}
          {/*
            A failed read is worth one line here, because the state word above
            it would otherwise pass for an answer. A deployment with no activity
            producer says nothing extra: the state word IS the honest answer
            there, and a notice would be noise on every render forever.
          */}
          {!loading &&
            (error !== null || rail?.activity.status === 'failed') && (
              <p className="text-[11.5px] text-muted-foreground">
                We couldn&apos;t read what it&apos;s doing just now.
              </p>
            )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * "This week" — design §4.4.
 *
 * ONE number ships, and its written definition ships underneath it. The design
 * names three. The other two are ABSENT — not `0`, not an em-dash, not a
 * tooltip admitting we don't know — because nothing produces either one, and
 * the next person to notice the gap should find this note rather than close it
 * with a zero:
 *
 *   - *Handled on its own* — allow-verdict tool calls — would need a
 *     `tool:pre-call` rollup. The hook fires and has two subscribers, and
 *     neither leaves anything to roll up for THESE calls: `@ax/decisions`
 *     returns without writing a row the moment the verdict is `allow` (that is
 *     the point — an allowed call is not a decision), and `@ax/agent-activity`
 *     keeps one in-memory snapshot of the call in flight and deletes it at
 *     `chat:end`. A call the agent handled alone leaves no trace, so the number
 *     would be invented.
 *   - *You overruled it* would need an undo trace in `@ax/decisions`.
 *     `decisions:undo` restores the row to `pending` and clears `resolved_at`,
 *     so an override leaves no record at all. Its zero would not be a true
 *     number that happens to be small — it would be unfalsifiable, which is
 *     the worse of the two failures: "you have never overruled me" is a
 *     statement about someone's own history, made from a read that could not
 *     have found out either way.
 *
 * Building either producer was considered and declined (TASK-265). An undo
 * trace means durably recording that a person changed their mind — a schema
 * change and a privacy question — and that trade should be made deliberately,
 * not as a side effect of filling in a rail. The layout gap is the honest cost.
 *
 * This component renders whatever counter rows it is handed, so the pin that
 * both stay absent lives with their producer: see `readCounters` and
 * `__tests__/server/routes-workspace-rail.test.ts`.
 *
 * The whole block disappears when there is no number to show, rather than
 * standing there empty. A heading over nothing is a promise the surface is not
 * keeping.
 */
function ThisWeek({
  rail,
  loading,
  error,
}: {
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  if (rail === null || loading) return null;
  const { status, rows } = rail.counters;
  if (error !== null || status !== 'ok' || rows.length === 0) return null;
  return (
    <>
      <SectionLabel>This week</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2.5 p-3.5">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px]">{row.label}</span>
                <span className="text-[13px] tabular-nums">{row.value}</span>
              </div>
              {/*
                The definition is rendered, not tucked into a tooltip. This is
                the number a person will quote at somebody, and a number whose
                meaning is one hover away is a number whose meaning drifts.
              */}
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {row.definition}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
