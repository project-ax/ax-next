// ---------------------------------------------------------------------------
// Switch off the CLI's bundled skills that it lets us switch off (TASK-1207).
//
// The pinned `claude` CLI (2.1.119, SDK 0.2.119) ships skills inside the
// binary, on top of the ones AX installs under $CLAUDE_CONFIG_DIR/skills/.
// Measured in the runner's configuration (`tools` allowlist, `settingSources:
// ['user']`, telemetry floor, one AX skill installed), the model is told it
// can invoke: update-config, keybindings-help, simplify,
// fewer-permission-prompts, loop, claude-api, init, review, security-review,
// plus AX's own. `loop` is the dangerous one: its body says "Call CronCreate
// with:" and uses ScheduleWakeup for its dynamic mode. The `tools` allowlist
// keeps both out (TASK-1200), so an agent that follows it reports a schedule
// that never runs.
//
// Two env switches remove a bundled skill, measured on the pinned binary:
//   - CLAUDE_CODE_DISABLE_CRON=1 takes `loop` out of the init list and the
//     model's listing; `Skill({skill:'loop'})` then fails inside the CLI
//     ("Unknown skill: loop") before any hook runs. Its gate is
//     `!CLAUDE_CODE_DISABLE_CRON && flag("tengu_kairos_cron")`, and it covers
//     only cron things: the three Cron tools (already excluded), cron restore,
//     a cron tip, the interactive scheduler and dream's schedule mode.
//     It ALSO switches off the CLI's own headless scheduler, and that is the
//     part that is load-bearing for security (TASK-1207 review r3, measured
//     on the pinned binary in the runner's configuration). With the var
//     unset, the print path the SDK drives starts a scheduler that reads
//     `<cwd>/.claude/scheduled_tasks.json` and fires unprompted turns with the
//     prompts it finds there. `cwd` is the agent's durable, writable home, so
//     an agent could plant that file with Write or Bash and schedule its own
//     turns: no CronCreate call, no routine, no hold. The `tools` allowlist
//     does not stop it (the scheduler is not a tool). Measured: unset, a
//     past-due entry reached the model within ~2s of an idle session opening;
//     set, zero model calls. `cron-scheduler-real-sdk.e2e.test.ts` pins both.
//     This var is therefore what makes the rail row `builtins.cron-create`
//     ("Cannot schedule things with its built-in timer instead of a routine")
//     true. KEEP IT even if a future CLI drops the `loop` skill.
//   - CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL=1 takes `claude-api` out.
//
// Nothing switches off the rest (update-config, simplify, init, …). That is
// why pre-tool-use.ts refuses any `Skill` call whose name is not a folder in
// AX's projection (projected-skills.ts): those two layers together are the
// fix, and the allowlist also covers bundled skills a future CLI adds.
//
// Dead ends, measured so nobody re-tries them:
//   - `settings.skillOverrides: { loop: 'off' }` changes nothing; the CLI's
//     resolver is compiled to `return "on"`.
//   - The session `skills` allowlist exists only on the control-protocol
//     initialize request, and `query()` in SDK 0.2.119 never sends it.
//   - CLAUDE_CODE_ENTRYPOINT=local-agent drops every bundled skill, but it
//     also switches on the CLI's subprocess env scrub and MCP env allowlist,
//     and changes the API client id.
//   - Bare mode (CLAUDE_CODE_SIMPLE=1) drops AX's own skills too.
//
// Capability minimization (invariant #5): this only removes CLI features. It
// adds no reach. One of the features it removes (the cron scheduler) is reach
// the agent should never have had.
//
// Ordering contract: main.ts spreads buildBundledSkillsEnv() right AFTER
// ...buildTelemetryEnv(), which is after ...proxyStartup.providerEnv, so these
// are part of the same non-negotiable FLOOR: nothing forwarded can turn a
// skill back on. Neither var is in proxy-startup's ENV_ALLOWLIST today; the
// placement guards against a future allowlist change forwarding one.
// ---------------------------------------------------------------------------

/**
 * Env vars that switch off the CLI's bundled `loop` (cron-backed) and
 * `claude-api` skills, and the CLI's own cron scheduler (which would otherwise
 * run prompts planted in `<cwd>/.claude/scheduled_tasks.json`). The cron var is
 * load-bearing for the rail row `builtins.cron-create`; never drop it. Pure and constant: takes no input and returns a fresh
 * object each call. Spread right after `...buildTelemetryEnv()` in the main.ts
 * SDK `query()` env literal (a floor, not an overridable default).
 */
export function buildBundledSkillsEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
  };
}
