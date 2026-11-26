/**
 * What a turn error SAYS in the browser: the shared table, plus the web-only
 * helpers that key off the same reason codes (TASK-372, TASK-1250).
 *
 * The table itself (reason code in, authored sentence out) lives in
 * `@ax/core/turn-error-text` since TASK-1250, so Slack says the same thing for
 * the same failure instead of its own generic line. This file re-exports it
 * beside the two helpers that only make sense in the SPA, in the shape of
 * `lib/humanize.ts`. Its readers are unchanged:
 *
 *   - `lib/workspace-api.ts` — the agent workspace, into an `onError` callback.
 *   - `components/workspace/AgentConversation.tsx` — the workspace again, for
 *     a failure REPLAYED out of the durable record after a reload.
 *
 * `CONNECTION_LOST` deliberately is not here. It was the deleted chat UI's
 * banner for a `done`-less SSE drop; the workspace has its own copy for that
 * case (`WORKSPACE_STREAM_LOST` in `lib/workspace-api.ts`), worded as a detail
 * line under the surface's own prose rather than as a standalone instruction.
 */

import { CONNECTORS_TAB_REASONS } from '@ax/core/turn-error-text';

export {
  DEFAULT_TURN_ERROR,
  ERROR_LABELS,
  MAX_DETAIL_CHARS,
  turnErrorText,
} from '@ax/core/turn-error-text';

/**
 * True when the turn failed for a reason the Connectors tab fixes, so the
 * live failure strip offers an "Open Connectors" button and the sentence's
 * "Open Connectors" is one click rather than a hunt. The reloaded error row
 * stays text-only by design (see `AgentConversation`).
 *
 * Which reasons those are is `CONNECTORS_TAB_REASONS` in
 * `@ax/core/turn-error-text` (TASK-1250), the set Slack's failed-turn line
 * links the Connectors settings for too, so the two never disagree. Why it
 * holds only the reconnect codes, and not the replay-only sign-in ones, is
 * written there.
 */
export function turnErrorOpensConnectors(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && CONNECTORS_TAB_REASONS.has(reason);
}

/**
 * True when the turn was refused before the person's message was saved
 * (TASK-1063), so Resend must send their files again as well as their words.
 *
 * The set is exactly the refusals that come before the save: a `chat:start`
 * veto, an `agents:resolve` refusal, and the save failing itself. It depends on
 * the order in the orchestrator's agent-invoke turn: it runs `chat:start`, then
 * `agents:resolve`, THEN saves the person's message. A message that was saved
 * shows its files in the transcript, so Resend must not attach them twice.
 * Every other reason (`system-prompt:*`, `chat-run-*`, a dropped stream)
 * happens after the save and stays out. A guard in the orchestrator's
 * `route-by-conversation.test.ts` fails if the save moves earlier.
 *
 * `conversation:message-not-saved` means the save threw, not that it is proven
 * unsaved: in the rare case a write landed after hand-over, Resend can repeat
 * the files as well as the words.
 */
export function turnErrorMessageNotSaved(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return (
    reason === 'conversation:message-not-saved' ||
    reason.startsWith('chat:start:') ||
    reason.startsWith('agent-resolve:')
  );
}
