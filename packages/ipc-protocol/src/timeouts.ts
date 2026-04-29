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
  'session.next-message': 30_000,
  // Runner-boot config fetch. Synchronous, small payload (a few KiB at
  // most). 5 s is generous; if the host can't answer this fast something
  // bigger is wrong and the runner should fail-fast rather than retry.
  'session.get-config': 5_000,
  // Runner-boot history replay (Task 15 of Week 10–12). Reads turns rows
  // for the bound conversation; the host's `conversations:get` already
  // bounds the row count via storage limits. 30 s gives a long
  // conversation room to deserialize without us needing per-turn
  // streaming on this RPC.
  'conversation.fetch-history': 30_000,
});

/** The closed set of sandbox→host RPC action names. */
export type IpcActionName = keyof typeof IPC_TIMEOUTS_MS;
