// ---------------------------------------------------------------------------
// Shared types for the channel-web host plugin.
//
// The wire shape (`reqId` / `text` / `kind`) mirrors @ax/ipc-protocol's
// `EventStreamChunkSchema` (Invariant I1). We re-declare it here as a
// plain interface so the server-side bundle doesn't drag the zod runtime
// import path into channel-web's react bundle.
// ---------------------------------------------------------------------------

export type StreamChunkKind = 'text' | 'thinking';

/**
 * One streaming chunk observation. Matches `EventStreamChunkSchema` shape;
 * `text` is UNTRUSTED model output (Invariant J2) — JSON-encoded into SSE
 * frames here, sanitized at render in the browser.
 */
export interface StreamChunk {
  reqId: string;
  text: string;
  kind: StreamChunkKind;
}

/**
 * Phase events surfaced to the client out-of-band of message content.
 *
 * Currently the only phase is `'sandbox-starting'`, fired by sandbox
 * providers that have a non-instant startup (today: `@ax/sandbox-k8s`
 * before `createNamespacedPod`). `@ax/sandbox-subprocess` has nothing
 * to announce — it's instant — so it doesn't fire at all.
 *
 * The string is intentionally backend-agnostic ("sandbox-starting", not
 * "pod-starting"): subscribers must NOT key off it to do k8s-specific
 * things. A future docker provider would emit the same value.
 *
 * The wire frame is a separate `SseFrame` variant so the client can
 * branch without nullable fields.
 */
export type PhaseKind = 'sandbox-starting';

/**
 * Frame the SSE handler emits to the client. Matches the `data:` JSON the
 * browser parses verbatim. The three variants are deliberately disjoint
 * so the client can `switch` on a single discriminator.
 *
 *   - chunk frame: `{ reqId, text, kind }`        — content delta.
 *   - phase frame: `{ reqId, phase }`             — out-of-band agent state.
 *   - done  frame: `{ reqId, done: true }`         — turn terminator.
 */
export type SseFrame =
  | { reqId: string; text: string; kind: StreamChunkKind }
  | { reqId: string; phase: PhaseKind }
  | { reqId: string; done: true };

/**
 * Payload for the `chat:phase` subscriber hook. Matches the SSE phase
 * frame's payload shape — the SSE handler's job is just to JSON-encode it.
 */
export interface PhaseEvent {
  reqId: string;
  phase: PhaseKind;
}
