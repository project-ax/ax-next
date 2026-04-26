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
 * Frame the SSE handler emits to the client. Matches the `data:` JSON the
 * browser parses verbatim. `done: true` is a separate frame fired on
 * `chat:turn-end`; the chunk-frame and the done-frame are deliberately
 * disjoint discriminants so the client can branch without nullable fields.
 */
export type SseFrame =
  | { reqId: string; text: string; kind: StreamChunkKind }
  | { reqId: string; done: true };
