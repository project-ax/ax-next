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
  // Commit-notify re-sync: the runner fetches the baseline bundle AT the
  // storage tier's advanced head (the `actualParent` from a parent-mismatch
  // re-sync signal) as a raw octet-stream body and drains it to a temp file,
  // then rebases its turn onto it (same binary path as materialize). Like
  // materialize, this is a single in-flight transfer whose duration scales with
  // workspace size, so it shares the 120 s ceiling — capping it lower would
  // relocate the very "response too large"-class failure this action fixes into
  // a timeout on a sufficiently large/aged baseline bundle.
  'workspace.export-baseline-bundle': 120_000,
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
  // TASK-68 (out-of-git Part C): runner-side blob store callers.
  //
  // `blob.put` — the runner streams an artifact's bytes (up to 100 MiB) to the
  // host's content-addressed store as a raw octet-stream REQUEST body (the
  // REQUEST-direction binary channel; mirror of materialize's response
  // direction). Duration scales with the artifact size, so the per-attempt
  // ceiling matches materialize's 120 s — capping it lower would relocate a
  // large-artifact transfer into a timeout. Idempotent (content-addressed), so
  // a retry re-stores identical bytes harmlessly.
  'blob.put': 120_000,
  // `blob.get` — the runner fetches a stored blob's bytes back as a raw
  // octet-stream RESPONSE body (drained to a temp file, same path as
  // materialize), to materialize `/ephemeral/uploads` at session start. Scales
  // with the blob size; shares the 120 s ceiling.
  'blob.get': 120_000,
  // `artifact.publish` — after `blob.put` succeeds the runner posts the small
  // metadata envelope so the host inserts the artifact row. Tiny JSON payload,
  // single indexed insert host-side. 10 s is generous.
  'artifact.publish': 10_000,
  // `attachments.list` — runner-boot enumerate of the bound conversation's
  // uploads (path + sha256 + display metadata) so it can pull each blob and
  // materialize `/ephemeral/uploads`. Small JSON response (one row per upload).
  // 10 s is generous for a single conversation's upload set.
  'attachments.list': 10_000,
  // TASK-67 (out-of-git Part B / B2): resume-transcript callers.
  //
  // `session.append-transcript` — the per-turn delta: a few new jsonl lines as
  // a small JSON body + an integrity hash. Single indexed multi-row INSERT
  // host-side. 10 s is generous; a turn that can't ship in 10 s has a bigger
  // problem than the transcript.
  'session.append-transcript': 10_000,
  // `session.replace-transcript` — the rare resync path: the runner streams the
  // WHOLE jsonl as a raw octet-stream REQUEST body (the SDK rewrote earlier
  // bytes). Duration scales with the transcript size, so the per-attempt ceiling
  // matches materialize's 120 s — capping it lower would relocate a large-
  // transcript transfer into a timeout. Idempotent (whole-file replace).
  'session.replace-transcript': 120_000,
  // `session.get-transcript` — resume read: the host joins the rows and streams
  // the reconstructed jsonl back as a raw octet-stream RESPONSE body (drained to
  // a temp file, same path as materialize). Scales with transcript size; shares
  // the 120 s ceiling.
  'session.get-transcript': 120_000,
  // TASK-74 (out-of-git Part D): `skill.propose` — the runner posts a structurally
  // validated skill bundle (manifest + body + ≤512 KiB of extra files) as a small
  // JSON envelope; the host gates + stores it (DB row + blob). Bounded payload, a
  // few indexed writes + a blob put host-side. 30 s covers the optional LLM safety
  // scan the `skills:scan` subscriber may run before the gate classifies.
  'skill.propose': 30_000,
});

/** The closed set of sandbox→host RPC action names. */
export type IpcActionName = keyof typeof IPC_TIMEOUTS_MS;
