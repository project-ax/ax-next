# TASK-55 — Disable agent-SDK telemetry egress (datadoghq.com) in the runner

**Path: (a) DISABLE — set the SDK's telemetry-disable env flags in the runner so the
agent never phones home to `datadoghq.com`. No `datadoghq.com` allowlist entry.**

## Problem

The pinned Claude Agent SDK 0.2.119 ships a vendored `claude` CLI binary (Claude Code
2.1.119). That binary emits operational telemetry by POSTing to
`https://http-intake.logs.us5.datadoghq.com/api/v2/logs` (binary fn `Vn8` flushing
`trackDatadogEvent`/`kn8` events, gated by `initializeDatadog`/`LfK`). In a JIT/open-mode
session the credential-proxy egress wall (TASK-37) has no allowlist entry for
`datadoghq.com`, so it raises a reactive "Allow access to datadoghq.com?" card **every
session** — phantom egress noise unrelated to the user's task.

We don't want the agent phoning home at all. So: disable it at the source.

## Mechanism (verified against the pinned SDK 0.2.119, not guessed)

In the vendored binary:
- `LfK` (initializeDatadog) returns early `if(rU())return NB$=!1,!1;` — datadog never
  initializes, so every `trackDatadogEvent` early-returns and nothing is POSTed.
- `rU() = USE_BEDROCK || USE_VERTEX || USE_FOUNDRY || dT8()`
- `dT8() = ha6() !== "default"`
- `ha6()` (the bridge.mjs `Uf()` twin) resolves the traffic mode:
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set → `"essential-traffic"`
  - `DISABLE_TELEMETRY` set → `"no-telemetry"`
  - `DO_NOT_TRACK` truthy → `"no-telemetry"`
  - else → `"default"`

So **any** of those env flags makes `rU()` true → datadog init is skipped → zero
telemetry egress. Error reporting (`DISABLE_ERROR_REPORTING`, and also gated by the
`essential-traffic` mode via `UK()`) is the sibling phone-home channel.

Grounded in Anthropic's own docs (code.claude.com): the devcontainer.json example sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"` as the umbrella opt-out of all
non-essential traffic.

## Approach

Mirror the existing env-helper pattern (`tty-hint-env.ts`, `tool-cache-env.ts`,
`home-bin-env.ts`): a pure function returning `Record<string,string>`, spread into the
`query({ options: { env } })` literal in `main.ts`, with its own unit test.

Spread **after** `...proxyStartup.anthropicEnv` so the flags are a non-negotiable
security floor (unlike tty-hints, which are deliberately overridable). None of these
three vars are in proxy-startup's `ENV_ALLOWLIST`, so anthropicEnv can never carry them
today — the after-spread is defense-in-depth for a future change.

This is an **internal implementation** change to one plugin: no new hook surface, no
IPC action, no payload field. No boundary review needed. It is a sandbox-boundary
(egress) change → security-checklist required.

## Tasks (independent, testable)

### Task 1 — `telemetry-env.ts` helper + unit test (TDD)
- New file `packages/agent-claude-sdk-runner/src/telemetry-env.ts`:
  ```ts
  export function buildTelemetryEnv(): Record<string, string> {
    return {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    };
  }
  ```
  Header comment explaining the datadog phone-home, the verified gate chain, why all
  three flags, and the after-spread ordering contract — following the
  `tty-hint-env.ts` comment style (security rationale, ordering contract).
- `src/__tests__/telemetry-env.test.ts`: asserts the returned object has exactly the
  three keys each set to `'1'`. This is the regression guard against silent drift if
  someone trims the flags.

### Task 2 — wire into the `query()` env literal in `main.ts`
- Import `buildTelemetryEnv`.
- Spread `...buildTelemetryEnv()` into the env literal AFTER `...proxyStartup.anthropicEnv`
  (and it doesn't matter relative to HOME/cache/venv/home-bin since the keys don't
  collide — but place it right after anthropicEnv with a comment so the "security floor"
  intent is visible).

### Task 3 — regression test: the runner spawns the SDK with telemetry disabled
The dispatch explicitly requires "a test that asserts the runner spawns the agent with
telemetry disabled (so a regression that re-enables the phantom egress is caught)."

main.ts is hard to unit-test in full (it boots IPC, proxy, query loop). The honest,
durable assertion is: **the env object handed to `query()` includes the disable flags.**
Approach: a focused test that builds the same env literal the way main.ts does and
asserts the telemetry flags are present and win over a hostile anthropicEnv override.
- Prefer extracting the env-literal assembly into a tiny pure helper if main.ts already
  has one; if not, the `telemetry-env.test.ts` floor + an assembly test that composes
  `{ ...anthropicEnv, ...buildTelemetryEnv() }` and asserts the flags survive a
  conflicting `anthropicEnv` is the regression guard. (Check main.ts first; do NOT
  refactor main.ts's whole literal just for testability — keep the change small.)

## YAGNI pass
- Three flags vs one: keep all three — load-bearing (per-channel kill switch + survives
  a future SDK that splits the gate). Cheap, documents intent.
- NOT adding DISABLE_AUTOUPDATER/DISABLE_UPDATES: dead weight for this card (not
  telemetry; sandbox CLI is immutable). Cut.
- NOT touching the egress allowlist / credential-proxy: that's path (b), explicitly
  rejected.

## Gate
`pnpm install` (worktree has no node_modules) → `pnpm -F @ax/agent-claude-sdk-runner build`
→ `pnpm -F @ax/agent-claude-sdk-runner test` → `pnpm build` + `pnpm test` (whole-branch;
expect the known env-only git-lfs reds in git-workspace.test.ts — verify they're not mine)
→ `pnpm lint`.
