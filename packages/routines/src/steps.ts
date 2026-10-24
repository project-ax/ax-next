import { z } from 'zod';
import { RoutineStepAuthorSchema, RoutineStepIdSchema } from '@ax/routines-contract';
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
