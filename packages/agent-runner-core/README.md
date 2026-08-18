# @ax/agent-runner-core

Loop-agnostic runner machinery: everything a runner binary does that is *not*
the agent loop itself. Workspace materialize/commit/bundle, the transcript
delta protocol, uploads, the skills projection, proxy bootstrap, prompt
composition, and the tool policy all live here. It is shared by
`@ax/agent-claude-sdk-runner` today and is designed to be shared by a future
`@ax/agent-aisdk-runner` without either runner reimplementing this half.

Design source of truth: `docs/plans/2026-08-18-provider-agnostic-runner-design.md`.

## The one hard rule

**This package must never import `@anthropic-ai/claude-agent-sdk`.** Anything
that only makes sense against that SDK — its jsonl transcript layout, its
`query()` options shape, its `CLAUDE_CONFIG_DIR` project-symlink convention —
belongs in `@ax/agent-claude-sdk-runner`, not here. That is enforced
mechanically, not just by convention: see
`src/__tests__/no-sdk-dependency.test.ts`, which fails the build if any file
under `src/` imports or requires the SDK package, or if it appears in
`package.json`'s `dependencies`.

## The three seams

A runner is built by wiring three things through this package:

- **`ToolPolicy`** (`tool-policy.ts`) — the pre/post tool-call policy shared
  by both runners: re-roots governed paths, adjudicates each call against the
  host's `tool.pre-call` hook (fail-closed — an IPC failure denies), and
  drains egress notes on `postToolUse`. The Claude SDK's `PreToolUse` hook and
  a future aisdk runner's per-tool `execute` wrapper are both expected to be
  thin adapters over this one policy.

- **`TranscriptSource`** (`transcript-delta.ts`) — hides where transcript
  bytes actually live. Two methods: `locate(sessionId)` returns the absolute
  path to the transcript bytes (or `null` if none exist yet), and
  `write(sessionId, bytes)` persists reconstructed bytes on resume. Core never
  names the destination itself — the SDK-backed implementation
  (`createJsonlTranscriptSource`) writes into the SDK's private
  `.claude/projects/<slug>/` layout; a runner that owns its own message
  format can implement the same two methods however it likes. The delta-ship
  protocol on top (`shipTranscriptDelta` / `restoreTranscriptForResume`,
  prefix-hash integrity check, resync-on-mismatch) is identical either way.

- **`Loop`** / **`RunnerSeams`** (`run-runner.ts`) — the boot shell's
  extension points. `runRunner(makeLoop, seams)` owns the entire boot
  sequence (env, proxy, skills materialize, IPC handshake, workspace
  materialize, tool catalog, F2a resume guard, system prompt, and the final
  flush/chat-end/exit-code contract) and calls back into a runner-supplied
  `Loop` only for the parts that are genuinely provider-shaped: pumping
  messages through the model and turning its output into `StreamChunk`s.
  `RunnerSeams` covers the handful of boot-path details that are SDK-flavored
  without being loop logic — `afterMaterialize` (SDK-private scaffolding run
  once materialize succeeds, e.g. the `.claude/projects` symlink) and
  `supportsDocumentBlocks` (a per-provider capability flag) — so that
  SDK-shaped work stays out of core's boot path even when it has to run
  before the loop exists.

## Package layout note: `exports` subpaths

`package.json` declares an `exports` map with `"."` (the public barrel,
`index.ts`) plus several `./internal/*.js` subpaths (`git-workspace.js`,
`python-venv.js`, `inbox-loop.js`, `transcript-delta.js`). These are **not** a
second public API — they exist purely so `@ax/agent-claude-sdk-runner`'s
`main.test.ts` can `vi.mock` a specific internal module by its real resolved
identity. Because `run-runner.ts` imports its siblings by relative path, a
mock registered against the `"."` barrel is never reached; the internal
subpath gives the test the same module identity `run-runner.ts` actually
imports. Treat this surface as test-only plumbing, not something external
callers should import from directly.

## Testing

```bash
pnpm --filter @ax/agent-runner-core test
```
