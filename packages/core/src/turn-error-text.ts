/**
 * What a turn error SAYS, and nothing else (TASK-372, moved here by TASK-1250).
 *
 * A wire turn-error reason code in, an authored user-facing sentence out. This
 * is the ONE table (invariant 4) for every surface that turns a turn-error
 * reason into words:
 *
 *   - channel-web's live failure strip and its reloaded error row, through
 *     `lib/turn-error-labels.ts` (which re-exports this beside the web-only
 *     helpers);
 *   - channel-slack's failed-turn reply.
 *
 * WHY `@ax/core`. Every plugin already depends on it, so a second plugin can
 * share the table without importing a sibling (invariant 2). This file imports
 * NOTHING, so the channel-web SPA can bundle the subpath without dragging the
 * kernel (hook bus, node built-ins) along; a test pins that.
 *
 * Slack layers its own wording only for the reasons whose sentence here points
 * at a web-only screen ("Open Connectors", "Settings"); channel-slack's
 * `copy.ts` owns those. Everything else it says in these words.
 *
 * `detail` is UNTRUSTED text: bounded and sanitized server-side, clamped once
 * more by `turnErrorText`, and rendered by each surface as inert text. It is
 * never markup and never a reason code.
 *
 * HISTORY. Fault A put this table in the (now deleted) chat UI's
 * `lib/transport.ts`; TASK-372 moved it to channel-web's
 * `lib/turn-error-labels.ts`; TASK-1250 moved it here so Slack stops saying
 * its own generic line for a failure the web explains.
 */

/**
 * Default user-facing wording for an abnormal turn end (Fault A — the
 * runner died mid-turn or wedged past the chat timeout). Also what chat's
 * runtime `onError` falls back to when the AI-SDK error carries no message.
 */
export const DEFAULT_TURN_ERROR = 'The agent stopped unexpectedly. Retry to continue.';

/**
 * Map a wire turn-error reason code (backend-agnostic, from the orchestrator)
 * to a user-facing label. Unknown codes fall back to DEFAULT_TURN_ERROR —
 * forward-compat with newer server builds that emit a code the client
 * doesn't yet recognize.
 */
export const ERROR_LABELS: Readonly<Record<string, string>> = Object.freeze({
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
  // TASK-690 — the storage limit's old front door. No longer emitted live
  // since TASK-993: chat is never turned away for a full store. Kept so a
  // refusal persisted before then replays as itself (the TASK-806 pattern).
  // The settings side is `components/admin/StorageTab.tsx`.
  'chat:start:storage-full':
    'Your storage is full, so nothing new can be saved right now. Ask an admin for more room, then try again.',
  // TASK-784 — the runner exited with its fatal code before the turn ended:
  // it never booted far enough to talk to the host (a bad environment, a
  // refused connection). The specifics are in the host log, never here — the
  // runner's own error text is untrusted and stays server-side. A retry spawns
  // a fresh runner, so that comes first; a repeat is an admin's to look into.
  'runner-boot-failed':
    'The agent couldn’t start up. Retry to continue. If it keeps happening, ask an admin to take a look.',
  // TASK-713 — the agent couldn't start because one of its connectors' sign-ins
  // is dead (the service rejected it, or it can't be renewed). Unlike a generic
  // stop, the person can fix this themselves: the agent's Connectors tab
  // already marks that connector and offers Reconnect (or, on a team agent
  // whose expired sign-in is their own, "Sign in again" — TASK-774), so the
  // sentence points there and uses the lower-case verb that covers both.
  // TASK-783: when the host can tell which connector it was, the frame's
  // `detail` names it ("Connector: Gmail"), rendered on the line under this.
  'connector-needs-reconnect':
    'One of this agent’s connectors needs you to sign in again. Open Connectors, reconnect it, then retry.',
  // TASK-828 — the same failure for SEVERAL connectors at once. The host now
  // learns about every dead sign-in in one go, and the frame's `detail` lists
  // them ("Connectors: Gmail, Linear"), so the sentence says "some … them"
  // rather than sending the person to fix one, retry, and meet the next.
  'connectors-need-reconnect':
    'Some of this agent’s connectors need you to sign in again. Open Connectors, reconnect each one, then retry.',
  // TASK-796 — the reconnect line's sibling for a connector nobody has signed
  // in to yet (an attached connector whose key nobody has added). "Sign in",
  // never "reconnect": there was never a connection to restore. The rail marks
  // that row "Not signed in yet" with Sign in / Add key on it (TASK-795), so
  // "sign in" covers both and the sentence points there.
  //
  // TASK-806: no longer emitted live — the host now SKIPS a never-signed-in
  // connector for the turn instead of failing it (the chat says so with
  // `SkippedConnectorsNotice`). Kept for persisted rows replayed on reload:
  // turn-error rows already stored on prod still carry this code, and without
  // the label an old conversation would replay as "The agent stopped
  // unexpectedly".
  'connector-needs-sign-in':
    'One of this agent’s connectors isn’t signed in yet. Open Connectors, sign in, then retry.',
  // TASK-802 — two failures at once: the model-provider key is missing AND a
  // connector isn't signed in. Naming only the connector sent the
  // person to sign in, retry, and meet the key failure on the second turn. The
  // turn cannot run without the key, so it comes first, in the same words the
  // provider-unknown line uses; and since it is an ADMIN's to fix (see that
  // line), the sentence says so and separates it from the half the reader can
  // do now. The button on the live strip is for that second half.
  //
  // TASK-806: no longer emitted live (the connector half is skipped now, so a
  // missing provider key reads as an ordinary open failure). Kept for persisted
  // rows replayed on reload — see `connector-needs-sign-in` above.
  'provider-key-missing-connector-needs-sign-in':
    'This agent can’t run right now. The AI service it uses isn’t set up on this server, and one of its connectors isn’t signed in yet. An admin can fix the first one in Settings. Open Connectors to sign in to the second, then retry.',
  // TASK-911: a task check-in that routines refused because its instructions
  // didn't load (TASK-908's veto). Only that check-in's own transcript shows
  // this row, where the default sentence would be false: nothing stopped, and
  // there is nothing to retry. The words are routines' own run errors, pinned
  // by the test, so the summary above the transcript and the row in it agree.
  'system-prompt:brief-missing': 'This task’s instructions didn’t load, so the check-in didn’t run.',
  'system-prompt:brief-too-long':
    'This task’s instructions are too long to load, so the check-in didn’t run. Shorten “What should … do?” in Edit and the next check-in will run.',
  // TASK-989 — the agent's identity and Instructions live in the database now,
  // and the host could not read them when it went to start the turn, so the
  // turn never began (nothing ran, nothing to undo). Unlike the brief-* codes
  // above this is a read failure, which can clear on its own, so a retry is a
  // fair thing to suggest.
  'system-prompt:identity-unavailable':
    'We couldn’t load this agent’s identity and instructions, so it didn’t start. Try again in a moment.',
  // TASK-1059 — the host couldn't save the person's message, so the turn never
  // started, and a retry can work. Resend carries all of it, words and files
  // (TASK-1063: see `turnErrorMessageNotSaved`).
  'conversation:message-not-saved':
    'Your message didn’t reach the agent. That’s on us, not you — try again in a moment.',
});

