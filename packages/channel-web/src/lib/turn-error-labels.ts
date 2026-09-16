/**
 * What a turn error SAYS, and nothing else (TASK-372).
 *
 * A wire turn-error reason code in, an authored user-facing sentence out. This
 * module knows the wording; it does not know the wire, the store, the AI SDK or
 * React. Both surfaces that read an SSE `error` frame render from this one
 * table:
 *
 *   - `lib/transport.ts`     — chat, into an AI-SDK `error` chunk.
 *   - `lib/workspace-api.ts` — the agent workspace, into an `onError` callback.
 *
 * WHY IT LIVES HERE, AND NOT IN `transport.ts` WHERE IT STARTED. Fault A put
 * the table in `transport.ts` when chat was the only surface. TASK-296 found
 * the workspace printing a raw reason code (`dev-service-failed`) at a reader
 * and pointed it at this table rather than growing a second one — the right
 * call under invariant 4, and the reason the two surfaces still cannot drift.
 *
 * But `transport.ts` is chat's, and Tier 5 #4 of
 * `docs/plans/2026-09-12-workspace-as-sole-interface.md` (TASK-360) deletes it
 * with the rest of the chat tree when the workspace becomes the only surface.
 * A table the surviving surface reads out of a file that is being deleted is a
 * table that leaves with chat. So it moved out ahead of the deletion, the same
 * way `lib/sse-frames.ts` (TASK-349) and `lib/grant-copy.ts` (TASK-350) did.
 *
 * WHY IT IS NOT IN `lib/sse-frames.ts`, the other module that outlived the
 * split: that one is the wire — bytes in, typed frames out — and a lint rule
 * pins it that way. A reason code becoming a sentence a person reads is a
 * RENDERING concern, which is exactly what that module refuses.
 *
 * THIS FILE SURVIVES TASK-360. Its neighbour `lib/turn-error.ts` does not —
 * that one is chat's `onError` adapter, whose only caller outside its own test
 * is `lib/runtime.tsx`, and it goes with the assistant-ui runtime. The similar
 * names are a trap worth naming once: deleting chat means deleting
 * `turn-error.ts`, never this file.
 *
 * `CONNECTION_LOST` deliberately did NOT move here. It is the banner for a
 * `done`-less SSE drop, and it is chat's alone: the workspace already has its
 * own copy for that case (`WORKSPACE_STREAM_LOST` in `lib/workspace-api.ts`),
 * deliberately worded as a detail line under the surface's own prose rather
 * than as a standalone instruction. Two surfaces, two sentences, on purpose —
 * moving it here would imply a shared one that does not exist.
 */

/**
 * Default user-facing wording for an abnormal turn end (Fault A — the
 * runner died mid-turn or wedged past the chat timeout). Also what chat's
 * runtime `onError` falls back to when the AI-SDK error carries no message.
 * Kept client-side so wording/i18n is one place.
 */
export const DEFAULT_TURN_ERROR =
  'The agent stopped unexpectedly. Retry to continue.';

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
};

/** Max chars of the untrusted `detail` line we render (defense-in-depth — it's
 *  already bounded + sanitized server-side; this is a final client-side clamp). */
export const MAX_DETAIL_CHARS = 400;
