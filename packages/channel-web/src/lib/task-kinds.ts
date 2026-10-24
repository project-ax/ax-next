/**
 * task-kinds — what a task's kind is called, and how one off the wire is read
 * (TASK-948).
 *
 * The kinds are the routines contract's own `TASK_KINDS`, never a copy here
 * (invariant 4): a kind the contract adds fails the build until it has a
 * label below. A kind channel-web doesn't know (a newer routines plugin)
 * reads as `'stay-on-top'`, the kind that never finishes, so the page never
 * offers a finish line the task doesn't have.
 *
 * Pure. The server reads it (`server/routes-workspace.ts`), so any sibling it
 * ever imports is relative, with `.js`: the `@/` alias the client components
 * use survives tsc unrewritten in `dist/`, and the built server would fail to
 * import it.
 */
import { isTaskKind, type TaskKind } from '@ax/routines-contract';

/** What each kind of task is called, in the words a person reads. */
export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  'stay-on-top': 'Stay on top of something',
  'get-done': 'Get something done',
};

/** A kind channel-web doesn't know reads as 'stay-on-top', the never-finishing default. */
export function toTaskKind(kind: unknown): TaskKind {
  return typeof kind === 'string' && isTaskKind(kind) ? kind : 'stay-on-top';
}
