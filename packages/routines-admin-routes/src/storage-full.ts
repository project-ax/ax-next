import { PluginError } from '@ax/core';

// ---------------------------------------------------------------------------
// The storage limit saying no to a routine save or delete (TASK-719).
//
// Both routes write through `workspace:apply`, whose `workspace:pre-apply`
// veto the storage limit answers with `code: 'storage-full'`. The `@ax/core`
// apply facade throws that as `PluginError{ code: 'rejected', reasonCode:
// 'storage-full' }`. Before this, it fell into the same `rejected` branch as a
// validator's veto and answered 400 with the veto's OWN message, which is worded
// for the agent that writes files (it names paths and says what to do next), so
// a person saving a routine was handed a sentence they could not act on.
//
// The words live HERE, not imported. This package may import `@ax/core` and
// nothing else, so the channel-web copies of these two sentences
// (`lib/storage-copy.ts`, the browser's fallback when the server's is missing)
// are a restatement, and each side has a test that pins the exact text.
// ---------------------------------------------------------------------------

/**
 * Is this the storage limit saying no to a `workspace:apply`?
 *
 * It is exactly that shape, and nothing that merely resembles it:
 *
 *   - NOT by who vetoed. A veto is `rejected` whichever plugin said it, and
 *     `err.plugin` says nothing reliable about why.
 *   - NOT by what the message says. The message is prose worded for the agent,
 *     and prose is not a contract.
 *   - NOT "any rejected". A validator's veto means "fix what you wrote" (the
 *     400 the routes already answer, with its reason); telling a person "your
 *     storage is full, ask an admin" about it would be a false diagnosis with a
 *     false remedy.
 *   - NOT a duck-typed lookalike: `instanceof` is the check, because only the
 *     core facade mints this error from a veto's code.
 *
 * The same rule as `@ax/channel-web`'s `isStorageFullRefusal`, restated because
 * plugins talk through the bus and share no code.
 */
export function isStorageFullRefusal(err: unknown): boolean {
  return (
    err instanceof PluginError && err.code === 'rejected' && err.reasonCode === 'storage-full'
  );
}

/**
 * `PUT /settings/routines/:agentId`. True because the refusal comes from the
 * pre-apply gate, BEFORE anything is written: the routine was not saved.
 */
export const STORAGE_FULL_ROUTINE_SAVE =
  "We couldn't save that routine because your storage is full. An admin can make more room, then you can try again.";

/**
 * `DELETE /settings/routines/:agentId`. A delete adds no bytes, but the gate
 * refuses any write from someone already over the limit, so a full person
 * cannot remove a routine either. True because the refusal is before anything
 * is written: the routine is still there.
 *
 * It says "remove" about what we could NOT do, and tells nobody to do it:
 * removing a routine does not give space back (the file stays in the history),
 * so advice to delete something would be a false promise.
 */
export const STORAGE_FULL_ROUTINE_REMOVE =
  "We couldn't remove that routine because your storage is full. An admin can make more room, then you can try again.";
