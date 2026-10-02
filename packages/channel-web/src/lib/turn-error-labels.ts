/**
 * What a turn error SAYS, and nothing else (TASK-372).
 *
 * A wire turn-error reason code in, an authored user-facing sentence out. This
 * module knows the wording; it does not know the wire, the store, the AI SDK or
 * React. Every surface that renders a turn failure goes through
 * `turnErrorText` below:
 *
 *   - `lib/workspace-api.ts` — the agent workspace, into an `onError` callback.
 *   - `components/workspace/AgentConversation.tsx` — the workspace again, for
 *     a failure REPLAYED out of the durable record after a reload.
 *
 * WHY IT LIVES HERE. Fault A put this table in the now-deleted chat UI's
 * `lib/transport.ts` when chat was the only surface. TASK-296 found the
 * workspace printing a raw reason code (`dev-service-failed`) at a reader and
 * pointed it at that table rather than growing a second one — the right call
 * under invariant 4. Ahead of TASK-360 deleting `transport.ts` with the rest
 * of the chat tree, the table moved out here, the same way `lib/sse-frames.ts`
 * (TASK-349) and `lib/grant-copy.ts` (TASK-350) moved theirs.
 *
 * WHY IT IS NOT IN `lib/sse-frames.ts`, the other module that outlived the
 * split: that one is the wire — bytes in, typed frames out — and a lint rule
 * pins it that way. A reason code becoming a sentence a person reads is a
 * RENDERING concern, which is exactly what that module refuses.
 *
 * `CONNECTION_LOST` deliberately did not move here. It was the deleted chat
 * UI's banner for a `done`-less SSE drop; the workspace has its own copy for
 * that case (`WORKSPACE_STREAM_LOST` in `lib/workspace-api.ts`), deliberately
 * worded as a detail line under the surface's own prose rather than as a
 * standalone instruction. Two surfaces, two sentences, by design — and now
 * one surface, its own sentence.
 */

/**
 * Default user-facing wording for an abnormal turn end (Fault A — the
 * runner died mid-turn or wedged past the chat timeout). Also what chat's
 * runtime `onError` falls back to when the AI-SDK error carries no message.
 * Kept client-side so wording/i18n is one place.
 */
export const DEFAULT_TURN_ERROR = 'The agent stopped unexpectedly. Retry to continue.';

/**
 * Map a wire turn-error reason code (backend-agnostic, from the orchestrator)
 * to a user-facing label. Unknown codes fall back to DEFAULT_TURN_ERROR —
 * forward-compat with newer server builds that emit a code the client
 * doesn't yet recognize.
 */
