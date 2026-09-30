/**
 * The two sentences the HOST sends when the storage limit turns a Save away
 * (TASK-719), and the client falls back to when the server's own is missing.
 *
 * WHY THIS IS ITS OWN FILE, AND HAS NO IMPORTS. Both sides need the words:
 * `server/routes-workspace.ts` (Rules) and `server/routes-agent-identity.ts`
 * answer `413 { error: 'storage-full', message }` with them, and
 * `lib/storage-copy.ts` re-exports them for the SPA's fallback. `storage-copy`
 * itself cannot be imported server-side (it pulls in the client's
 * extensionless imports, which Node's ESM resolver does not guess), so the
 * shared text lives here, where the host can reach it and there is exactly one
 * copy of each sentence to agree on. `__tests__/server-import-extensions.test.ts`
 * walks the host's import graph and would catch this file growing an import it
 * should not have.
 *
 * WHAT THEY MAY SAY. The reader is a person whose Save just did not go through.
 * Each sentence says what was NOT saved, why, and who can help. None tells them
 * to delete anything (nothing they can do gives space back today, so that would
 * be a false promise; `storage-copy.test.ts` forbids the words), none carries a
 * number (the limit is an admin's to change), none names a code.
 *
 * These are NOT the veto's own message. That one is worded for the AGENT that
 * writes files (it names paths and says what to do next) and never crosses to a
 * person.
 */

/** The Rules editor's Save (`PUT /api/workspace/agents/:id/memory/rules`). */
export const STORAGE_FULL_RULES =
  "We couldn't save your rules because your storage is full. An admin can make more room, then you can try again.";

/**
 * The agent form's identity save (`PUT /admin/agents/:id/identity`).
 *
 * "The agent was saved" is true because of the ORDER the form saves in: it
 * creates or patches the agent, and attaches its connectors, before it PUTs the
 * identity. And "its identity wasn't" is true because `workspace:apply` is
 * all-or-nothing: a refusal writes none of the three files.
 *
 * It points at the edit screen rather than at "save again": on a brand-new
 * agent the form is still in its create state (`AgentForm` only leaves it after
 * a fully successful save), so pressing Save a second time would POST a second
 * agent. Editing the one that exists is the step that works in both cases.
 */
export const STORAGE_FULL_IDENTITY =
  "The agent was saved, but its identity wasn't, because storage is full. An admin can make more room, then you can edit the agent and save its identity again.";