/**
 * The reason codes a LIVE turn can fail with that a person fixes on the
 * agent's Connectors tab (TASK-796; TASK-1250 moved it here). Each surface
 * that sends the person there reads THIS set (invariant 4): channel-web's
 * live failure strip offers its "Open Connectors" button for these
 * (`turnErrorOpensConnectors`), and channel-slack's failed-turn line links
 * the agent's Connectors settings for these and no others.
 *
 * Only `connector-needs-reconnect` (and, since TASK-828, its plural
 * `connectors-need-reconnect`) is left (TASK-806): a connector never signed
 * in to is skipped for the turn rather than failing it, so
 * `connector-needs-sign-in` and `provider-key-missing-connector-needs-sign-in`
 * can no longer arrive on a live turn. Their LABELS stay in `ERROR_LABELS`
 * for persisted rows replayed on reload, but a replayed row has no button,
 * so they have no business here, and a stale set would offer one for a
 * failure this build never produces.
 *
 * Read-only for real, not just in its type: two plugins share this one
 * object, so `add`, `delete` and `clear` throw rather than let one of them
 * change what the other offers.
 */
export const CONNECTORS_TAB_REASONS: ReadonlySet<string> = readOnlySet([
  'connector-needs-reconnect',
  // TASK-828 — the plural of the line above; same fix, same tab.
  'connectors-need-reconnect',
]);

function readOnlySet(items: readonly string[]): ReadonlySet<string> {
  const set = new Set(items);
  const refuse = (): never => {
    throw new TypeError('CONNECTORS_TAB_REASONS is read-only');
  };
  Object.defineProperties(set, { add: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
  return Object.freeze(set);
}

/**
 * Max chars of the untrusted `detail` line any surface renders (defense in
 * depth: it is already bounded and sanitized server-side; this is the final
 * clamp, shared so the browser, the host and Slack agree where the line ends).
 */
export const MAX_DETAIL_CHARS = 400;

/**
 * The table's own sentence for a reason code, or `undefined` when the reason
 * is not in it. Callers that want a fallback use `turnErrorText`; Slack uses
 * the `undefined` to say its own line for a reason the table doesn't know.
 */
export function turnErrorLabel(reason: string): string | undefined {
  /*
    A PLAIN OBJECT LOOKUP ANSWERS FOR THE PROTOTYPE TOO, which is a real way
    for this table to put something absurd in front of a person. `ERROR_LABELS`
    is an object literal, so `ERROR_LABELS['toString']` — or `'constructor'`,
    or `'valueOf'` — is NOT undefined: it is an inherited function, the `??`
    never fires, and the template in `turnErrorText` stringifies it into the reader's alert
    as `function Object() { [native code] }`.
    The reason is not always host vocabulary: when a runner reports its own
    failure, the orchestrator passes the runner's own text along as the
    reason on a member's turn, so a reason here can be any string, and
    nothing stops it being `toString`. It is fixed HERE because HERE is now
    the only place the rule is written: every reader of an error frame goes
    through here (`turnErrorText` calls this), so one guard covers all of
    them. That was not true when the guard was first written — `lib/transport.ts` still had its
    own hand-copy, and therefore its own copy of this hole, until a reviewer
    caught the gap between the claim and the code. `typeof` answers it
    completely: a non-string is not a label, whatever it is and wherever it
    came from.
  */
  const found: unknown = ERROR_LABELS[reason];
  return typeof found === 'string' ? found : undefined;
}

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
  const label = turnErrorLabel(reason) ?? DEFAULT_TURN_ERROR;
  const line = typeof detail === 'string' ? detail.slice(0, MAX_DETAIL_CHARS).trim() : '';
  return line.length > 0 ? `${label}\n${line}` : label;
}
