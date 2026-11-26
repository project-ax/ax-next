/**
 * task-row-line — what one Tasks-list row says besides its name (the minimal
 * redesign, 2026-10-29): at most one latest line, and one short right-hand
 * fact with the whole sentence it stands for.
 *
 * The status lives in the row's group, so a row never repeats it. The reading
 * stays on the task page. Pure: relative imports plus the package time formatter.
 */
import { taskGroup } from './task-groups.js';
import { finishByCount } from './task-finish-by.js';
import { AUTO_PAUSED_LINE, missSummary } from './task-miss.js';
import { runFailureText } from './task-updates.js';
import { formatTimestamp } from '@project-ax/ui';
import type { RepeatTaskState, TaskRow } from './workspace-types.js';

/** The claim, said short: the agent's tile beside it says whose claim it is. */
export const CLAIM_LINE = 'Thinks it’s done';

export interface RowLatest {
  text: string;
  /** Agent-written text (an update or an ask), drawn only as React text. */
  agentText: boolean;
  /** The agent's ask, which a needs-you row quotes in the foreground. */
  ask: boolean;
}

export interface RowFact {
  /** A couple of characters: "3h", "2/5 · Oct 31", "Fri". */
  short: string;
  /** The sentence `short` stands for, for screen readers and the tooltip. */
  full: string;
  /** A get-done task past its finish date. */
  late: boolean;
}

/**
 * The row's one latest line, in order: a current claim (only without misses,
 * so missed-check-in wording always wins over an old claim), why an
 * auto-paused task is paused, why it has no recent update, then, for a
 * needs-you row, its ask, else the last update. A done row shows its last
 * update whatever misses it had: it is finished, and that update is what the
 * person accepted. A Repeat job says what its last run did instead.
 */
export function rowLatest(row: TaskRow): RowLatest | null {
  if (row.kind === 'repeat') return { text: repeatLine(row.repeat, row.enabled), agentText: false, ask: false };
  const update = row.task?.update ?? null;
  const said = (text: string | null): RowLatest | null =>
    text === null ? null : { text, agentText: true, ask: false };
  if (row.doneAt !== null) return said(update);
  const miss = row.noRecentUpdate;
  if (miss === null && row.task?.doneClaimed === true) return { text: CLAIM_LINE, agentText: false, ask: false };
  if (!row.enabled && miss?.autoPaused) return { text: AUTO_PAUSED_LINE, agentText: false, ask: false };
  if (miss !== null) return { text: missSummary(miss), agentText: false, ask: false };
  const ask = row.task?.ask ?? null;
  if (ask !== null && taskGroup(row) === 'needs-you') return { text: ask, agentText: true, ask: true };
  return said(update);
}

/** A Repeat job's last run in one line, from host observations only. */
export function repeatLine(run: RepeatTaskState | undefined, enabled: boolean): string {
  if (run === undefined) return 'Run details are unavailable.';
  const active = run.active ?? 0;
  const sentences: string[] = [];
  if (active > 0) sentences.push(enabled ? 'Working.' : 'Finishing after Pause.');
  else if (run.status === 'error') sentences.push('Last run failed.');
  else if (run.status === 'silenced') sentences.push('Last run finished quietly.');
  else if (run.status === 'ok') sentences.push('Last run completed.');
  else sentences.push('No completed runs yet.');
  // The store's own sentences speak of routines and hosts; `runFailureText` says them plainly.
  if (run.status === 'error' && run.error !== null) sentences.push(runFailureText(run.error, 'run'));
  if (run.warning !== null) sentences.push(run.warning);
  const parts = [sentences.join(' ')];
  if (active > 1) parts.push(`${active} runs active`);
  const waiting = run.waiting ?? 0;
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'app update waiting' : 'app updates waiting'}`);
  return parts.join(' · ');
}

/** A finish date (a calendar day, read in UTC so no zone moves it) as "Oct 31". */
function finishDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/**
 * The row's one right-hand fact. Done: when it was marked done. Repeat: the
 * last run's time. Get-done with steps: "2/5", then its finish date. Otherwise
 * when it last checked in ("checked" dates the last miss when present, else
 * the last real report; a task with neither shows no time, since a time on a
 * row is a claim), then a get-done task's finish date. Null when there is
 * nothing to say.
 */
export function rowFact(row: TaskRow, now: Date): RowFact | null {
  if (row.doneAt !== null) {
    const when = formatTimestamp(row.doneAt, { now });
    return { short: when ?? 'Done', full: when === null ? 'Done' : `Done ${when}`, late: false };
  }
  if (row.kind === 'repeat') {
    const at = row.repeat?.lastRunAt ?? null;
    const when = at === null ? null : formatTimestamp(at, { now });
    return when === null ? null : { short: when, full: `Last run ${when}`, late: false };
  }
  const short: string[] = [];
  const full: string[] = [];
  if (row.kind === 'get-done' && row.steps !== null && row.steps.total > 0) {
    short.push(`${row.steps.done}/${row.steps.total}`);
    full.push(`${row.steps.done} of ${row.steps.total} steps`);
  } else {
    const at = row.noRecentUpdate?.at ?? row.task?.reportedAt ?? null;
    const when = at === null ? null : formatTimestamp(at, { now });
    if (when !== null) {
      short.push(when);
      full.push(`checked ${when}`);
    }
  }
  const finishBy = row.kind === 'get-done' ? row.finishBy : null;
  if (finishBy !== null) {
    short.push(finishDay(finishBy.date));
    full.push(finishByCount(finishBy.daysLeft));
  }
  if (short.length === 0) return null;
  const sentence = full.join(' · ');
  return {
    short: short.join(' · '),
    full: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    late: finishBy !== null && finishBy.daysLeft < 0,
  };
}
