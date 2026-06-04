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
 *
 * TASK-160 — the error frame may also carry an OPTIONAL `detail` field: a
 * bounded, sanitized, author-facing free-text line (e.g. a dev-service-sidecar
 * self-diagnosis naming the offending service + writablePath). It is still NOT
 * a pod name / backend identifier; it's the human-readable specifics that the
 * stable reason code can't carry. The client renders it as UNTRUSTED plain text
 * beneath the mapped label.
 */
/**
 * Payload for the `chat:permission-request` subscriber hook AND the inner
 * object of the matching SSE frame. A discriminated union on `kind`:
 *
 * - `kind: 'skill'` — the JIT bundled approval card (design §11.3, TASK-35):
 *   the skill id, its description, the hosts it would reach, and the credential
 *   SLOT NAMES it declares. Fired by @ax/skill-broker, SSE-matched by
 *   ctx.conversationId. NEVER a secret value — the card's key field posts
 *   straight to the host credential store (the §10 trust path), so no
 *   credential ever rides this frame or the transcript.
 *
 * - `kind: 'host'` — the reactive egress-wall card (design §6B, TASK-37): the
 *   single host a blocked egress tried to reach, plus the opaque sessionId the
 *   browser echoes back on grant. Fired by @ax/chat-orchestrator, SSE-matched
 *   by the routing reqId carried on the FIRED payload (stripped before the
 *   browser sees it). Carries no secret; the grant route re-validates session
 *   ownership host-side.
 *
 * - `kind: 'connector'` — the upfront authored-CONNECTOR approval card (design
 *   §"Authoring", TASK-94): a connectorId + display name + the reach (hosts /
 *   slots / packages) the connector declares. Fired by @ax/chat-orchestrator,
 *   SSE-matched by ctx.conversationId (the firing ctx carries the real
 *   conversationId; same match posture as the skill card). NO `description` — a
 *   connector carries a `name`. Carries no secret; approval grants the connector
 *   under the TASK-93 wall with a connectorId subject.
 *
 * Backend-agnostic (Invariant I1): hostnames, slot names, connectorId, name, and
 * the opaque sessionId are all public/transport-neutral fields. Re-declared here
 * (not imported from @ax/skill-broker / @ax/credential-proxy / @ax/connectors) —
 * same cross-plugin duplication-with-a-comment posture as StreamChunk vs
 * @ax/ipc-protocol (I2).
 */
export type PermissionRequest =
  | {
      kind: 'skill';
      skillId: string;
      description: string;
      hosts: string[];
      slots: {
        slot: string;
        kind: 'api-key';
        /** JIT P2 — service slug; when set, the key binds the shared vault entry. */
        account?: string;
        /**
         * TASK-124 — the resolved vault-key tags the card's WRITE path uses to
         * build `{kind:'account', service, slot?}`: `service` = the slot's account
         * (else the connector id); `slotTag` present only for a multi-slot
         * connector's per-slot `account:<service>:<slot>` ref. Public, no secret.
         */
        service?: string;
        slotTag?: string;
        /** JIT P2 — the user already has the matching ref; card shows "use existing". */
        haveExisting?: boolean;
      }[];
      /**
       * TASK-39 open-mode banner. When true, the skill was just AUTHORED by the
       * agent (not a vetted catalog skill) — the card shows a warning. Optional
       * + public (no secret); the SSE subscriber forwards it verbatim.
       */
      authored?: boolean;
      /**
       * npm/pypi packages the skill declares. Informational — shown on the card
       * so the user sees which public registries a package-using authored skill
       * will reach. Optional + public (no secret); forwarded verbatim. Both
       * arrays are always present when set (never partially absent).
       */
      packages?: { npm: string[]; pypi: string[] };
    }
  | { kind: 'host'; host: string; sessionId: string }
  | {
      kind: 'connector';
      connectorId: string;
      name: string;
      hosts: string[];
      slots: {
        slot: string;
        kind: 'api-key';
        /** service slug; when set, the key binds the shared `account:<service>` vault. */
        account?: string;
        /**
         * TASK-124 — the resolved vault-key tags the card's WRITE path uses to
         * build `{kind:'account', service, slot?}`: `service` = the slot's account
         * (else the connector id); `slotTag` present only for a multi-slot
         * connector's per-slot `account:<service>:<slot>` ref. Public, no secret.
         */
        service?: string;
        slotTag?: string;
        /** the user already has the matching ref; card shows "use existing". */
        haveExisting?: boolean;
      }[];
      /** Open-mode banner — the agent just authored this connector (TASK-94 → true). */
      authored?: boolean;
      /** npm/pypi packages the connector declares; informational. No secret; forwarded verbatim. */
      packages?: { npm: string[]; pypi: string[] };
    };

export type SseFrame =
  | StreamChunk
  | { reqId: string; phase: PhaseKind }
  | { reqId: string; done: true }
  // `error` is the stable backend-agnostic reason code; `detail` (TASK-160) is
  // an OPTIONAL author-facing free-text line (e.g. a dev-service-sidecar
  // self-diagnosis), bounded + sanitized upstream and rendered as UNTRUSTED
  // text by the client. Omitted for ordinary errors.
  | { reqId: string; error: string; detail?: string }
  | { reqId: string; permissionRequest: PermissionRequest };

/**
 * Payload for the `chat:phase` subscriber hook. Matches the SSE phase
 * frame's payload shape — the SSE handler's job is just to JSON-encode it.
 */
export interface PhaseEvent {
  reqId: string;
  phase: PhaseKind;
}
