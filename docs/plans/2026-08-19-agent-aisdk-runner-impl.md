# `@ax/agent-aisdk-runner` — implementation plan (PR 3)

**Date:** 2026-08-19. **Design:** `docs/plans/2026-08-18-provider-agnostic-runner-design.md`
(rows 1–2 of its Sequencing table are merged: #395 the runner-core extraction,
#399 host-side runner + model selection). This is **row 3**.

**Gate:** the canary is green on **both** runners, and the new runner is loaded in the
CLI **and** the k8s preset (invariant 3 — the half-wired window opens and closes in
this PR).

---

## What already exists (do not rebuild)

- `@ax/agent-runner-core` owns everything that is not the loop. Three seams:
  - `Loop` / `runRunner(makeLoop, seams)` — `packages/agent-runner-core/src/run-runner.ts`.
  - `ToolPolicy` — `src/tool-policy.ts`. **The load-bearing seam.** One security
    policy, two runners.
  - `TranscriptSource` — `src/transcript-delta.ts`. The offset/`prefixHash`/resync
    protocol is core; the source is per-runner.
- `@ax/agents` already types `RunnerId = 'claude-sdk' | 'aisdk'` and validates against
  `SUPPORTED_RUNNERS` (which does **not** yet contain `'aisdk'`).
- `ChatOrchestratorConfig.runnerBinaries` is already a runner-id → path map, already
  fed by `resolveRunnerBinaries` (CLI) and `defaultRunnerBinaries()` (k8s preset).
- `parseModelRef` in `@ax/core` parses `provider/model-id`.

## Verified against the real packages (not the design doc, not training data)

| Claim in the design doc | Verified |
|---|---|
| `ai@7` ships `ToolLoopAgent` | ✅ `ai@7.0.70` (latest); exports `ToolLoopAgent`, `pruneMessages`, `stepCountIs`, `tool`, `jsonSchema`, `createProviderRegistry`, `modelMessageSchema` |
| `ai@7` peer-deps | `zod ^3.25.76 \|\| ^4.1.8` — the workspace already resolves `zod@3.25.76`, so no zod bump |
| two majors of `ai` in one workspace | `packages/channel-web` is on `ai@^6.0.134` (resolves 6.0.195). There is **no** `ai` entry in the root `pnpm.overrides`, so pnpm installs both majors side by side. Unlike the undici incident (`.claude/memory/mistakes.md`), the two copies never interoperate: v6 is browser/React (assistant-ui) inside `channel-web`, v7 is Node inside the sandbox runner, different processes, no shared global. **Task 0 asserts this stays true.** |
| `stopWhen` / `abortSignal` / `prepareStep` / `onStepStart` / `onStepEnd` / `onToolExecutionStart` / `onToolExecutionEnd` | ✅ all present on `ToolLoopAgentSettings` / `AgentCallParameters` |
| `@ai-sdk/anthropic` accepts explicit creds + custom `fetch` | ✅ `createAnthropic({ apiKey, baseURL, headers, fetch })` at 4.0.40. **`apiKey` defaults to `process.env.ANTHROPIC_API_KEY` if omitted — we always pass it explicitly (§6: no provider SDK doing its own auth discovery).** |

Two findings the design doc does not state, both load-bearing:

1. **`result.response.messages` carries only the LAST step's messages.** A turn that
   used a tool returns just the closing assistant message there. The full set is
   `(await result.steps).flatMap(s => s.response.messages)`. Getting this wrong
   silently drops every tool call and tool result from the transcript. (Probed
   against `ai@7.0.70` with `MockLanguageModelV4`.)
2. **The runner process itself has never before made a TLS call through the MITM
   proxy.** In bridge mode `setupProxy` installs a global undici `ProxyAgent`; in
   DIRECT mode (`AX_PROXY_ENDPOINT`, the subprocess sandbox) it does **not** — it
   only puts `HTTPS_PROXY` into the env it hands the SDK *subprocess*, and Node's
   global `fetch` ignores `HTTPS_PROXY`. The claude-sdk runner never noticed because
   its model call happens in a child process. The aisdk runner calls the model
   **in-process**, so it must build its own dispatcher from
   `proxyStartup.anthropicEnv.HTTPS_PROXY` + the MITM CA. See Task 4.

## Global constraints (violate one → the PR is wrong)

- **I₁ — one permission choke point.** Every tool's `execute` is
  `policy.preToolUse → run → policy.postToolUse`. No tool may be registered that
  bypasses the wrapper. A veto returns as a tool **result**, never a throw.
- **I₂ — inputs stay structured.** The value handed to `policy.preToolUse` is the
  model's object input, and the value handed to the executor is
  `verdict.updatedInput ?? input`. Re-rooting only works on real paths, so the
  builtin file tools keep Claude's field names (`file_path`, `path`,
  `notebook_path`) — `resolveGovernedPaths`' `PATH_INPUT_KEYS` is keyed on them.
