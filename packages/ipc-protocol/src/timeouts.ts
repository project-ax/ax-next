/**
 * Per-action timeout ceilings for host-side RPC dispatch (milliseconds).
 *
 * Frozen at module load so callers can't mutate them at runtime. Body-size
 * policing lives elsewhere (see `@ax/core/src/ipc/framing.ts` `MAX_FRAME`,
 * 4 MiB) — this map is strictly about how long a single in-flight RPC is
 * allowed to take.
 *
 * The keyset is the authoritative list of sandbox→host action names.
 */
export const IPC_TIMEOUTS_MS = Object.freeze({
  'tool.pre-call': 10_000,
  'tool.execute-host': 30_000,
  'tool.list': 5_000,
  'workspace.commit-notify': 30_000,
  // Session-start materialize fires once at boot. The host streams the whole
  // workspace bundle as a raw octet-stream body and the runner drains it to a
  // temp file (BUG-W3). This is a single in-flight transfer whose duration
  // scales with workspace size, so the per-attempt ceiling must cover streaming
  // a large (aged) bundle to disk — NOT just a quick request. 120 s matches the
  // client's default 2-min retry-series budget so one boot gets a full window to
  // stream; capping this at the old 30 s would just relocate the BUG-W3 boot
  // crash from "response too large" to "timeout" on a sufficiently large bundle.
  'workspace.materialize': 120_000,
  'session.next-message': 30_000,
  // Runner-boot config fetch. Synchronous, small payload (a few KiB at
  // most). 5 s is generous; if the host can't answer this fast something
  // bigger is wrong and the runner should fail-fast rather than retry.
  'session.get-config': 5_000,
  // Phase C: runner stamps the SDK's session_id onto the conversation row
  // so the next boot can resume() instead of replay. Tiny payload, single
  // indexed UPDATE host-side. 5 s is generous — fail-fast beats retry.
  'conversation.store-runner-session': 5_000,
  // Phase 2 (attachments): runner fetches attachment bytes from the host
  // workspace to translate ContentBlock[] into Anthropic image/document
  // blocks before yielding to the SDK. Payload is a single workspace path;
  // response is the file bytes base64-encoded. 10 s is generous for any
  // attachment file a user could plausibly upload within a single turn.
  'workspace.read': 10_000,
});

/** The closed set of sandbox→host RPC action names. */
export type IpcActionName = keyof typeof IPC_TIMEOUTS_MS;
