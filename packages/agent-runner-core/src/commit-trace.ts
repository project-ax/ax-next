// ---------------------------------------------------------------------------
// Per-turn transcript-persistence trace (opt-in).
//
// The turn-end persistence path — the loop's `beforeTranscriptShip` wait for
// its own delayed transcript write → `shipTranscriptDelta` (or the whole-file
// resync) → the once-only runner-session bind — is otherwise only observable
// on FAILURE (the `runner: …` stderr lines). When a turn's transcript is
// silently NOT persisted (a wait that returned too early, a delta that shipped
// nothing), there is no trace at all — which is exactly why TASK-11 (a tool
// turn's closing text dropped from what was persisted) could not be diagnosed
// without a cluster rebuild + added logging.
//
// `commitTrace` surfaces the SUCCESS / decision path too, gated behind
// AX_COMMIT_TRACE so it costs nothing and adds no log noise by default. Set
// AX_COMMIT_TRACE=1 (or `true`) in the runner pod env to capture the full
// trace when chasing a transcript-persistence bug. Callers pass a fully-formed
// line including the `[commit-trace] ` prefix and trailing newline. (The name
// predates TASK-995, when the same trace also covered a per-turn file commit;
// it is kept so the env var, which the sandbox bootstrap allowlist passes
// through, stays the same.)
// ---------------------------------------------------------------------------

export function commitTrace(line: string): void {
  // Warm processes import this module before their assignment arrives.
  if (process.env.AX_COMMIT_TRACE === '1' || process.env.AX_COMMIT_TRACE === 'true') process.stderr.write(line);
}
