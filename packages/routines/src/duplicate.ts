import { clampCodeUnits } from '@ax/core';
import { ROUTINE_NAME_MAX_CHARS, ROUTINE_STEPS_MAX } from '@ax/routines-contract';
import { newStepId, storedSteps } from './steps.js';
import type { StoredStep } from './types.js';

/*
 * TASK-953. What a person's copy of their task carries, in one place. A copy is
 * a new task of the same kind, paused, named by `duplicateName`, with the
 * source's definition otherwise (its brief, schedule and active hours) and,
 * for a "get-done" task only, its steps as `copiedSteps` copies them. Nothing
 * else of the source comes along:
 * no report, notes, reading, misses, finish date, replies or runs
 * (`duplicateAuthored`, store.ts). Pure, so it is tested without Postgres.
 */

/** What a copy's name starts with. */
export const DUPLICATE_NAME_PREFIX = 'Copy of ';

/**
 * A copy's name: "Copy of " and the source's name, cut to fit the name limit
 * (`ROUTINE_NAME_MAX_CHARS`, in UTF-16 code units, as the contract counts) and
 * never inside a character (`clampCodeUnits`). A copy of a copy is "Copy of
 * Copy of …", with no special case. It lives here, not in
 * `@ax/routines-contract`, which the SPA bundles and keeps browser-safe:
 * `clampCodeUnits` comes from `@ax/core`'s root, which starts the hook bus's
 * `AsyncLocalStorage` (`node:async_hooks`) at load. The task page reads the
 * copy's name from the host, so nothing outside routines needs it (TASK-953
 * decisions row 2).
 */
export function duplicateName(name: string): string {
  return DUPLICATE_NAME_PREFIX + clampCodeUnits(name, ROUTINE_NAME_MAX_CHARS - DUPLICATE_NAME_PREFIX.length);
}

/**
 * A copy's steps, from the source's `task_steps` as stored: the steps this
 * version reads (`storedSteps`), the first `ROUTINE_STEPS_MAX`, in order, each
 * built field by field as `{ id, text, done: false, addedBy }`. Every new id is
 * drawn against the source's ids and the ids drawn before it, so none repeats
 * either. Entries this version can't read stay behind: no read shows them and
 * no check-in sends them, so copying them would put unseen content in a new
 * task, and leaving them destroys nothing. `addedBy` is kept, because it says
 * who wrote the words: relabelling the agent's steps as the person's would
 * raise agent-written text to theirs, and the person's as the agent's would let
 * the copy's agent reword them. The cap keeps a hand-edited source's copy at
 * 50 too (TASK-953 decisions row 3).
 */
export function copiedSteps(value: unknown, newId: (taken: ReadonlySet<string>) => string = newStepId): StoredStep[] {
  const read = storedSteps(value);
  const taken = new Set(read.map(step => step.id));
  return read.slice(0, ROUTINE_STEPS_MAX).map(step => {
    const id = newId(taken);
    taken.add(id);
    return { id, text: step.text, done: false, addedBy: step.addedBy };
  });
}
