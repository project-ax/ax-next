/**
 * A half-typed grant value, kept alive across the row's own component lifetime
 * (TASK-389).
 *
 * WHY THIS EXISTS. `GrantRow`'s typed-but-unsubmitted slot values used to live in
 * `useState`, which is scoped to the component instance. Both render sites —
 * `TodayView` (every open grant) and `AgentConversation` (only the grants presence
 * routes to the visible, currently-open thread — see `workspace-grant-presence.ts`)
 * unmount the row under ordinary use: a tab switch drops `visible` false, a route
 * change (switching agents, or leaving the chat tab) drops the row out of
 * `threadGrants()`'s filtered array. Either one throws the typed value away with no
 * warning, mid-paste.
 *
 * WHY A SEPARATE MODULE AND NOT A FIELD ON `WorkspaceGrant`. This is not a second
 * copy of the grant (invariant 4 — one source of truth per concept). The grant
 * itself — its `request`, its origin — still has exactly one owner,
 * `workspace-grant-store.ts`. This module holds ONLY what a person typed and has not
 * submitted anywhere yet; it answers a different question ("what was half-typed
 * here?") than the store answers ("what is open, and for whom?"). A grant with no
 * draft is not missing anything — the two are independent, and this module has no
 * opinion about which grants exist.
 *
 * WHY PLAIN, NOT A `useSyncExternalStore` STORE LIKE ITS SIBLINGS. Nothing outside
 * `GrantRow` reads a draft — it is read once at mount (to seed) and written on every
 * keystroke (fire-and-forget). There is no second subscriber to notify and no
 * re-render this module needs to trigger; a plain `Map` is the whole job.
 *
 * LIFETIME. A draft for a key is written as the person types and deleted the moment
 * that grant is answered or withdrawn (`GrantRow` calls `clearGrantDraft` at every
 * exit — approve, reject, and the POST landing while the agent restart fails). A
 * stale secret must not outlive its prompt: once the row is gone for good, so is
 * whatever was typed into it. A draft is NOT deleted merely because the row
 * unmounts — that is the whole point of keeping it here instead of in `useState`.
 */

const drafts = new Map<string, Record<string, string>>();

/** What was typed for this grant so far. `{}` if nothing was, or ever was. */
export function getGrantDraft(key: string): Record<string, string> {
  return drafts.get(key) ?? {};
}

/** Record one slot's value as the person types it. */
export function setGrantDraftValue(key: string, slot: string, value: string): void {
  const existing = drafts.get(key) ?? {};
  drafts.set(key, { ...existing, [slot]: value });
}

/** The grant this draft belonged to is answered or withdrawn — forget it. */
export function clearGrantDraft(key: string): void {
  drafts.delete(key);
}

/** Test seam — reset between tests. */
export function resetGrantDraftsForTest(): void {
  drafts.clear();
}
