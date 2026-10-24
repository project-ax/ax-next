import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { ROUTINE_STEPS_MAX, RoutineStepAuthorSchema, RoutineStepIdSchema, type RoutineStepOp } from '@ax/routines-contract';
import type { StoredStep } from './types.js';

/**
 * TASK-948. One stored step, read leniently. Strip mode, not strict: a later
 * version's extra key is dropped from the step rather than dropping the step,
 * so a rollback below a version that adds a step field keeps every step, losing
 * only the new field on the next write. The id is narrower than the contract's
 * (`RoutineStepIdSchema` bounds only its length): ids are host-made
 * (`newStepId`), so the charset drops only hand edits, and it lets the check-in
 * message print an id as-is, with no way to break a line (decisions row 13).
 * The text is any string, uncapped, as `StoredRoutineSchema` reads a report, so
 * text a later card's higher cap let in still reads after a rollback (TASK-913).
 */
const StoredStepSchema = z.object({
  id: RoutineStepIdSchema.regex(/^[A-Za-z0-9_-]+$/),
  text: z.string(),
  done: z.boolean(),
  addedBy: RoutineStepAuthorSchema,
});

/**
 * TASK-948. A get-done task's checklist as its row holds it (`task_steps`).
 * `rowToRoutine` runs this on every read, `claimDue`'s included, so one odd
 * value (a rollback, a hand edit, a later version) can't stop a read or the
 * tick (TASK-913). Anything but a list reads as no steps. An entry that isn't a
 * whole step is dropped, and so is a later entry with an id already read, so an
 * id names one step. The rest keep their order.
 */
export function storedSteps(value: unknown): StoredStep[] {
  if (!Array.isArray(value)) return [];
  const steps: StoredStep[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const step = StoredStepSchema.safeParse(entry);
    if (!step.success || ids.has(step.data.id)) continue;
    ids.add(step.data.id);
    steps.push(step.data);
  }
  return steps;
}

/** The base-36 characters after a step id's `s`: 36^6, about 2.2 billion ids, for at most 50 on a task. */
const STEP_ID_CHARS = 6;

/**
 * TASK-948. A new step's id: `s` and 6 random lowercase base-36 characters,
 * drawn again until it isn't in `taken`, the task's ids. Short on purpose: the
 * model echoes it to tick the step. `draw` hands out one character as a number
 * from 0 to 35; a test can pass its own.
 */
export function newStepId(taken: ReadonlySet<string>, draw: () => number = () => randomInt(36)): string {
  let id: string;
  do {
    id = 's';
    for (let i = 0; i < STEP_ID_CHARS; i++) id += draw().toString(36);
  } while (taken.has(id));
  return id;
}

/**
 * TASK-948. A report's changes to a get-done task's checklist, applied in order
 * to a copy of `current`, each to the list as the change before it left it, so
 * a `remove` makes room for an `add` after it. Never mutates its input. Each
 * change counts once, as applied or skipped:
 *   - `add` appends `{ id: newId(the ids on the list), text, done, addedBy:
 *     'agent' }`, not done unless the change says so: the host makes the id, so
 *     a report can't tick a step it adds by id. Skipped when the list already
 *     holds `ROUTINE_STEPS_MAX` steps, or a step with exactly this text. Every
 *     other change is idempotent, so this makes a whole report so: one sent
 *     again (the runner's IPC client retries a 503 by running the whole report
 *     again, even after a commit whose answer was lost) or a model re-sending
 *     its whole plan adds nothing twice.
 *   - `tick` and `untick` set `done` on the step with that id, whoever added it.
 *   - `edit` replaces the text of, and `remove` drops, only a step with that id
 *     the agent added, so the agent can't reword or remove the person's words.
 *     `edit` keeps the step's `done` and `addedBy`.
 *   - any other change, one naming an id that isn't on the list included, is
 *     skipped.
 * No change can say who added a step: `add` always writes `'agent'`.
 */
export function applyStepOps(
  current: readonly StoredStep[], ops: readonly RoutineStepOp[], newId: (taken: ReadonlySet<string>) => string = newStepId,
): { steps: StoredStep[]; applied: number; skipped: number } {
  const steps = current.map(step => ({ ...step }));
  let applied = 0;
  for (const op of ops) if (applyStepOp(steps, op, newId)) applied += 1;
  return { steps, applied, skipped: ops.length - applied };
}

/** One change, made on `applyStepOps`' own copy of the list. False when it is skipped. */
function applyStepOp(steps: StoredStep[], op: RoutineStepOp, newId: (taken: ReadonlySet<string>) => string): boolean {
  if (op.op === 'add') {
    if (steps.length >= ROUTINE_STEPS_MAX || steps.some(step => step.text === op.text)) return false;
    steps.push({ id: newId(new Set(steps.map(step => step.id))), text: op.text, done: op.done ?? false, addedBy: 'agent' });
    return true;
  }
  const step = steps.find(candidate => candidate.id === op.id);
  if (step === undefined) return false;
  switch (op.op) {
    case 'tick':
    case 'untick':
      step.done = op.op === 'tick';
      return true;
    case 'edit':
    case 'remove':
      if (step.addedBy !== 'agent') return false;
      if (op.op === 'edit') step.text = op.text;
      else steps.splice(steps.indexOf(step), 1);
      return true;
  }
}
