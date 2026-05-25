// ---------------------------------------------------------------------------
// Per-turn commit / re-sync decision trace (opt-in).
//
// The turn-commit pipeline — flush-wait → commitTurnAndBundle →
// workspace.commit-notify → (concurrent-writer) resync+replay — is otherwise
// only observable on FAILURE (the `runner: …` stderr lines). When a turn is
// silently NOT persisted (empty diff, a flush-wait that returned too early, a
// resync that absorbed the turn), there was no trace at all — which is exactly
// why TASK-11 (a tool turn's closing text dropped from its per-turn commit)
// could not be diagnosed without a cluster rebuild + added logging.
//
// `commitTrace` surfaces the SUCCESS / decision path too, gated behind
// AX_COMMIT_TRACE so it costs nothing and adds no log noise by default. Set
// AX_COMMIT_TRACE=1 (or `true`) in the runner pod env to capture the full
// trace when chasing a transcript-persistence bug. Callers pass a fully-formed
// line including the `[commit-trace] ` prefix and trailing newline.
// ---------------------------------------------------------------------------

const ENABLED =
  process.env.AX_COMMIT_TRACE === '1' || process.env.AX_COMMIT_TRACE === 'true';

export function commitTrace(line: string): void {
  if (ENABLED) process.stderr.write(line);
}
