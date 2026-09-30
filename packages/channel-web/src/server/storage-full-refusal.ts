import { PluginError } from '@ax/core';

/**
 * Is this the storage limit saying no to a `workspace:apply`? (TASK-719)
 *
 * disk-quota vetoes `workspace:pre-apply` with `code: 'storage-full'`, and the
 * `@ax/core` apply facade throws that as `PluginError{ code: 'rejected',
 * reasonCode: 'storage-full' }`. This is the ONE test for it, so the routes that
 * turn it into `413 { error: 'storage-full', message }` cannot each grow a
 * slightly different idea of what a full disk looks like.
 *
 * It is exactly that shape, and nothing that merely resembles it:
 *
 *   - NOT by who vetoed. A veto is `rejected` whichever plugin said it (a
 *     validator, a policy, the quota), and a plugin can be renamed or a second
 *     one can also refuse for storage; `err.plugin` says nothing reliable.
 *   - NOT by what the message says. The message is prose worded for the agent
 *     that writes files, and prose is not a contract.
 *   - NOT "any rejected". A validator's veto means "fix what you wrote", and
 *     telling a person "your storage is full, ask an admin" about it would be a
 *     false diagnosis with a false remedy.
 *   - NOT a bare `Rejection` object from a direct subscriber, and NOT a
 *     duck-typed lookalike: `instanceof` is the check, because only the core
 *     facade mints this error from a veto's code.
 *
 * The sentence a person reads is the ROUTE's, fixed (`lib/storage-full-copy`).
 * The veto's own message is never sent: it is for the agent.
 */
export function isStorageFullRefusal(err: unknown): boolean {
  return (
    err instanceof PluginError && err.code === 'rejected' && err.reasonCode === 'storage-full'
  );
}
