/**
 * The main column of a "Repeat a job" task's page (PR 4; the minimal
 * redesign, 2026-10-29): one Runs card. The page draws the header and the
 * side column (the About list) around it, as for every kind.
 *
 * Above the list, one muted line says what the host sees right now: runs
 * still going (and that they finish after a Pause), app updates waiting their
 * turn, and the job's own warning. It is the card's live region, mounted with
 * it, so a run starting or finishing is said once. While the page's own line
 * is watching a run someone started (`quiet`), this one is shown but not said
 * (`aria-live="off"`): that line says the outcome. Host observations only,
 * never an invented agent report.
 *
 * Each run is one row: its mark (done, off-track or no update for completed,
 * failed or finished quietly, with the word hidden beside it), what it said
 * (or its plain status, or a failure's reason through `runFailureText`), its
 * short time (`RowTime`) and a See what it did link. The newest four show; the rest wait behind
 * "N earlier". An agent-written update and a recorded reason are only ever
 * React text children.
 */
import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { routeLinkProps } from '@/lib/route-link';
import { runFailureText } from '@/lib/task-updates';
import { cn } from '@/lib/utils';
import { updateStamp } from '@/lib/workspace-time';
import type { WorkspaceRoute } from '@/lib/workspace-route';
import type { RepeatTaskState, TaskDetail, TaskUpdate } from '@/lib/workspace-types';
import { StateDot, StateDotSlot } from './bits';
import { IconLink, RowTime } from './task-bits';

/** How many runs show before "N earlier". */
const SHOWN = 4;

const RUN_MARK = { ok: 'done', error: 'off-track', silenced: 'no-update' } as const;
const RUN_WORD: Record<TaskUpdate['status'], string> = {
  ok: 'Completed',
  error: 'Failed',
  silenced: 'Finished quietly',
};

/** The host's live states, one line: runs going, updates waiting, the job's warning. Empty when there's nothing to say. */
export function repeatStatusLine(run: RepeatTaskState | undefined, enabled: boolean): string {
  if (run === undefined) return 'Run details are unavailable.';
  const active = run.active ?? 0;
  const waiting = run.waiting ?? 0;
  const runs = `${active} ${active === 1 ? 'run' : 'runs'} active`;
  return [
    active > 0 ? (enabled ? `Working… ${runs}` : `${runs}, finishing after Pause`) : null,
    waiting > 0 ? `${waiting} ${waiting === 1 ? 'app update' : 'app updates'} waiting` : null,
    run.warning,
  ]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
}

export function RepeatTaskBody({
  detail,
  agentId,
  routineId,
  onNavigate,
  quiet = false,
}: {
  detail: TaskDetail;
  agentId: string;
  routineId: string;
  onNavigate: (route: WorkspaceRoute) => void;
  /** The page's own live line is watching a run (Run now): show this line, don't say it. */
  quiet?: boolean;
}) {
  const headingId = useId();
  const restId = useId();
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const runs = detail.updates;
  const head = runs.slice(0, SHOWN);
  const rest = runs.slice(SHOWN);
  const row = ({ key, update }: { key: string; update: TaskUpdate }) => (
    <RunRow key={key} update={update} agentId={agentId} routineId={routineId} now={now} onNavigate={onNavigate} />
  );
  return (
    <Card>
      <section aria-labelledby={headingId} className="flex flex-col gap-1 p-4">
        <h2 id={headingId} className="sr-only">
          Run history
        </h2>
        <p role="status" aria-live={quiet ? 'off' : undefined} className="text-[13px] text-muted-foreground">
          {repeatStatusLine(detail.repeat, detail.enabled)}
        </p>
        {runs.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="flex flex-col">{keyed(head).map(row)}</ul>
        )}
        {rest.length > 0 && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 self-start px-2 text-[13px] font-normal text-muted-foreground"
              aria-expanded={open}
              aria-controls={restId}
              onClick={() => setOpen((o) => !o)}
            >
              <History data-icon="inline-start" aria-hidden="true" />
              {`${rest.length} earlier`}
            </Button>
            <div id={restId} hidden={!open}>
              {open && <ul className="flex flex-col">{keyed(rest, head).map(row)}</ul>}
            </div>
          </>
        )}
      </section>
    </Card>
  );
}

/**
 * Stable keys for runs: equal concurrent shared-thread results are visually
 * identical, so each takes its ordinal among equals (counting those `before`
 * it), and the other rows keep theirs.
 */
function keyed(runs: TaskUpdate[], before: TaskUpdate[] = []): Array<{ key: string; update: TaskUpdate }> {
  const occurrences = new Map<string, number>();
  for (const update of before) {
    const identity = JSON.stringify(update);
    occurrences.set(identity, (occurrences.get(identity) ?? 0) + 1);
  }
  return runs.map((update) => {
    const identity = JSON.stringify(update);
    const ordinal = occurrences.get(identity) ?? 0;
    occurrences.set(identity, ordinal + 1);
    return { key: `${identity}:${ordinal}`, update };
  });
}

function RunRow({
  update,
  agentId,
  routineId,
  now,
  onNavigate,
}: {
  update: TaskUpdate;
  agentId: string;
  routineId: string;
  now: Date;
  onNavigate: (route: WorkspaceRoute) => void;
}) {
  const word = RUN_WORD[update.status];
  const said =
    update.status === 'error'
      ? runFailureText(update.error, 'run')
      : update.report?.update != null && update.report.update !== ''
        ? update.report.update
        : word;
  const stamp = updateStamp(update.firedAt, now);
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="flex h-6 items-center">
        <StateDotSlot>
          <StateDot state={RUN_MARK[update.status]} />
        </StateDotSlot>
      </span>
      {said !== word && <span className="sr-only">{`${word}:`}</span>}
      {/* A failure's reason is read whole, never clamped; any other run's line is. */}
      <p
        className={cn(
          'min-w-0 flex-1 break-words text-[14px] leading-6',
          update.status === 'error' ? 'whitespace-pre-wrap' : 'line-clamp-2',
        )}
      >
        {said}
      </p>
      <RowTime iso={update.firedAt} now={now} className="pt-0.5 leading-5" />
      {update.conversationId !== null ? (
        <IconLink
          icon={ArrowUpRight}
          label="See what it did"
          {...routeLinkProps(
            { kind: 'task-checkin', agentId, routineId, conversationId: update.conversationId },
            onNavigate,
          )}
        >
          {stamp !== null && <span className="sr-only">, {stamp}</span>}
        </IconLink>
      ) : (
        <span aria-hidden="true" className="size-7 shrink-0" />
      )}
    </li>
  );
}
