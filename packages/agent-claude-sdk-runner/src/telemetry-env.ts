// ---------------------------------------------------------------------------
// Telemetry / phone-home kill switch for the SDK subprocess (TASK-55).
//
// The pinned Claude Agent SDK (@anthropic-ai/claude-agent-sdk 0.2.119) ships a
// vendored `claude` CLI binary that emits operational telemetry by POSTing to
//   https://http-intake.logs.us5.datadoghq.com/api/v2/logs
// (and a sibling error-reporting channel). We don't want the agent phoning
// home — and in a JIT/open-mode session the credential-proxy egress wall
// (TASK-37) has no allowlist entry for datadoghq.com, so that phantom traffic
// raised a reactive "Allow access to datadoghq.com?" card EVERY session, pure
// noise unrelated to the user's task. Surfaced by the TASK-47 JIT happy-path
// walk.
//
// The fix is to disable telemetry at the source rather than allowlist the
// host. Verified against the pinned 0.2.119 binary (not guessed): the datadog
// initializer bails before any network init when the SDK's traffic mode is
// anything other than "default":
//   initializeDatadog: `if (rU()) return (datadogEnabled = false);`
//   rU()  = USE_BEDROCK || USE_VERTEX || USE_FOUNDRY || trafficMode() !== "default"
//   trafficMode():
//     - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set -> "essential-traffic"
//     - DISABLE_TELEMETRY set                        -> "no-telemetry"
//     - DO_NOT_TRACK truthy                          -> "no-telemetry"
//     - else                                         -> "default"
// So ANY of those flags skips datadog init entirely → zero telemetry egress;
// trackDatadogEvent then early-returns and never POSTs. DISABLE_ERROR_REPORTING
// is the sibling switch for the crash/error-reporting channel (also suppressed
// by the "essential-traffic" mode, set redundantly here for clarity).
//
// We set all three for defense-in-depth and readable intent:
//   - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 — the umbrella opt-out. This is
//     exactly the flag Anthropic's own docs use in their devcontainer.json
//     example to "opt out of all non-essential traffic". It is the strongest,
//     most-documented kill switch and the load-bearing one.
//   - DISABLE_TELEMETRY=1       — per-channel telemetry opt-out.
//   - DISABLE_ERROR_REPORTING=1 — per-channel error-reporting opt-out.
// Belt-and-suspenders: if a future SDK splits the single gate into per-channel
// gates, all three channels stay off.
//
// Capability minimization (invariant #5): this is a NET-NEGATIVE egress change
// — it removes an outbound connection the agent had no business making. It adds
// no capability. The only network the SDK should reach is api.anthropic.com via
// the credential proxy.
//
// Ordering contract: main.ts spreads buildTelemetryEnv() AFTER
// ...proxyStartup.anthropicEnv in the query() env literal, so these flags are a
// non-negotiable security FLOOR that wins on any conflict — UNLIKE the tty-hints
// (buildTtyHintEnv), which are spread first as overridable defaults. None of
// these three vars is in proxy-startup's ENV_ALLOWLIST today, so anthropicEnv
// can't carry them anyway; the after-spread is defense-in-depth against a future
// allowlist change accidentally forwarding (and thereby clobbering) one of them.
// ---------------------------------------------------------------------------

/**
 * Env vars that disable the SDK CLI's telemetry / error-reporting phone-home
 * (notably the datadoghq.com egress). Pure + constant — takes no input, returns
 * a fresh object each call. Spread AFTER `...proxyStartup.anthropicEnv` in the
 * main.ts SDK `query()` env literal so the flags can't be overridden (security
 * floor, not an overridable default).
 */
export function buildTelemetryEnv(): Record<string, string> {
  return {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}
