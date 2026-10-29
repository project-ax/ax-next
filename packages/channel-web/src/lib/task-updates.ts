/**
 * task-updates — what the Updates thread shows, and which check-ins it folds
 * into "N earlier check-ins, all on track" (TASK-910, TASK-931).
 *
 * The thread holds a task's check-ins and the person's replies, newest first.
 * A task that checks in every hour writes a dozen "all on track" lines a day.
 * Showing each one buries the lines that matter, so a run of quiet check-ins
 * keeps its newest and folds the rest. Anything else (a failed check-in, one
 * with no report, one that said needs-you or off-track) always stands alone,
 * and so does a reply: it ends a quiet run and is never folded.
 *
 * It also says what an entry says (`updateText`, shared with a check-in's
 * page), which check-in the latest update came from (`latestUpdateCheckIn`,
 * TASK-911), and which check-ins can't be linked to because they share a
 * conversation (`sharedConversationIds`).
 *
 * And it words a failed check-in's reason (`runFailureText`, 2026-10-29): the
 * one place the routines store's own sentences become the page's.
 *
 * Pure, with relative imports only: the server-side wire types live next door.
 */
import type { TaskDetailReport, TaskReply, TaskUpdate } from './workspace-types.js';

/** A fold hides at least this many; a shorter tail stays as single updates. */
export const FOLD_MIN_HIDDEN = 2;

export type TimelineItem =
  | { kind: 'update'; update: TaskUpdate }
  | { kind: 'reply'; reply: TaskReply }
  | { kind: 'fold'; updates: TaskUpdate[] };

function isQuiet(update: TaskUpdate): boolean {
  return update.status !== 'error' && update.report?.status === 'on-track';
}