export const ERROR_LABELS: Record<string, string> = {
  'chat-run-timeout': 'The agent timed out. Retry to continue.',
  // TASK-160 — a declared dev service failed to start. The actionable
  // specifics (which service, which path) ride the optional `detail` field and
  // are appended by each reader; this is the headline.
  'dev-service-failed': 'A dev service failed to start.',
  // PR 4 — the agent's model names a provider (the bit before the first `/`)
  // that this deployment has no configuration for, so there is nowhere to send
  // the turn. An operator fixes it by picking a different model for the agent,
  // or by adding that provider's key on the Model config tab.
  //
  // (TASK-335 / audit A4) That fix is an ADMIN's to make, and this string is
  // shown to whoever happened to send the message. Telling a non-admin to "add
  // that provider's key in Model config" points them at a surface they cannot
  // open, to do a job that is not theirs — so it now says what happened and who
  // can fix it. The offending model ref is not lost: the orchestrator already
  // logs it host-side (`agent_model_provider_unknown`) and deliberately keeps
  // it off the wire, so there is nothing to move to a detail line here.
  'agent-model-provider-unknown':
    'This agent can’t run right now — the AI service it uses isn’t set up on this server. An admin can fix this in Settings.',
  // TASK-692 — the usage-limits gate. The host vetoes a turn at `chat:start`
  // with the reason `chat:start:<code>`, before a sandbox is spawned or a token
  // is spent, so these are the sentences a person reads when a limit turns
  // their message away. Each says what happened and the one thing to do next;
  // none names a dollar amount, because the reader cannot act on our estimate.
  // The operator's side of the same feature is `components/admin/UsageTab.tsx`.
  'chat:start:usage-limit-fleet':
    'The workspace has reached its daily usage limit. Usage frees up gradually over the next 24 hours. Ask an admin if work needs to continue sooner.',
  'chat:start:usage-limit-daily':
    "You've reached your daily usage limit. It frees up gradually over the next 24 hours. If you need more right now, ask an admin to raise it.",
  'chat:start:usage-limit-rate':
    "You're sending messages faster than we can keep up with. Give it a few minutes, then try again.",
  'chat:start:usage-suspended':
    'Your agents are paused right now. Ask an admin to turn them back on.',
  // The check itself failed (database unreachable), so the gate fails CLOSED:
  // it holds the message rather than let an unmetered turn through.
  'chat:start:usage-check-unavailable':
    "We couldn't check your usage just now, so we held this message to be safe. Try again in a moment.",
  // TASK-690 — the storage limit's front door. Files an agent writes are
  // checked when they are saved, but the runner's end-of-turn save happens
  // AFTER the reply is shown, so a refusal there would be silent. @ax/disk-quota
  // therefore also vetoes the turn at `chat:start` once a person's storage is
  // full, and this is what they read. It never says "delete something": only
  // deleting a whole agent gives space back (no smaller chore does), so the
  // one true next step for most people is an admin. The settings side is
  // `components/admin/StorageTab.tsx`.
  'chat:start:storage-full':
    'Your storage is full, so nothing new can be saved right now. Ask an admin for more room, then try again.',
};

/** Max chars of the untrusted `detail` line we render (defense-in-depth — it's
 *  already bounded + sanitized server-side; this is a final client-side clamp). */
export const MAX_DETAIL_CHARS = 400;

/**
 * One turn-error frame's worth of readable text: the authored label for the
 * reason code, and the optional `detail` line under it.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE COPIES OF FOUR LINES. The mapping
 * (`ERROR_LABELS[code] ?? DEFAULT_TURN_ERROR`, plus a clamped `detail` joined
 * on a newline) was written out by hand at every reader of an error frame, and
 * TASK-498 was about to add a fourth — the RELOADED error row, which reads the
 * same reason code out of the persisted display-event log rather than off the
 * live SSE. Four hand-copies of one rule is how the surfaces drift (invariant
 * 4), and drift here means two readers being told different things about the
 * same failure.
 *
 * `detail` is UNTRUSTED author-facing text — bounded and sanitized server-side
 * per `server/types.ts`, clamped once more here, and rendered by every caller
 * as a plain text node. It is never markup and never a reason code.
 */
export function turnErrorText(reason: string, detail?: string | null): string {
  /*
    A PLAIN OBJECT LOOKUP ANSWERS FOR THE PROTOTYPE TOO, which is a real way
    for this table to put something absurd in front of a person. `ERROR_LABELS`
    is an object literal, so `ERROR_LABELS['toString']` — or `'constructor'`,
    or `'valueOf'` — is NOT undefined: it is an inherited function, the `??`
    never fires, and the template below stringifies it into the reader's alert
    as `function Object() { [native code] }`.
    No producer emits such a reason today (the codes are host vocabulary), so
    this is a latent defect rather than a live one. It is fixed HERE because
    HERE is now the only place the rule is written: every reader of an error
    frame calls this function, so one guard covers all of them. That was not
    true when the guard was first written — `lib/transport.ts` still had its
    own hand-copy, and therefore its own copy of this hole, until a reviewer
    caught the gap between the claim and the code. `typeof` answers it
    completely: a non-string is not a label, whatever it is and wherever it
    came from.
  */
  const found: unknown = ERROR_LABELS[reason];
  const label = typeof found === 'string' ? found : DEFAULT_TURN_ERROR;
  const line = typeof detail === 'string' ? detail.slice(0, MAX_DETAIL_CHARS).trim() : '';
  return line.length > 0 ? `${label}\n${line}` : label;
}