- **I₃ — the `0555` projection under `$CLAUDE_CONFIG_DIR` is the SOLE skill-discovery
  path.** Never read `.claude/skills/` from the workspace; it is agent-writable.
- **I₄ — no MCP shims.** `host-mcp-server.ts` / `sandbox-mcp-server.ts` are not
  ported. `DISABLED_BUILTINS` becomes "not registered", not a deny list.
- **I₅ — no file on disk for the transcript.** Messages live in memory; the
  `TranscriptSource` serializes at the turn boundary. `waitForTranscriptUuid` and
  friends have no counterpart here — that race is deleted, not reimplemented.
- **I₆ — no provider SDK auth discovery.** Credentials are injected explicitly; the
  `ax-cred:<32-hex>` placeholder is the only key value this process ever holds.
- **I₇ — half-wired window closes in this PR.** `SUPPORTED_RUNNERS`, both binary
  maps, and the container image land together.
- **I₈ — verify build output, not just the diff** (the #397 lesson). The runner's
  `dist/main.js` must exist in the **built** tree and inside the container image.
  Corollary: **no `postbuild` script** — `tsc --build` does not run a referenced
  package's npm scripts, which is exactly how #397 shipped a phantom artifact.
- **I₉ — an assertion that can't fail isn't a test.** After writing a guard, delete
  or break the thing it guards and confirm the test goes red.

## Boundary review (for the PR description)

The one shared-surface change is `TranscriptSource` in `@ax/agent-runner-core`
(Task 1). It is a TypeScript seam inside a sandbox-side shared library, not a hook
payload and not an IPC action, so there is no wire surface. Recorded anyway:

- **Alternate impl:** the in-memory source this PR adds is the alternate impl — it is
  precisely why the seam stops being path-shaped.
- **Leak-prone names:** `locate()` returning a *filesystem path* was the leak (it
  presumes the transcript is a file). It becomes `read(): Promise<Buffer | null>`.
  `write()` returns `'accepted' | 'unusable'` — deliberately neutral vocabulary; core
  must not learn the words "jsonl", "header line", or "runner id".
- **Subscriber risk:** the only two implementors are in-repo and both change in this
  PR. No host-side subscriber sees this type.

No new hooks, no new IPC actions, no hook-payload field changes.

---

## Task list

Sequenced so the tool-policy wiring lands early — everything else depends on it.

### Task 0: package scaffold + dependency skew guard

`packages/agent-aisdk-runner/` with `package.json`, `tsconfig.json`,
`vitest.config.ts` copied in shape from `agent-claude-sdk-runner` — **minus the
`postbuild` chmod** (I₈; the binary is spawned as `node <path>`, so no exec bit is
needed, and a script `tsc --build` never runs is a trap). Deps: `ai@^7.0.70`,
`@ai-sdk/anthropic@^4.0.40`, `@ax/agent-runner-core`, `@ax/core`, `@ax/ipc-protocol`,
`@ax/skills-parser`, `@ax/tool-artifact-publish`, `@ax/tool-skill-propose`, `undici`
(pinned to the same range `@ax/agent-runner-core` uses).

`eslint.config.mjs`: the path-scoped `no-restricted-imports` exception is
`packages/agent-*-runner/**`, which **already** matches `agent-aisdk-runner`. Confirm
by running eslint on the new dir rather than by reading the glob. Update the header
comment to name the second runner.

Guard test: `ai` major skew. Assert the root `package.json` has no `ai` override and
that the new package's `ai` range is `^7`, with the reasoning inline. This is the
cheap version of the undici lesson — it fails loudly if someone later adds a
workspace-wide `ai` override that would drag one side across a major.

### Task 1: `TranscriptSource` stops being path-shaped (core)

`packages/agent-runner-core/src/transcript-delta.ts`:

```ts
export type TranscriptWriteOutcome = 'accepted' | 'unusable';
export interface TranscriptSource {
  read(sessionId: string): Promise<Buffer | null>;
  write(sessionId: string, bytes: Buffer): Promise<TranscriptWriteOutcome>;
}
```

- `shipTranscriptDelta` calls `source.read()` instead of `locate()` + `readFile()`.
  The `no-jsonl` outcome name is now wrong for a memory source; rename it
  `no-transcript` (single in-repo consumer: a `commitTrace` string).
- `restoreTranscriptForResume` returns `{ written: false }` when `write()` answers
  `'unusable'` — which routes straight into the **existing** F2a demote-to-fresh
  branch in `runRunner`. That is the whole mechanism behind the cross-runner
  demotion; no new branch is added to core.
- `packages/agent-claude-sdk-runner/src/jsonl-transcript-source.ts`: `read` =
  `locateJsonl` + `readFile` (null when absent); `write` unchanged, returns
  `'accepted'`. `locateJsonl` stays exported — `turn-end-uuid.ts` uses it.

Tests: core's `transcript-delta.test.ts` gains an `'unusable'` case asserting
`written:false`; the claude-sdk `jsonl-transcript-source.test.ts` covers `read`
returning null vs bytes.

### Task 2: the tool wrapper — one choke point

`src/tools/policy-wrap.ts`. `wrapWithPolicy(name, isBuiltin, run)` returns an
`execute` that does pre → run → post and:

- returns the **denial reason string as the tool result** on a veto (I₁),
- feeds `verdict.updatedInput ?? input` to `run` (I₂),
- appends `postToolUse`'s egress note to the output when one comes back,
- converts a thrown executor error into an error-shaped tool result rather than
  letting it abort the turn.

Tests first, and they are the tests that matter most in this PR:
- a veto produces a result whose text is the reason and **never** rejects,
- the executor receives the re-rooted input, not the raw input,
- a `tool.pre-call` IPC failure denies (fail-closed — inherited from the policy),
- the egress note is appended after a `Bash` call,
- **no tool in the registered set is reachable without the wrapper** — enumerate the
  built `tools` object and assert every entry's `execute` is wrapped (a marker
  symbol set by `wrapWithPolicy`). This is the assertion that keeps a future tool
  from being added on a bypass path.

