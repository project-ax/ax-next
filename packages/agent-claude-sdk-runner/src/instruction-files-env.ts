// ---------------------------------------------------------------------------
// Never load instruction files from the CLI's config dir (TASK-1217).
//
// The pinned `claude` CLI (2.1.119, SDK 0.2.119) reads three kinds of
// instruction file from $CLAUDE_CONFIG_DIR: `CLAUDE.md`, `rules/*.md`, and
// auto-memory `projects/<cwd-slug>/memory/MEMORY.md` (auto memory is on by
// default). It puts them in the model's context framed as the user's own
// private instructions.
//
// The agent's shell can write all three. CLAUDE_CONFIG_DIR is outside the
// agent's home, but the shell runs as the same user as the CLI, so nothing
// stops a `printf … >> "$CLAUDE_CONFIG_DIR/CLAUDE.md"`.
//
// Measured on the pinned binary, in the runner's configuration:
//   - A mid-session write is NOT re-read per request or per turn.
//   - It IS re-read after compaction. Text that an injected tool output had
//     the agent write would come back after the compaction that dropped the
//     tool output itself, now framed as the user's instructions.
//   - With CLAUDE_CODE_DISABLE_CLAUDE_MDS=1, none of the three loads, at
//     session start or after compaction. The switch sits in the CLI's
//     user-context builder, and auto-memory MEMORY.md is loaded through that
//     same list. With a custom string system prompt (main.ts always passes
//     one) the CLI adds no auto-memory section of its own, so
//     CLAUDE_CODE_DISABLE_AUTO_MEMORY is not needed as well.
//
// AX composes its own system prompt and writes no CLAUDE.md, rules or
// MEMORY.md, so this removes nothing AX uses.
//
// Keep it on every CLI bump, and re-run the real-binary e2e that pins it
// (`config-dir-mid-session-real-sdk.e2e.test.ts`).
//
// Capability minimization (invariant #5): this only removes a CLI feature. It
// adds no reach.
//
// Ordering contract: main.ts spreads buildInstructionFilesEnv() right after
// ...buildBundledSkillsEnv(), which is after ...proxyStartup.providerEnv, so
// it is part of the same non-negotiable FLOOR. The var is not in
// proxy-startup's ENV_ALLOWLIST, but a credential slot whose value is an
// `ax-cred:` placeholder rides through under any name; the placement makes
// sure such a slot can't switch the loading back on.
// ---------------------------------------------------------------------------

/**
 * Env var that stops the CLI loading `CLAUDE.md`, `rules/*.md` and
 * auto-memory `MEMORY.md` from its config dir, at session start and after
 * compaction. Pure and constant: takes no input and returns a fresh object
 * each call. Spread right after `...buildBundledSkillsEnv()` in the main.ts
 * SDK `query()` env literal (a floor, not an overridable default).
 */
export function buildInstructionFilesEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  };
}
