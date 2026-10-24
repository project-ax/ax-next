import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { ROUTINE_STEPS_MAX, RoutineStepAuthorSchema, RoutineStepIdSchema, type RoutineStepAuthor, type RoutineStepOp } from '@ax/routines-contract';
import type { StoredStep } from './types.js';

/**
 * TASK-948. One stored step, read leniently. Strip mode, not strict: a later
 * version's extra key is dropped from the step rather than dropping the step,
 * so a rollback below a version that adds a step field keeps every step, losing
 * only the new field on the next write. An entry this schema refuses (a later
 * version's author, say) is kept by both writers (`changeStoredSteps`,
 * TASK-949), so its step survives a write made during a rollback. The id is
 * narrower than the contract's (`RoutineStepIdSchema` bounds only its length):
 * ids are host-made (`newStepId`), so the charset drops only hand edits, and it
 * lets the check-in message print an id as-is, with no way to break a line
 * (decisions row 13). The text is any string, uncapped, as `StoredRoutineSchema`
 * reads a report, so text a later card's higher cap let in still reads after a
 * rollback (TASK-913).
 */
const StoredStepSchema = z.object({
  id: RoutineStepIdSchema.regex(/^[A-Za-z0-9_-]+$/),
  text: z.string(),
  done: z.boolean(),
  addedBy: RoutineStepAuthorSchema,
});

/**
 * TASK-949. A get-done task's checklist as its row holds it (`task_steps`),
 * split into the steps this version reads and the entries it can't, each in
 * their order. An entry that isn't a whole step goes to `unread`; a later
 * entry with an id already read is dropped, so an id names one step, and
 * removing a step can't bring back a duplicate no read ever showed. Null when
 * the value isn't a list.
 */
export function readStoredSteps(value: unknown): { steps: StoredStep[]; unread: unknown[] } | null {
  if (!Array.isArray(value)) return null;
  const steps: StoredStep[] = [];
  const unread: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const step = StoredStepSchema.safeParse(entry);
    if (!step.success) {
      unread.push(entry);
    } else if (!ids.has(step.data.id)) {
      ids.add(step.data.id);
      steps.push(step.data);
    }
  }
  return { steps, unread };
}

/**
 * TASK-948. A get-done task's checklist as a read shows it: the steps
 * `readStoredSteps` reads, in order, and no steps when the value isn't a list.
 * `rowToRoutine` runs this on every read, `claimDue`'s included, so one odd
 * value (a rollback, a hand edit, a later version) can't stop a read or the
 * tick (TASK-913).
 */
export function storedSteps(value: unknown): StoredStep[] {
  return readStoredSteps(value)?.steps ?? [];
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
 * TASK-948. Changes to a get-done task's checklist, made by `actor` (TASK-949),
 * applied in order to a copy of `current`, each to the list as the change
 * before it left it, so a `remove` makes room for an `add` after it. Never
 * mutates its input. Each change counts once, as applied or skipped:
 *   - `add` appends `{ id: newId(the ids on the list), text, done, addedBy:
 *     actor }`, not done unless the change says so: the host makes the id, so
 *     a change can't tick a step it adds by id. Skipped when the list already
 *     holds `ROUTINE_STEPS_MAX` steps, or a step with exactly this text, for
 *     either actor. Every other change is idempotent, so this makes a whole
 *     list of changes so: a report sent again (the runner's IPC client retries
 *     a 503 by running the whole report again, even after a commit whose
 *     answer was lost) or a model re-sending its whole plan adds nothing twice.
 *   - `tick` and `untick` set `done` on the step with that id, whoever added
 *     it, and leave who added it as it was.
 *   - `edit` replaces the text of, and `remove` drops, the step with that id.
 *     The agent may only touch a step it added, so it can't reword or remove
 *     the person's words; the person may touch any step (TASK-949). `edit`
 *     keeps the step's `done`. A person's edit that changes the text makes the
 *     step theirs (`addedBy: 'person'`), so the agent can then only tick it;
 *     one that leaves the text as it is changes nothing. The agent's edit keeps
 *     `addedBy`.
 *   - any other change, one naming an id that isn't on the list included, is
 *     skipped.
 * No change can say who added a step: the actor says, and the caller sets it.
 * Only the exact `'person'` gets the person's reach; any other value gets the
 * agent's, the narrower one, and its `add` is the agent's.
 */
export function applyStepOps(
  current: readonly StoredStep[], ops: readonly RoutineStepOp[], actor: RoutineStepAuthor,
  newId: (taken: ReadonlySet<string>) => string = newStepId,
): { steps: StoredStep[]; applied: number; skipped: number } {
  const steps = current.map(step => ({ ...step }));
  let applied = 0;
  for (const op of ops) if (applyStepOp(steps, op, actor, newId)) applied += 1;
  return { steps, applied, skipped: ops.length - applied };
}

/** One change, made on `applyStepOps`' own copy of the list. False when it is skipped. */
function applyStepOp(steps: StoredStep[], op: RoutineStepOp, actor: RoutineStepAuthor, newId: (taken: ReadonlySet<string>) => string): boolean {
  if (op.op === 'add') {
    if (steps.length >= ROUTINE_STEPS_MAX || steps.some(step => step.text === op.text)) return false;
    // The author is the actor's, failing toward the agent.
    steps.push({ id: newId(new Set(steps.map(step => step.id))), text: op.text, done: op.done ?? false, addedBy: actor === 'person' ? 'person' : 'agent' });
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
      // Only the exact 'person' may touch a step the agent didn't add.
      if (actor !== 'person' && step.addedBy !== 'agent') return false;
      if (op.op === 'remove') {
        steps.splice(steps.indexOf(step), 1);
        return true;
      }
      // A person's words make the step theirs; an edit that changes nothing relabels nothing.
      if (op.text !== step.text) {
        step.text = op.text;
        if (actor === 'person') step.addedBy = 'person';
      }
      return true;
  }
}

/**
 * TASK-949. A change to a checklist as a writer stores it: the steps after it
 * and its counts, as `applyStepOps` answers them, and `write`, what to store,
 * or null to store nothing.
 */
export type StepsChange = { steps: StoredStep[]; applied: number; skipped: number; write: unknown[] | null };

/**
 * TASK-949. Changes, made by `actor`, to a get-done task's checklist as its row
 * holds it (`task_steps`). Both of its writers go through this: `recordReport`
 * as the agent and `setSteps` as the person. The changes apply to the steps
 * `readStoredSteps` reads (`applyStepOps`). When any applied, `write` is those
 * steps, as changed, then every entry this version can't read, in their order,
 * so a later version's step survives a write made during a rollback; when none
 * did, it is null and nothing is written. A new step's id is drawn against the
 * kept entries' ids too: a later version reads first-wins, so a new step that
 * took a kept entry's id would hide it there. A value that isn't a list can't
 * keep steps beside it, so every change to it is skipped. Never mutates its
 * input.
 */
export function changeStoredSteps(
  value: unknown, ops: readonly RoutineStepOp[], actor: RoutineStepAuthor,
  newId: (taken: ReadonlySet<string>) => string = newStepId,
): StepsChange {
  const read = readStoredSteps(value);
  if (read === null) return { steps: [], applied: 0, skipped: ops.length, write: null };
  const keptIds = read.unread.flatMap(entry =>
    (typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' ? [entry.id] : []));
  const changes = applyStepOps(read.steps, ops, actor, taken => newId(new Set([...taken, ...keptIds])));
  return { ...changes, write: changes.applied > 0 ? [...changes.steps, ...read.unread] : null };
}