/** An instant as a number; one `Date.parse` can't read sorts after everything. */
function instant(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Both lists newest first in; one newest-first timeline out. Never mutates its
 * inputs.
 *
 * The lists merge by time. At the same instant the check-in goes above the
 * reply: a reply starts a check-in now, which fires at (or just after) it.
 */
export function foldTimeline(
  updates: readonly TaskUpdate[],
  replies: readonly TaskReply[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  /** The check-in goes first while it is at or after the next reply (or none is left). */
  const updateFirst = (update: TaskUpdate, reply: TaskReply | undefined): boolean =>
    reply === undefined || instant(update.firedAt) >= instant(reply.sentAt);
  let u = 0;
  let r = 0;
  while (u < updates.length || r < replies.length) {
    const update = updates[u];
    const reply = replies[r];
    if (update !== undefined && updateFirst(update, reply)) {
      items.push({ kind: 'update', update });
      u += 1;
      if (!isQuiet(update)) continue;
      // Following consecutive quiet check-ins fold; a reply ends the run.
      let end = u;
      while (end < updates.length) {
        const next = updates[end] as TaskUpdate;
        if (!isQuiet(next) || !updateFirst(next, reply)) break;
        end += 1;
      }
      const tail = updates.slice(u, end);
      if (tail.length >= FOLD_MIN_HIDDEN) {
        items.push({ kind: 'fold', updates: tail });
      } else {
        for (const t of tail) items.push({ kind: 'update', update: t });
      }
      u = end;
    } else if (reply !== undefined) {
      items.push({ kind: 'reply', reply });
      r += 1;
    }
  }
  return items;
}

/**
 * The routines store's own words for a run that a restart cut off
 * (`RUN_INTERRUPTED`) and one that closed before it could start (`RUN_CLOSED`),
 * byte for byte. The wire carries no reason code for a failed run, only its
 * fenced `error` line, so the two known sentences are matched as text. A
 * change to either string in `@ax/routines` makes these read as written again,
 * which is honest, just less plain.
 */
const STORE_INTERRUPTED = 'The routine run was interrupted by a host restart.';
const STORE_CLOSED = 'The routine run closed before it could start.';

export const RUN_INTERRUPTED_TEXT = 'Stopped early because we restarted. It tries again next time.';
export const RUN_FAILED_TEXT = 'Something went wrong, so this check-in didn’t finish.';
export const RUN_NO_REASON_TEXT = 'No reason was recorded.';

/**
 * A failed check-in's (or run's) reason in plain words: the store's two
 * sentences, which speak of routines and hosts, as the page says them; no
 * reason as "No reason was recorded."; any other reason as it was written.
 */
export function runFailureText(error: string | null): string {
  if (error === null) return RUN_NO_REASON_TEXT;
  if (error === STORE_INTERRUPTED) return RUN_INTERRUPTED_TEXT;
  if (error === STORE_CLOSED) return RUN_FAILED_TEXT;
  return error;
}

/**
 * The timeline without the entry the latest card already shows above it, so
 * the check-ins list never repeats it: the newest check-in, wherever it sits
 * (a reply sent since can be above it), when it says what the card says
 * (same status, same words). Anything else stays: a reply, an older check-in
 * that happened to say the same, or a newest check-in that says something
 * else. Never mutates what it was given.
 */
export function withoutLatest(
  items: readonly TimelineItem[],
  task: Pick<TaskDetailReport, 'status' | 'update'> | null,
): TimelineItem[] {
  const at = items.findIndex((item) => item.kind === 'update');
  const newest = items[at];
  if (task === null || newest?.kind !== 'update' || newest.update.report === null) return [...items];
  const { report } = newest.update;
  return report.status === task.status && report.update === task.update
    ? [...items.slice(0, at), ...items.slice(at + 1)]
    : [...items];
}

/** How many check-ins and replies a run of timeline items holds, a fold counting each check-in it hides. */
export function entryCount(items: readonly TimelineItem[]): number {
  return items.reduce((n, item) => n + (item.kind === 'fold' ? item.updates.length : 1), 0);
}

/** What an Updates entry says: the agent's update, or why there isn't one (TASK-910's words, now shared with a check-in's page). */
export function updateText(update: Pick<TaskUpdate, 'status' | 'report'>): string {
  const { report } = update;
  if (report !== null) {
    return report.update === null || report.update === ''
      ? 'It left an update we can’t show.'
      : report.update;
  }
  return update.status === 'error'
    ? 'This check-in didn’t finish.'
    : 'Checked in but didn’t leave an update';
}

/**
 * The conversations more than one check-in in `updates` recorded (TASK-911).
 *
 * A routine that was once a repeat routine with one shared conversation wrote
 * every run into it, so those fires all carry the same `conversationId`. A
 * check-in's page is addressed by that id, and the check-in route answers 404
 * for a conversation more than one of the task's newest 200 check-ins
 * recorded, since no one run's report describes it. A link from any of those
 * entries would open the gone state, so they get no link.
 */
export function sharedConversationIds(updates: readonly TaskUpdate[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { conversationId } of updates) {
    if (conversationId === null) continue;
    if (seen.has(conversationId)) shared.add(conversationId);
    else seen.add(conversationId);
  }
  return shared;
}

/**
 * The check-in the task's latest update came from (TASK-911, decisions row
 * 12), or null.
 *
 * A check-in still running when the page was read has already reported, but it
 * isn't in Updates until it finishes (`finishDispatch` writes the fire row).
 * Without the equality check, the card would open the check-in before it,
 * which said something else. One that repeated the earlier report word for
 * word still links to the earlier check-in, which ended with that same report.
 * The exact signal would be the run's start (`task_report_accepted_at`), which
 * the task view doesn't carry. A check-in whose conversation another one shares
 * gets no link either (`sharedConversationIds` says why).
 */
export function latestUpdateCheckIn(
  task: Pick<TaskDetailReport, 'status' | 'update'> | null,
  updates: readonly TaskUpdate[],
): string | null {
  if (task === null) return null;
  const newest = updates.find((u) => u.report !== null);
  if (newest === undefined || newest.report === null || newest.conversationId === null) return null;
  if (sharedConversationIds(updates).has(newest.conversationId)) return null;
  return newest.report.status === task.status && newest.report.update === task.update
    ? newest.conversationId
    : null;
}

/**
 * The check-in that missed (TASK-930, decisions row 11), or null.
 *
 * `noRecentUpdate.at` is the run's `accepted_at`, which is the fire row's
 * `firedAt`, so the link goes to exactly that entry rather than "the newest",
 * which Updates can't pick reliably (it has no tiebreak). No link when that
 * entry reported, has no conversation, or shares one (`sharedConversationIds`).
 */
export function missCheckIn(
  noRecentUpdate: { at: string } | null,
  updates: readonly TaskUpdate[],
): string | null {
  if (noRecentUpdate === null) return null;
  const entry = updates.find((u) => u.firedAt === noRecentUpdate.at);
  if (entry === undefined || entry.report !== null || entry.conversationId === null) return null;
  return sharedConversationIds(updates).has(entry.conversationId) ? null : entry.conversationId;
}
