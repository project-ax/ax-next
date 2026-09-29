/**
 * The first turn a freshly-bootstrapped agent is woken with (TASK-689).
 *
 * The runner can only start a turn from a user message, so a new agent needs
 * SOME first message before it can open the conversation. This is it — and it
 * is a RESERVED MARKER, not something the person said:
 *
 *   - `WorkspaceShell` sends exactly this text when it kicks off a just-created
 *     agent (see the `workspaceApi.sendMessage` call sites there);
 *   - the thread builder in `server/routes-workspace.ts` skips a user turn at
 *     `turnIndex 0` whose text is exactly this, and `AgentView` draws no
 *     optimistic bubble for it — so the person never sees a message they did
 *     not type, and the agent's own greeting is the first thing in the thread.
 *
 * It still reaches the MODEL (it is a real turn in the transcript, and the
 * bootstrap script tells the agent to open the conversation) and the TITLE
 * GENERATOR (`@ax/conversation-titles` builds its prompt from the raw
 * transcript, not from the thread), so its wording shapes the first
 * conversation's title. Keep it plain: no tags or brackets that could leak
 * into a title.
 *
 * Changing this text orphans the hidden turns already stored: a conversation
 * started under the old spelling no longer matches, so its kickoff renders as
 * an ordinary user message. That is acceptable — it is a one-line, harmless
 * artefact on an old chat, and the alternative (matching every spelling we ever
 * used) would hide real messages.
 *
 * A full sentence rather than a bare `hi` on purpose: a person typing exactly
 * this as their own first message is not a realistic collision, whereas `hi`
 * as turn 0 is an ordinary opener that must stay visible.
 */
export const KICKOFF_TEXT = 'Your person just created you. Say hello.';
