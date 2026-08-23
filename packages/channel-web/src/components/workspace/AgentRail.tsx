/**
 * The rail — what it is doing, what it may do alone, what you granted it, this
 * week's numbers, and what you have talked about before.
 *
 * EVERY SENTENCE HERE COMES FROM SOMETHING THAT ENFORCES IT, COUNTS IT, OR
 * OBSERVED IT. There are no fixture strings left. The permission rows are
 * generated from the policy record and carry the rule that produced them, so a
 * sentence drifting from the enforced policy shows up rather than lying
 * quietly; the "Right now" line comes from the tool manifests the runner
 * actually calls; the counter is an integer out of the decision store with its
 * written definition printed underneath it.
 *
 * THREE RULES THIS FILE IS BUILT AROUND.
 *
 * 1. An empty list is a CLAIM. So every block distinguishes "there is nothing"
 *    from "this deployment has no producer" from "we could not read it", and
 *    says which. A bare empty state on a security surface is the bug.
 *
 * 2. Understating reach is worse than overstating it (design H4). A capability
 *    we cannot describe is rendered mechanically and explicitly, never omitted,
 *    because a row that is not there reads as "it cannot do that". Same reason
 *    the unrestricted-scope note exists: an agent with no tool allow-list can
 *    reach whatever this deployment installs, and a tidy list of eleven rows
 *    would read as a leash it does not have.
 *
 * 3. "Right now" has no progress bar and no ETA. See `Elapsed`.
 *
 * The rail reads its own route rather than riding on the agent detail: it is
 * separately refreshable, which is what makes a Revoke button able to show its
 * own consequence.
 */
import { Fragment, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useAgentRail } from '@/lib/workspace-rail';
import type {
  AgentRailData,
  AgentDetail,
  GrantRow,
  WorkspaceReadStatus,
} from '@/lib/workspace-api';
import { Elapsed, GrantLine, PermissionLine, SectionLabel } from './bits';

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

/** One muted line. The only thing a block says when it has nothing to show. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>
  );
}

/**
 * What a block says when its read did not come back.
 *
 * Two different sentences for two different facts, because a reader can act on
 * the difference: nothing to read from, versus something that would not answer.
 * Neither is ever rendered as an empty list.
 */
function ReadFailure({ status, what }: { status: WorkspaceReadStatus; what: string }) {
  if (status === 'unavailable') {
    return <Note>This deployment doesn&apos;t keep {what}, so there&apos;s nothing to show.</Note>;
  }
  return (
    <Note>
      We couldn&apos;t read {what} just now. Treat this as unknown rather than
      empty, and try reloading.
    </Note>
  );
}

