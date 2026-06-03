import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// TASK-145 — test-scoped scratch-dir teardown that survives the ENOTEMPTY rmdir
// race on a bare git mirror's `info/` dir.
//
// `flush-workspace-host.e2e.test.ts` stands up a REAL bare git mirror under a
// per-test scratch dir and removes the whole tree in `afterEach`. git's
// `gc.autoDetach` defaults to TRUE, so a push/fetch/receive-pack against that
// mirror can spawn a `git gc --auto` that DETACHES into a background process and
// keeps writing into `mirror.git/info` (`update-server-info` writes `info/refs`;
// gc packs refs) AFTER the foreground git command the test awaited has exited.
// If teardown's recursive `fs.rm` `rmdir`s `mirror.git/info` while that detached
// writer is mid-write, the directory is momentarily non-empty → `ENOTEMPTY`.
//
// `fs.rm({ force: true })` does NOT retry ENOTEMPTY/EBUSY — `force` only
// suppresses a "path does not exist" error. Node's `maxRetries` + `retryDelay`
// are what enable the documented backoff-retry loop that rides out the transient
// race: by the time it retries, the detached writer has finished and the dir is
// empty.
//
// HARNESS-ONLY: this is purely a test-cleanup concern. Production never `fs.rm`s
// a live workspace mirror — the host mirror lives in long-lived storage and the
// runner's `commit-notify-resync.ts` paths are all awaited (no fire-and-forget).
// So this hardening is scoped to test teardown and changes no runner behaviour.
// ---------------------------------------------------------------------------

const RM_SCRATCH_OPTS = {
  recursive: true,
  force: true,
  // ~10 attempts with an escalating backoff (Node multiplies retryDelay by the
  // attempt number) comfortably outlasts a detached git write into info/.
  maxRetries: 10,
  retryDelay: 25,
} as const;

/** Recursively remove a test scratch dir, tolerating the detached-git rmdir race. */
export async function rmScratch(dir: string): Promise<void> {
  await fs.rm(dir, RM_SCRATCH_OPTS);
}
