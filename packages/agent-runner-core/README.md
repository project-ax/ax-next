# @ax/agent-runner-core

Loop-agnostic runner machinery: everything a runner binary does that is *not*
the agent loop itself. The transcript delta protocol, uploads, the skills
projection, proxy bootstrap, prompt composition, and the tool policy all live
here. It is shared by `@ax/agent-claude-sdk-runner` and
`@ax/agent-aisdk-runner`, so neither runner reimplements this half.

Design source of truth: `docs/plans/2026-08-18-provider-agnostic-runner-design.md`.

## The one hard rule

**This package must never import `@anthropic-ai/claude-agent-sdk`.** Anything
that only makes sense against that SDK — its jsonl transcript layout, its
`query()` options shape — belongs in `@ax/agent-claude-sdk-runner`, not here.
That is enforced mechanically, not just by convention: see
`src/__tests__/no-sdk-dependency.test.ts`, which fails the build if any file
under `src/` imports or requires the SDK package, or if it appears in
`package.json`'s `dependencies`.

One residual leak: `installed-skills.ts`'s `materializeInstalledSkillsFromEnv`
still reads the `CLAUDE_CONFIG_DIR` env var directly and throws if it's
unset — that's the SDK's own convention for where it expects skills to be
installed, carried into core as-is because this extraction's job is "no
behaviour change," not "no SDK-specific config left." Generalizing it behind
a config-dir seam both runners can supply is future work for the second
runner, not solved here.

## The three seams

A runner is built by wiring three things through this package:

- **`ToolPolicy`** (`tool-policy.ts`) — the pre/post tool-call policy shared
  by both runners: adjudicates each call, exactly as the model made it,
  against the host's `tool.pre-call` hook (fail-closed — an IPC failure
  denies), and drains egress notes on `postToolUse`. The Claude SDK's
  `PreToolUse` hook and the aisdk runner's per-tool `execute` wrapper are both
  thin adapters over this one policy.

- **`TranscriptSource`** (`transcript-delta.ts`) — hides where transcript
  bytes actually live. Two methods: `locate(sessionId)` returns the absolute
  path to the transcript bytes (or `null` if none exist yet), and
  `write(sessionId, bytes)` persists reconstructed bytes on resume. Core never
  names the destination itself — the SDK-backed implementation
  (`createJsonlTranscriptSource`) is rooted at `AX_TRANSCRIPTS_ROOT` when the
  sandbox stamps one (the SDK reaches it through a `$CLAUDE_CONFIG_DIR/projects`
  link), else at `$CLAUDE_CONFIG_DIR/projects`, using the SDK's private
  `<slug>/<sessionId>.jsonl` layout; a runner that owns its own message
  format can implement the same two methods however it likes. The delta-ship
  protocol on top (`shipTranscriptDelta` / `restoreTranscriptForResume`,
  prefix-hash integrity check, resync-on-mismatch) is identical either way.

- **`Loop`** / **`RunnerSeams`** (`run-runner.ts`) — the boot shell's
  extension points. `runRunner(makeLoop, seams)` owns the entire boot
  sequence (env, proxy, skills materialize, IPC handshake, uploads, tool
  catalog, F2a resume guard, system prompt, and the final
  transcript-ship/chat-end/exit-code contract) and calls back into a
  runner-supplied `Loop` only for the parts that are genuinely
  provider-shaped: pumping messages through the model and turning its output
  into `StreamChunk`s. `RunnerSeams` covers the handful of boot-path details
  that are SDK-flavored without being loop logic — `prepareSession`
  (SDK-private setup that must exist before the loop and before a resume
  restores its transcript, e.g. the link from `$CLAUDE_CONFIG_DIR/projects`
  to the transcripts root; a failure exits 2) and `supportsDocumentBlocks` (a
  per-provider capability flag) — so that SDK-shaped work stays out of core's
  boot path even when it has to run before the loop exists.

## Package layout note: `exports` subpaths

`package.json` declares an `exports` map with `"."` (the public barrel,
`index.ts`) plus several `./internal/*.js` subpaths (`python-venv.js`,
`inbox-loop.js`, `transcript-delta.js`). These are **not** a second public
API — they exist purely so the runners' tests (for example
`@ax/agent-claude-sdk-runner`'s `main.test.ts`) can `vi.mock` a specific
internal module by its real resolved identity. Because `run-runner.ts` imports its siblings by relative path, a
mock registered against the `"."` barrel is never reached; the internal
subpath gives the test the same module identity `run-runner.ts` actually
imports. Treat this surface as test-only plumbing, not something external
callers should import from directly.

## Testing

```bash
pnpm --filter @ax/agent-runner-core test
```