export function AgentRail({ detail, openPastId, onOpenPast }: Props) {
  const { agent, past } = detail;
  const { rail, loading, error, revoke } = useAgentRail(agent.id);
  /** The grant rows with a POST in flight, plus whatever the last one said. */
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  async function onRevoke(row: GrantRow): Promise<void> {
    setNotice(null);
    setRevoking((prev) => new Set(prev).add(row.source));
    const outcome = await revoke(row.ref);
    setRevoking((prev) => {
      const next = new Set(prev);
      next.delete(row.source);
      return next;
    });
    /*
      Three outcomes, three sentences. "Already gone" is a refusal, not a
      failure, and saying "revoked" for it would claim we did something we did
      not.

      The success line carries a caveat because the caveat is TRUE: a site
      grant is loaded into the egress allowlist when a session opens
      (`orchestrator.ts` reads `host-grants:list` there), so a conversation
      that is already running keeps what it was given until it ends. "Revoked"
      on its own would let someone believe they had just stopped something
      mid-flight. "May" covers both cases without overstating either.
    */
    if (outcome === 'revoked') {
      setNotice(
        'Revoked. Anything already running may still have it until it finishes.',
      );
    }
    if (outcome === 'already-gone') setNotice('That one was already gone.');
    if (outcome === 'failed') {
      setNotice("We couldn't take that back just now. Nothing changed.");
    }
  }

  return (
    <aside className="w-[296px] shrink-0 overflow-y-auto border-l border-border px-5 pb-6">
      <RightNow agent={agent} rail={rail} loading={loading} error={error} />

      <SectionLabel>What it may do alone</SectionLabel>
      <Permissions name={agent.name} rail={rail} loading={loading} error={error} />

      <SectionLabel>Granted by you</SectionLabel>
      <Grants
        rail={rail}
        loading={loading}
        revoking={revoking}
        notice={notice}
        onRevoke={onRevoke}
      />

      <ThisWeek rail={rail} loading={loading} error={error} />

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
  return (
    <>
      <SectionLabel>Right now</SectionLabel>
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="text-[13px]">
            {line?.phrase ?? STATE_WORD[agent.state] ?? 'Resting'}
          </div>
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
          {!loading && (error !== null || rail?.activity.status === 'failed') && (
            <p className="text-[11.5px] text-muted-foreground">
              We couldn&apos;t read what it&apos;s doing just now.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** The security claim. See the file header for the three rules it obeys. */
function Permissions({
  name,
  rail,
  loading,
  error,
}: {
  name: string;
  rail: AgentRailData | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading && rail === null) {
    return <Note>Reading what {name} may do…</Note>;
  }
  if (rail === null) {
    return (
      <Note>
        {error === null
          ? 'We can’t show this yet.'
          : 'We couldn’t read this just now.'}{' '}
        Until it loads, treat what {name} may do as unknown rather than empty.
      </Note>
    );
  }
  const { status, rows, incomplete, unrestrictedTools } = rail.permissions;
  if (status !== 'ok') {
    return (
      <Note>
        {status === 'unavailable'
          ? `This deployment doesn’t publish the rules that govern ${name}.`
          : `We couldn’t read the rules that govern ${name} just now.`}{' '}
        Treat this as unknown rather than empty — an agent with no list shown is
        not an agent with no reach.
      </Note>
    );
  }
  return (
    <div className="flex flex-col">
      {rows.length === 0 && (
        <Note>
          Nothing here describes {name}&apos;s reach yet. That means we
          can&apos;t tell you — not that there isn&apos;t any.
        </Note>
      )}
      {/*
        The index rides in the key on purpose. `source` is unique per producer,
        but it is FENCED on the way out — two very long ids can truncate to the
        same 60 characters — and a duplicate key here would silently drop a
        permission row. This list is replaced wholesale on every read, so there
        is no reorder for the index to spoil.
      */}
      {rows.map((row, i) => (
        <Fragment key={`${row.source}#${String(i)}`}>
          {/*
            A rule from the group above ends here. Twenty rows separated only by
            a small coloured glyph is a list nobody scans; a hairline between
            "can", "asks first" and "never" makes the three blocks findable
            without adding three headings that repeat what each row already says.
          */}
          {i > 0 && rows[i - 1]?.verdict !== row.verdict && (
            <Separator className="my-2" />
          )}
          <PermissionLine row={row} />
        </Fragment>
      ))}
      {unrestrictedTools && (
        <Alert className="mt-3">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>
            Nothing limits which tools {name} can use — it can reach anything
            installed here, now or later. The list above is what&apos;s
            installed today, not a boundary.
          </AlertDescription>
        </Alert>
      )}
      {incomplete && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          One of the places we look didn&apos;t answer, so this list may be
          missing something. It is not a complete list of what {name} cannot do.
        </p>
      )}
    </div>
  );
}

/**
 * "Granted by you" — the group a person can act on, and the one they are most
 * likely to have forgotten they created (design §4.3.4).
 */
/*
  No `error` prop any more (TASK-288). It existed only to glue the raw thrown
  message into the sentence below; `rail === null && !loading` already says
  everything this group can act on, and the cause is a console line now.
*/
function Grants({
  rail,
  loading,
  revoking,
  notice,
  onRevoke,
}: {
  rail: AgentRailData | null;
  loading: boolean;
  revoking: ReadonlySet<string>;
  notice: string | null;
  onRevoke: (row: GrantRow) => void;
}) {
  if (rail === null) {
    if (loading) return <Note>Reading what you&apos;ve granted…</Note>;
    return (
      <Note>
        {/*
          The raw detail used to ride in a parenthetical here — `We couldn't
          read this just now (workspace /agents/ag_… → 401).` A request path
          inside a sentence is the one shape a grep for a raw status never
          finds. `workspace-rail.ts` logs it now (TASK-288).
        */}
        We couldn&apos;t read this just now.
      </Note>
    );
  }
  const { status, rows, incomplete } = rail.grants;
  if (status !== 'ok') {
    return <ReadFailure status={status} what="a record of what you've granted" />;
  }
  return (
    <div className="flex flex-col">
      {rows.length === 0 && (
        <Note>Nothing yet — you haven&apos;t granted anything beyond the rules above.</Note>
      )}
      {rows.map((row, i) => (
        <GrantLine
          key={`${row.source}#${String(i)}`}
          row={row}
          busy={revoking.has(row.source)}
          onRevoke={onRevoke}
        />
      ))}
      {incomplete && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          One of the places we look didn&apos;t answer, so there may be more
          than this.
        </p>
      )}
      {notice !== null && (
        <p className="mt-2 text-[11.5px] text-muted-foreground">{notice}</p>
      )}
    </div>
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