### Task 3: the six built-ins

`src/tools/builtins.ts` — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, with
Claude-compatible names and input field names (I₂). All in-sandbox, all wrapped.

- `Bash`: `{ command, timeout?, description? }`, spawned via `execFile('bash',
  ['-lc', command])` with the loop's composed env (proxy env + venv + `$HOME/bin`
  appended, exactly as the claude-sdk loop builds it) and cwd = `deps.homeDir`.
  Bounded output (truncate with a marker), bounded timeout, non-zero exit returns
  stdout+stderr+exit code as a normal result.
- `Read`: `{ file_path, offset?, limit? }` — line-numbered text; binary/image files
  are returned as a short descriptor, not raw bytes.
- `Write`: `{ file_path, content }`. `Edit`: `{ file_path, old_string, new_string,
  replace_all? }` with the "must be unique unless replace_all" rule.
- `Glob`: `{ pattern, path? }`, `Grep`: `{ pattern, path?, glob?, -i?, -n? }` —
  implemented over Node's `fs.glob` / a bounded walk, no new dependency.

`AskUserQuestion`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite` are simply not
registered (I₄). Web capability is unaffected — `@ax/web-tools` arrives as host
tools.

### Task 4: provider construction + the in-process proxy fetch

`src/provider.ts`:

- `createProxyFetch(anthropicEnv)` — an undici `ProxyAgent` built from
  `anthropicEnv.HTTPS_PROXY`, carrying the `Proxy-Authorization` Basic token parsed
  out of the proxy URL's userinfo (mirroring `setupProxy`'s bridge-mode dispatcher,
  which deliberately does not rely on ProxyAgent's own userinfo parsing), and
  `requestTls.ca` read from `NODE_EXTRA_CA_CERTS ?? SSL_CERT_FILE` so the MITM leaf
  validates. No proxy configured → plain `fetch` (test/dev).
- `createProviderRegistry({ anthropic: createAnthropic({ apiKey: <placeholder>,
  fetch }) }, { separator: '/' })`. The registry parses `anthropic/claude-sonnet-4-6`
  natively; `parseModelRef` still gates the provider name so an
  `openrouter/...` ref fails **loudly at boot** with a message naming PR 4 rather
  than 404ing at the first token.
- Assert the placeholder shape `ax-cred:<32-hex>` before constructing the provider
  (the same defense-in-depth check `setupProxy` makes on the way in). A real
  `sk-ant-…` reaching this process is a capability leak, not a convenience.

Tests: placeholder is passed explicitly (never read from env by the provider); a
non-anthropic provider ref throws with a PR-4-naming message; the fetch routes
through the configured proxy; `ANTHROPIC_API_KEY` unset in `process.env` does not
change what is sent (proves no auth discovery).

### Task 5: host tools and sandbox tools from the catalog

`src/tools/host-tools.ts` / `src/tools/sandbox-tools.ts` — the same two dispatch
paths the MCP shims had, minus MCP:

- host: `flushWorkspaceBeforeCall` precondition gate (forward only on `accepted` /
  `noop`; otherwise a clear retryable tool error — port the BUG-W2 rationale
  verbatim), then `tool.execute-host`.
- sandbox: `localDispatcher.execute({ id, name, input })`.
- `inputSchema` comes from the descriptor's JSON Schema via `ai`'s `jsonSchema()`.
  Unlike the SDK's `z.object(shape)` path, this does **not** strip undeclared keys,
  so the `shapeFromInputSchema` workaround has no counterpart here — note it, and
  test that a key absent from the declared schema still reaches the executor.

Both wrapped by Task 2. Connector-backed MCP tools arrive through this path as
ordinary host tools (§3) — asserted, because it is the claim that keeps connectors
working on this runner.

### Task 6: skills without the SDK's `Skill` tool

`src/skills-index.ts`:

- At boot, walk `$CLAUDE_CONFIG_DIR/skills/*/SKILL.md` (I₃ — that projection only;
  never the workspace), parse each with `@ax/skills-parser`'s `parseSkillManifest` /
  `splitSkillMd`, and build `{ id, name, description, dir, hasMcpServers }`.
- A skill whose `SKILL.md` fails to parse is **skipped with a loud stderr line**, not
  silently dropped, and never aborts boot.
- Compose a compact `name — description` index appended to `deps.systemPrompt`,
  plus one sentence telling the model to call `Skill` to load a body.
- `hasMcpServers` is detected from the materialized `.mcp.json` **and** the manifest,
  logged once at projection time.

`src/tools/skill-tool.ts` — `Skill({ name })` returns the body + the bundle directory
path, wrapped by Task 2 like everything else. When the skill declares MCP servers the
response carries the unavailability note (§3/§5 of the prompt): the skill still loads,
and the note says its MCP servers are unavailable on this runner and the tools it
describes will not exist.

Tests assert the **degradation, not the capability**: a skill declaring `mcpServers`
loads, appears in the index, and its `Skill` response carries the note; an unknown
name returns a helpful error result (not a throw); the workspace `.claude/skills/`
dir is never read (plant a decoy there and assert it is absent from the index).

### Task 7: transcript codec + in-memory source

`src/transcript-codec.ts`:

- `encode(messages)` → header line `{"v":1,"runner":"aisdk"}` + one `ModelMessage`
  per line, `\n`-terminated.
- `decode(bytes)` → `{ ok: true, messages }` | `{ ok: false, reason }` where a
  missing/foreign/`v!==1` header, or any line failing `modelMessageSchema`, is a
  clean `ok:false`. Never throws on adversarial bytes — this parses a stored blob.

`src/memory-transcript-source.ts` — holds the array, `read()` returns
`encode(messages)` (or `null` before the first message), `write()` decodes and either
seeds the array (`'accepted'`) or answers `'unusable'`, which is the cross-runner
demotion (Task 1).

Line-orientation matters for the delta protocol: `sentOffset` must land on complete
lines, and a message must serialize to exactly one line — assert no raw `\n` survives
`JSON.stringify` of a multi-line tool result (it can't, but the assertion is what
keeps a future "pretty-print for debuggability" change from corrupting the protocol).

### Task 8: the loop

`src/main.ts` — `createAiSdkLoop(deps): Loop` + `main()` via `runRunner`.

Per turn: pull `ctx.nextMessage()`, translate to a `ModelMessage` (text, or the
provider content-block array attachment translation already produced), push onto the
array, `agent.stream({ messages })`, drain `fullStream` emitting
`ctx.emitChunk` for text / reasoning / tool-call / tool-result, then append
`(await steps).flatMap(s => s.response.messages)` to the array (the finding above),
and close with `ctx.endTurn({...})`.

- `readTurnId` is served from the in-memory array (a per-message id we mint), so the
  turn-end `turnId` contract holds without a disk read.
- `beforeCommit` is **omitted**: durability is a function return here (§5). Say so in
  a comment — its absence is the point, and a future reader must not "restore" it.
- `resumeSessionId !== null` → the shell already restored via the source; the loop
  mints a session id on a fresh start and reports it with
  `ctx.setTranscriptSessionId`.
- `agentConfig.runner` gets its first real reader: assert at boot that the session was
  configured for `'aisdk'`, and fail loudly otherwise. A mis-keyed `runnerBinaries`
  map would otherwise silently run the wrong harness under the operator's chosen
  runner id. (**Deviation from the prompt, flagged in the PR description:** the
  prompt expects `AgentConfig.runner` to drive the cross-runner demotion. It cannot —
  it is the frozen snapshot of the *current* agent's runner, not of whatever wrote the
  stored transcript, and those diverge exactly in the case the demotion exists for.
  The transcript header line is authoritative and drives the demotion. The
  orchestrator comment at `orchestrator.ts:1399` is rewritten to say this.)
- No compaction (PR 6/7). `stopWhen: stepCountIs(N)`; a long session may degrade.

`RunnerSeams`: `createTranscriptSource` → the memory source, `hasLocalTranscript` →
`false` (there is no local transcript — non-conversation sessions always start
fresh), `afterMaterialize` → **absent** (no SDK projects symlink to scaffold),
`supportsDocumentBlocks` → true for Anthropic via the AI SDK (verified against the
provider's accepted content parts, not assumed).

### Task 9: selection becomes reachable (the half-wired window)

- `packages/agents/src/store.ts`: `SUPPORTED_RUNNERS = ['claude-sdk', 'aisdk']`.
  Flip `store.test.ts`'s "rejects runner 'aisdk' until the binary ships (PR 3)" to
  the accepting assertion, and keep a negative case on a genuinely unknown id so the
  allow-list is still proven to reject.
- `packages/cli/src/main.ts` `resolveRunnerBinaries`: add the `'aisdk'` key.
  `AX_TEST_RUNNER_BINARY_OVERRIDE` / `runnerBinaryOverride` must override **both**
  ids — that is what lets the canary run twice against the stub.
- `presets/k8s/src/index.ts` `defaultRunnerBinaries()`: add the `'aisdk'` key.
- `@ax/cli` and `@ax/preset-k8s`: add the dependency + tsconfig reference, which is
  also what puts the binary in the container image (`pnpm --filter @ax/cli build`
  walks project references; `pnpm deploy --prod` copies prod deps). **Verify against
  the built tree and the image, not the diff** (I₈): assert `dist/main.js` exists
  after `pnpm build`, and add the runner to the existing image-asset packaging test
  rather than trusting `require.resolve`.
- `container/agent/Dockerfile`: header comments name both runners.

### Task 10: parity — the canary runs twice

`packages/cli/src/__tests__/chat-pipeline.e2e.test.ts` becomes
`describe.each(['claude-sdk', 'aisdk'])`, with the dev agents stub configured to the
runner under test and the binary map asserted per id. That proves the host-side
selection path end-to-end for both ids.

The stub runner replaces the real binary there, so the runner-side half of §8's parity
list is proven where it actually lives: a new
`packages/agent-aisdk-runner/src/__tests__/parity.e2e.test.ts` drives the **real**
`runRunner` + the **real** loop against a `MockLanguageModelV4` and a fake IPC client,
one assertion per checklist row:

workspace materialize → commit → bundle across turns · uploads + attachment
translation · installed-skill discovery and invocation · authored-skill proposal via
`skill.propose` · artifact publish · resume across turns and after a warm rebind ·
sandbox death mid-turn producing `chat:turn-error` · egress-block remediation notes ·
routine-triggered invocation · host tools and connector MCP tools from the catalog.

Where the claude-sdk runner already has an equivalent e2e
(`flush-workspace-host.e2e.test.ts`, `artifact-publish-e2e.test.ts`), mirror its
harness rather than inventing a second one.

### Task 11: README + documented non-parity

`packages/agent-aisdk-runner/README.md` and the PR description both carry:
`TodoWrite` absent · cross-runner resume demotes to fresh · SDK-specific setting
sources do not exist · skill-declared in-sandbox MCP servers unsupported and degrading
with an agent-visible note · no compaction yet (PR 6/7).

### Task 12: `security-checklist`

Required, not optional — this PR adds a sandbox-boundary component, a new
tool-execution path handling untrusted model output, and new third-party
dependencies. All three threat models fire. Output goes in the PR description.

---

## Final gate

`pnpm build` · `pnpm --filter @ax/agent-aisdk-runner test` ·
`pnpm --filter @ax/agent-claude-sdk-runner test` ·
`pnpm --filter @ax/agent-runner-core test` · `pnpm --filter @ax/agents test` ·
`pnpm --filter @ax/chat-orchestrator test` · `pnpm --filter @ax/cli test` ·
`pnpm --filter @ax/preset-k8s test` · `pnpm exec eslint <changed dirs>` ·
then the whole suite once with `pnpm -r --no-bail run test`.

`pnpm build` does **not** type-check `src/__tests__/**` (every package tsconfig
excludes it), so cross-package fixture changes only surface on the full `--no-bail`
run. Known-bad locally and not ours: `@ax/auth-better` (Docker) and the
`@ax/conversations` `events-store.test.ts` seq-race flake. CI's vitest fork-pool flake
(`Worker exited unexpectedly`, zero failing assertions) is rerun, not debugged; verify
green against the HEAD SHA via `gh api .../check-runs`, not `gh pr checks`.

## Deliberately out of scope

OpenRouter + Vertex credential paths and multi-provider `models:list-supported`
(PR 4/5) · compaction (PR 6/7) · cross-runner transcript translation (explicitly
rejected in §5) · `TodoWrite` · a `chat-qa-sweep` / `k8s-acceptance-loop` walk
(post-merge, per §8).
