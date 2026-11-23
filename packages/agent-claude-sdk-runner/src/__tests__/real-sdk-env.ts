/**
 * The test process's env minus anything that steers a Claude Code CLI. Run from
 * inside a Claude Code session (as builders do), the parent's `CLAUDECODE` /
 * `CLAUDE_CODE_*` flags reach the spawned CLI and change its built-in set
 * (measured: an agent-teams flag drops Monitor/PushNotification/RemoteTrigger
 * and lists ToolSearch at init), so DRIFT would measure the caller, not the SDK.
 * A parent `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` or `CLAUDE_CODE_ENTRYPOINT` would
 * also reroute or re-identify the CLI.
 *
 * Returns a NEW object and never mutates its input.
 */
export function stripClaudeCodeEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) continue;
    out[k] = v;
  }
  return out;
}
