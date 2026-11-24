// ---------------------------------------------------------------------------
// No background tasks in the CLI (TASK-1217).
//
// The pinned `claude` CLI (2.1.119, SDK 0.2.119) can run a Bash command in the
// background in two ways, measured in the runner's configuration:
//   - the model asks for it (`run_in_background: true`);
//   - the CLI moves it there on its own when it outlives its `timeout`
//     (default 2 minutes). That applies to any command whose first word isn't
//     `sleep`.
// Either way, when the command finishes the CLI sends itself a
// `<task-notification>` and wakes the model for a turn that no person and no
// routine asked for, about 2 s later. The runner stays warm between turns, so
// that turn runs.
//
// With CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (measured):
//   - the Bash tool's schema has no `run_in_background`, and a call that sends
//     it anyway gets an `InputValidationError`;
//   - a command past its timeout is killed (exit 143) instead of moved;
//   - no unprompted turn happens.
// A model that needs a long command can pass a longer `timeout` (up to the
// agent's turn limit when the host sent one — main.ts sets
// BASH_MAX_TIMEOUT_MS from it; the CLI's own 10-minute cap otherwise), or
// start it with a shell `&` and Read its output later. Neither wakes the
// model.
//
// Interrupts are unaffected: Bash has no interrupt→background path in 2.1.119
// (only explicitly asked for, and moved at timeout).
//
// This does not stop work from running later (a shell `(sleep N; …) &` still
// does). It stops the CLI from starting a turn about it.
//
// Capability minimization (invariant #5): this only removes a CLI feature. It
// adds no reach.
//
// Ordering contract: main.ts spreads buildBackgroundTasksEnv() right after
// ...buildInstructionFilesEnv(), in the same non-negotiable FLOOR after
// ...proxyStartup.providerEnv. The var is not in proxy-startup's
// ENV_ALLOWLIST, but a credential slot whose value is an `ax-cred:`
// placeholder rides through under any name; the placement makes sure such a
// slot can't switch background tasks back on.
// ---------------------------------------------------------------------------

/**
 * Env var that switches off the CLI's background tasks: no
 * `run_in_background`, no moving a command to the background at its timeout,
 * and so no `<task-notification>` turns. Pure and constant: takes no input
 * and returns a fresh object each call. Spread right after
 * `...buildInstructionFilesEnv()` in the main.ts SDK `query()` env literal (a
 * floor, not an overridable default).
 */
export function buildBackgroundTasksEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
}
