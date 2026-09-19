/**
 * A half-typed composer draft, kept alive across `AgentConversation`'s own
 * component lifetime (TASK-393).
 *
 * WHY THIS EXISTS. `AgentView` is now `key`ed by `agentId` (TASK-393, fixing
 * a stale-send-continuation bug), so switching agents remounts the whole
 * chat pane — including `AgentConversation`, which owns the composer's
 * `draft` text in a plain `useState`. Without this module, an unsent draft
 * typed for one agent would vanish the moment you looked at another one,
 * which is a worse regression than the bug the remount fixes. This module
 * is what lets the draft come back if you switch away and back.
 *
 * WHY A SEPARATE MODULE AND NOT LIFTED INTO `WorkspaceShell`. The shell owns
 * the route and the agents that hang off it (invariant 4 — one source of
 * truth per concept); it has no business also owning what somebody typed and
 * has not sent. This module answers a narrower question ("what was
 * half-typed for this agent?") that nothing else needs to read.
 *
 * WHY PLAIN, NOT A `useSyncExternalStore` STORE LIKE ITS SIBLINGS. Nothing
 * outside `AgentConversation` reads a draft — it is read once at mount (to
 * seed `useState`) and written on every keystroke (fire-and-forget). There is
 * no second subscriber to notify and no re-render this module needs to
 * trigger; a plain `Map` is the whole job (same reasoning as
 * `workspace-grant-drafts.ts`, TASK-389).
 *
 * LIFETIME. A draft for an agent is written as the person types and cleared
 * the moment that agent's composer actually sends — `AgentConversation.send()`
 * clears it alongside its own `setDraft('')`. It is NOT cleared merely
 * because the component unmounts (switching agents, or leaving the chat tab)
 * — that is the whole point of keeping it here instead of in `useState`.
 */

const drafts = new Map<string, string>();

/** What was typed for this agent so far. `''` if nothing was, or ever was. */
export function getDraft(agentId: string): string {
  return drafts.get(agentId) ?? '';
}

/** Record the draft as the person types it. */
export function setDraft(agentId: string, value: string): void {
  if (value === '') {
    drafts.delete(agentId);
  } else {
    drafts.set(agentId, value);
  }
}

/** The draft was sent (or explicitly discarded) — forget it. */
export function clearDraft(agentId: string): void {
  drafts.delete(agentId);
}

/** Test seam — reset between tests. */
export function resetDraftsForTest(): void {
  drafts.clear();
}
