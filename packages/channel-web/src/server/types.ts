// ---------------------------------------------------------------------------
// Shared types for the channel-web host plugin.
//
// The wire shape (`reqId` / `text` / `kind`) mirrors @ax/ipc-protocol's
// `EventStreamChunkSchema` (Invariant I1). We re-declare it here as a
// plain interface so the server-side bundle doesn't drag the zod runtime
// import path into channel-web's react bundle.
// ---------------------------------------------------------------------------

export type StreamChunkKind = 'text' | 'thinking' | 'tool-use' | 'tool-result';

/**
 * One streaming chunk observation. Matches `EventStreamChunkSchema`'s
 * discriminated union (LLM-API vocabulary, not transport — Invariant I1).
 *
 * `text`, `input` (a string-keyed object), and `output` are UNTRUSTED
 * model / tool output (Invariant J2) — JSON-encoded into SSE frames here,
 * sanitized at render in the browser.
 *
 * `seq` (TASK-23) is a HOST-minted monotonic per-reqId chunk cursor stamped
 * by the `ChunkBuffer` as each chunk is buffered (see chunk-buffer.ts). It is
 * NOT carried on the `@ax/ipc-protocol` IPC wire — the runner never supplies
 * it (the host buffer is the sole authority, so untrusted runner content can't
 * steer the client's dedup cursor — Invariant I5). It is therefore OPTIONAL on
 * this type: a chunk straight off the IPC dispatch (before the buffer-fill
 * subscriber stamps it) has no `seq`; once buffered/forwarded it does. The
 * client dedups replayed frames at/below its last-seen `seq` and falls back to
 * the visible CONNECTION_LOST banner on a contiguity gap that exceeds the
 * bounded buffer. `seq` is a plain monotonic int → transport/storage-agnostic
 * (Invariant I1).
 */
export type StreamChunk =
  | { reqId: string; kind: 'text'; text: string; seq?: number }
  | { reqId: string; kind: 'thinking'; text: string; seq?: number }
  | {
      reqId: string;
      kind: 'tool-use';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      seq?: number;
    }
  | {
      reqId: string;
      kind: 'tool-result';
      toolCallId: string;
      output: string;
      isError?: boolean;
      seq?: number;
    };

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
 *   - chunk frame: `{ reqId, text, kind, seq? }`  — content delta (`seq` is the
 *                                                   host-minted per-reqId cursor
 *                                                   the client dedups on; TASK-23).
 *   - phase frame: `{ reqId, phase }`             — out-of-band agent state.
 *   - done  frame: `{ reqId, done: true }`         — normal turn terminator.
 *   - error frame: `{ reqId, error }`             — abnormal turn terminator.
 *   - permission frame: `{ reqId, permissionRequest }` — NON-terminal JIT
 *                                                   bundled approval card
 *                                                   (design §11.3); never
 *                                                   carries a secret.
 *
 * The `error` frame closes the stream when a turn ends WITHOUT a normal
 * `chat:turn-end` (the runner died mid-turn or wedged past the chat
 * timeout). `error` is a stable, backend-agnostic reason code (e.g.
 * `sandbox-terminated`, `chat-run-timeout`) — NOT a pod name / exit code;
 * the client maps it to a user-facing label. Without it the client's
 * "Thinking…" spinner hangs forever (the 25 s keepalive keeps the
 * connection open).
 */
/**
 * Payload for the `chat:permission-request` subscriber hook AND the inner
 * object of the matching SSE frame. The JIT bundled approval card (design
 * §11.3): the skill id, its description, the hosts it would reach, and the
 * credential SLOT NAMES it declares. NEVER a secret value — the card's key
 * field posts straight to the host credential store (the §10 trust path), so
 * no credential ever rides this frame or the transcript. Backend-agnostic
 * (Invariant I1): hostnames + slot names are public manifest fields.
 *
 * Re-declared here (not imported from @ax/skill-broker) — same cross-plugin
 * duplication-with-a-comment posture as StreamChunk vs @ax/ipc-protocol (I2).
 */
export interface PermissionRequest {
  skillId: string;
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
}

export type SseFrame =
  | StreamChunk
  | { reqId: string; phase: PhaseKind }
  | { reqId: string; done: true }
  | { reqId: string; error: string }
  | { reqId: string; permissionRequest: PermissionRequest };

/**
 * Payload for the `chat:phase` subscriber hook. Matches the SSE phase
 * frame's payload shape — the SSE handler's job is just to JSON-encode it.
 */
export interface PhaseEvent {
  reqId: string;
  phase: PhaseKind;
}
