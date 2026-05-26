# Week 4–6 — Real LLM + Tools + Sandbox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Each task is its own fresh subagent under `superpowers:subagent-driven-development`. Invoke `security-checklist` again whenever a task's files list includes `sandbox-subprocess`, `tool-bash`, `tool-file-io`, `llm-anthropic`, or IPC primitives in `@ax/core`.

**Goal:** Ship the first slice where real model output and real tool output flow through the hook bus — `@ax/llm-anthropic` + `@ax/tool-bash` + `@ax/tool-file-io` + `@ax/sandbox-subprocess`, behind an `ax.config.ts` loader, all exercised by a mocked-API smoke test.

**Architecture:** Follows `docs/plans/2026-04-22-plugin-architecture-design.md` Section 10 and the Week 4–6 handoff (`docs/plans/2026-04-23-week-4-6-handoff.md`). Tool dispatch goes through a thin `@ax/tool-dispatcher` that registers `tool:execute` and fans out to `tool:execute:<name>` sub-services (handoff decision 1a). Every bash `tool:execute:<name>` runs via `sandbox:spawn` — a subprocess-per-call for Week 4–6 (decision 2a). One LLM per config (no router — decision 3b). `ax.config.ts` replaces the hardcoded preset in `@ax/cli` (decision 4a). `ANTHROPIC_API_KEY` comes from env (decision 5a).

**Tech Stack:** TypeScript (strict), pnpm workspace, Node `child_process.spawn` (argv-array form, never shell-true) for the sandbox, `@anthropic-ai/sdk` for the LLM, `zod` for wire validation, `vitest` for tests.

**Branch:** Week 3 is merged to `main` (42bb4bf). Branch off `main` as `feat/week-4-6-real-llm`.

---

## Starting-state notes (read before Task 1)

While reading the current code I confirmed the three "kernel follow-up" items in the handoff are **already landed** on main:

- `classify()` in `packages/core/src/chat-loop.ts` already reads `err.hookName` — no regex to replace.
- `maxTurns` guard is already in `runChat()` (default 20, returns `max-turns-exceeded:<n>`).
- `detectCycles` in `bootstrap.ts` only detects cycles now; duplicate-producer detection is already its own `checkDuplicateRegisters` function.

**So the plan does not re-do them.** Task 0 below just double-checks this at branch-cut. If the handoff author expected more specific shapes (e.g., different naming), raise it before starting real work rather than silently rewriting done code. (Per memory rule: flag plan-vs-reality deviations, don't blindly follow.)

---

## Phase overview

| Phase | Tasks | Outcome |
|-------|-------|---------|
| 0 | Branch + sanity | Feature branch off main, kernel follow-ups confirmed done |
| 1 | IPC primitives in `@ax/core` | Length-prefixed framing + Zod wire validation available to sandbox |
| 2 | `@ax/sandbox-subprocess` | `sandbox:spawn` service hook; every tool call runs in a locked-down child |
| 3 | `@ax/tool-dispatcher` | Thin `tool:execute` → `tool:execute:<name>` fan-out |
| 4 | `@ax/tool-bash` | `tool:execute:bash`, argv-array spawn (no shell interpolation), via sandbox |
| 5 | `@ax/tool-file-io` | `tool:execute:read_file` / `write_file` with ported `safePath` |
| 6 | `@ax/llm-anthropic` | `llm:call` via `@anthropic-ai/sdk`, key from env |
| 7 | `ax.config.ts` loader in `@ax/cli` | Dynamic import, one LLM + sandbox per config |
| 8 | E2E acceptance | Mocked Anthropic API drives bash + file_io calls through the real kernel |
| 9 | Release | Changeset, security review note, PR |

**Commit discipline:** Each numbered task ends with a commit. Phases 4 and 5 can run in parallel once 2 + 3 are merged (no shared files). All other phases are sequential.

---

## Phase 0 — Branch + sanity

### Task 0.1: Cut the feature branch

**Step 1 — Verify clean tree:**

Run: `git status --short && git log -1 --oneline`
Expected: no staged changes other than the in-progress CLAUDE.md / memory edits already outside scope; HEAD at `42bb4bf` (or newer main).

**Step 2 — Create branch:**

```bash
git checkout -b feat/week-4-6-real-llm
```

**Step 3 — Grep-verify the three kernel follow-ups:**

```bash
grep -n "err.hookName" packages/core/src/chat-loop.ts
grep -n "maxTurns" packages/core/src/chat-loop.ts
grep -n "checkDuplicateRegisters\|detectCycles" packages/core/src/bootstrap.ts
```

Expected: all three match on current lines. If any do not, STOP and flag before writing new code — the handoff state drifted.

**Step 4 — Commit (empty, marks branch start):**

```bash
git commit --allow-empty -m "chore: start Week 4-6 real LLM + tools branch"
```

---

## Phase 1 — IPC primitives in `@ax/core`

Subprocess sandbox needs a wire format. Length-prefixed framing + Zod-validated message types, no host-side unbounded JSON parsing.

### Security checklist (re-invoke before starting)

- **Sandbox:** New code parses bytes from an untrusted child. Must bound frame size (hard cap, e.g., 4 MiB), reject partial / malformed frames without crashing, never pass raw Buffers to subscribers.
- **Injection:** The framing layer never interpolates bytes; downstream handlers parse validated JSON via Zod. Confirm no `Function`/`eval`/template-string interpolation.
- **Supply chain:** No new deps (zod is already in `@ax/core`). N/A with reason.

### Task 1.1: Wire message schemas

**Files:**
- Create: `packages/core/src/ipc/wire.ts`
- Create: `packages/core/src/ipc/__tests__/wire.test.ts`

**Step 1 — Write failing test** (`wire.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { WireRequestSchema, WireResponseSchema } from '../wire.js';

describe('wire schemas', () => {
  it('accepts a well-formed request', () => {
    const ok = WireRequestSchema.safeParse({
      id: '01JABC',
      action: 'tool:execute:bash',
      payload: { command: 'echo hi', args: [] },
    });
    expect(ok.success).toBe(true);
  });
  it('rejects unknown action shape', () => {
    const bad = WireRequestSchema.safeParse({ id: '1', action: 5, payload: {} });
    expect(bad.success).toBe(false);
  });
  it('response round-trips ok + err variants', () => {
    expect(WireResponseSchema.safeParse({ id: '1', ok: true, result: { stdout: '' } }).success).toBe(true);
    expect(WireResponseSchema.safeParse({ id: '1', ok: false, error: { code: 'timeout', message: 't' } }).success).toBe(true);
  });
});
```

**Step 2 — Run:** `pnpm test --filter @ax/core -- wire` → FAIL (module missing).

**Step 3 — Implement** (`wire.ts`):

```ts
import { z } from 'zod';

export const WireRequestSchema = z.object({
  id: z.string().min(1).max(64),
  action: z.string().min(1).max(128),
  payload: z.unknown(),
});
export const WireResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string().min(1).max(64), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string().min(1).max(64),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WireResponse = z.infer<typeof WireResponseSchema>;
```

**Step 4 — Run test, expect PASS.** Commit `feat(core): wire message schemas for IPC`.

### Task 1.2: Length-prefixed framer/parser

**Files:**
- Create: `packages/core/src/ipc/framing.ts`
- Create: `packages/core/src/ipc/__tests__/framing.test.ts`
- Modify: `packages/core/src/index.ts` — export `WireRequestSchema`, `WireResponseSchema`, `encodeFrame`, `FrameDecoder`.

**Design:** 4-byte big-endian length prefix, then UTF-8 JSON bytes. Hard cap: `MAX_FRAME = 4 * 1024 * 1024`. Decoder is a stateful object: `feed(chunk: Buffer): Frame[]` — returns zero or more completed frames, buffers partials, throws `PluginError({ code: 'invalid-payload', hookName: 'ipc' })` on oversize or malformed frame.

**Step 1 — Failing tests** covering:
- Single clean frame in, single frame out.
- Chunk split mid-prefix and mid-payload — recombines correctly.
- Two frames in one chunk — both emitted.
- Oversize-declared frame (prefix says 5 MiB) — throws before allocating.
- Empty chunk — no-ops.

**Step 2 — Run:** FAIL.

**Step 3 — Implement** (`framing.ts` ~60 LOC). Sketch:

```ts
export const MAX_FRAME = 4 * 1024 * 1024;
export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) throw new PluginError({ code: 'invalid-payload', plugin: 'core', hookName: 'ipc', message: `frame too large: ${body.length}` });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}
export class FrameDecoder {
  private buf = Buffer.alloc(0);
  feed(chunk: Buffer): unknown[] { /* accumulate, slice frames, JSON.parse each */ }
}
```

**Step 4 — Run test, expect PASS.** Commit `feat(core): length-prefixed IPC framing with size cap`.

### Task 1.3: Export IPC surface

**Files:** Modify `packages/core/src/index.ts` only.

Add:
```ts
export { WireRequestSchema, WireResponseSchema, type WireRequest, type WireResponse } from './ipc/wire.js';
export { encodeFrame, FrameDecoder, MAX_FRAME } from './ipc/framing.js';
```

Run `pnpm build` + `pnpm test --filter @ax/core`. Commit `feat(core): re-export IPC primitives`.

---

## Phase 2 — `@ax/sandbox-subprocess`

First real sandbox. Spawns a short-lived Node child for each tool call. The child loads ONLY the plugins that register `tool:execute:<name>` sub-hooks (bash, file-io). Host and child talk over stdin/stdout using Phase-1 framing.

### Security checklist (re-invoke)

- **Sandbox:**
  - Spawn uses Node `child_process.spawn` with an **argv array**, never `shell: true`, never user input in argv0.
  - `cwd` is the workspace root (from `ChatContext`).
  - `env` is scrubbed to an **allow-list**: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `NODE_OPTIONS=''` (empty, to disable `--require`), `ANTHROPIC_API_KEY` is NOT forwarded (LLM never runs in the sandbox).
  - Timeout: configurable, default 30s; child killed with SIGKILL on expiry.
  - stdout/stderr captured with a hard cap (default 1 MiB each); overflow → truncate + `error: 'stdout-overflow'`.
  - No inherited file descriptors: `stdio: ['pipe','pipe','pipe']`, no extra fds.
- **Injection:** The child receives tool args via validated wire frame. Host never interpolates child output into shells or prompts — it flows back into `chat-loop` as `JSON.stringify(output)` content, which is exactly what the model sees. Document that model will see raw tool output; that is expected and mitigated by the LLM operator, not this layer.
- **Supply chain:** No new runtime deps (Node built-ins only). `zod` reused. N/A with reason: Node-built-ins-only.

### Task 2.1: Scaffold package

**Files:**
- Create: `packages/sandbox-subprocess/package.json` (name, version, `@ax/core` workspace dep, vitest, tsconfig extends).
- Create: `packages/sandbox-subprocess/tsconfig.json` (extends root, references `@ax/core`).
- Create: `packages/sandbox-subprocess/src/index.ts` (placeholder export).
- Create: `packages/sandbox-subprocess/src/plugin.ts` (manifest + empty init).
- Modify: root `tsconfig.json` refs and `pnpm-workspace.yaml` if needed.

Follow the shape used by `@ax/audit-log` as the template. Commit `feat(sandbox-subprocess): scaffold package`.

### Task 2.2: Define the `sandbox:spawn` service hook

**Files:**
- Create: `packages/sandbox-subprocess/src/types.ts`

```ts
export interface SandboxSpawnInput {
  // Fixed argv; argv[0] is the binary, rest are arguments. No shell expansion.
  argv: readonly [string, ...string[]];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}
export interface SandboxSpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  timedOut: boolean;
}
```

Register the hook in `plugin.ts`:

```ts
import type { Plugin } from '@ax/core';
export const plugin: Plugin = {
  manifest: { name: '@ax/sandbox-subprocess', version: '0.1.0', registers: ['sandbox:spawn'], calls: [] },
  async init({ bus }) { bus.registerService('sandbox:spawn', '@ax/sandbox-subprocess', spawnImpl); },
};
```

Write test that asserts the service registers and rejects `argv` missing binary (Zod validation). Commit.

### Task 2.3: Implement `spawnImpl` with env scrubbing

**Files:** `packages/sandbox-subprocess/src/spawn.ts` + tests.

Key behaviors (each a separate test in one file):
1. Echo test: `argv: ['node', '-e', 'process.stdout.write("hi")']` → `stdout: 'hi'`, exit 0.
2. Nonzero exit: `argv: ['node', '-e', 'process.exit(3)']` → `exitCode: 3`.
3. Timeout: `argv: ['node', '-e', 'setInterval(()=>{},1000)']` with `timeoutMs: 100` → `timedOut: true`, `signal: 'SIGKILL'`.
4. Stdout cap: emits 2 MiB, cap 1 KiB → `truncated.stdout: true`, `stdout.length === 1024`.
5. Env scrubbing: `argv: ['node', '-e', 'console.log(process.env.ANTHROPIC_API_KEY ?? "GONE")']`, set `ANTHROPIC_API_KEY=x` in parent → stdout `'GONE'`. (Critical — this is the test that proves the allow-list works.)
6. No-shell: `argv: ['echo', '$HOME']` → stdout literal `$HOME`, not the expanded value.
7. cwd: sets cwd to a tmp dir; child prints `process.cwd()` → matches.

Implementation sketch (~80 LOC): use `child_process.spawn` with `shell: false`, argv array, merged env from the allow-list, `setTimeout(...) → child.kill('SIGKILL')`, concatenate stdout/stderr buffers with a cap.

Each step: write one test, run FAIL, implement the minimum to pass, run PASS, commit. 7 commits in this task — intentional.

### Task 2.4: Document security note for PR

**Files:** Create `packages/sandbox-subprocess/SECURITY.md` with the output-contract block from `security-checklist`. Commit.

---

## Phase 3 — `@ax/tool-dispatcher`

Resolves handoff decision 1: one `tool:execute` producer, fans out to `tool:execute:<name>` sub-services.

### Task 3.1: Scaffold + define the fan-out contract

**Files:**
- `packages/tool-dispatcher/package.json`, `tsconfig.json`
- `packages/tool-dispatcher/src/plugin.ts`
- `packages/tool-dispatcher/src/__tests__/dispatch.test.ts`

Manifest:
```ts
{ name: '@ax/tool-dispatcher', version: '0.1.0', registers: ['tool:execute'], calls: [] }
```

Note: `calls` is empty on purpose — `tool:execute:<name>` service names are dynamic and resolved at call time via `bus.hasService(...)`. Expect this to come up in review; justify in the PR description under Boundary Review as "alternate impl: single per-tool plugin registering tool:execute directly; rejected because bus requires single producer per hook."

### Task 3.2: Implement dispatch

```ts
async function dispatch(ctx: ChatContext, input: ToolCall): Promise<unknown> {
  const sub = `tool:execute:${input.name}`;
  if (!bus.hasService(sub)) {
    throw new PluginError({
      code: 'no-service', plugin: '@ax/tool-dispatcher', hookName: sub,
      message: `no tool plugin registers '${sub}'`,
    });
  }
  return bus.call(sub, ctx, input.input);
}
```

Tests:
1. Registers `tool:execute`.
2. Returns the sub-service's result (use a fake sub-service registered in-test).
3. Throws `no-service` with `hookName: 'tool:execute:foo'` when no provider.
4. Integration: `chat-loop` calling `tool:execute` with an unknown name terminates with `reason: 'no-service:tool:execute:foo'` (thanks to kernel `classify()`).

Commit per test.

---

## Phase 4 — `@ax/tool-bash`

Can run in parallel with Phase 5 once Phase 3 is merged.

### Security checklist (re-invoke)

- **Sandbox:** Bash commands are executed via `sandbox:spawn` with `argv: ['/bin/bash', '-c', command]`. The `-c` form IS a shell — but that is the declared contract of a "bash tool." Mitigation: we do not interpolate anything into `command`; it is passed as a single argv element and the model is the only source. The SANDBOX, not the tool plugin, provides isolation.
- **Injection:** The `command` string is model output (untrusted). It's never interpolated into ANOTHER shell — it IS the shell input, by design. Its stdout/stderr flows back into the model as tool result; document that is the expected path.
- **Supply chain:** No new deps. N/A with reason.

### Task 4.1: Scaffold + manifest

```ts
{ name: '@ax/tool-bash', version: '0.1.0', registers: ['tool:execute:bash'], calls: ['sandbox:spawn'] }
```

Input schema (Zod):
```ts
z.object({ command: z.string().min(1).max(16_384), timeoutMs: z.number().int().positive().max(300_000).optional() });
```

### Task 4.2: Implement

```ts
async function run(ctx, input) {
  const parsed = BashInputSchema.parse(input); // rejects oversized
  const result = await bus.call<SandboxSpawnInput, SandboxSpawnResult>('sandbox:spawn', ctx, {
    argv: ['/bin/bash', '-c', parsed.command],
    cwd: ctx.workspace.rootPath, // per architecture doc section 4.5
    env: {},
    timeoutMs: parsed.timeoutMs ?? 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut };
}
```

Tests:
1. `echo hello` → stdout contains `hello`, exit 0.
2. Nonzero exit → `exitCode: 1`, `stderr` populated.
3. Oversized command (>16 KiB) → throws Zod validation error (caught and surfaced as `invalid-payload`).
4. Timeout honored.
5. Integration with real `@ax/sandbox-subprocess` plugin loaded into a bootstrap — end-to-end via `tool:execute:bash`.

Commit per test.

---

## Phase 5 — `@ax/tool-file-io`

Parallelizable with Phase 4.

### Security checklist (re-invoke)

- **Sandbox:** Caller-provided `path`. Must be resolved against `ctx.workspace.rootPath` via ported `safePath`. `safePath` rejects absolute paths, `..` escapes, and symlinks that resolve outside the root (use `fs.realpath` + prefix check).
- **Injection:** File bytes flow back to the model. Same model-is-the-sink pattern as bash; documented.
- **Supply chain:** No new deps. N/A.

### Task 5.1: Port `safePath`

**Files:**
- Create: `packages/tool-file-io/src/safe-path.ts`
- Create: `packages/tool-file-io/src/__tests__/safe-path.test.ts`

Read the v1 implementation from `~/dev/ai/ax/` (per CLAUDE.md, read-only). Copy the logic; do not port any v1 conditional for "multi-mode sandbox."

Tests (each its own TDD cycle):
1. Relative path inside root → resolved absolute path returned.
2. `../../etc/passwd` → throws `invalid-path`.
3. Absolute path `/etc/passwd` → throws.
4. Symlink inside root pointing outside root → throws (use `realpath`).
5. Root itself → accepted.

### Task 5.2: Register `tool:execute:read_file` and `tool:execute:write_file`

Manifest:
```ts
{ name: '@ax/tool-file-io', version: '0.1.0', registers: ['tool:execute:read_file', 'tool:execute:write_file'], calls: [] }
```

Note: file I/O here uses `fs/promises` directly, **not** the sandbox. Rationale: we already enforce the boundary via `safePath`, and a subprocess-per-read is wasteful. Document this choice in the PR and SECURITY.md. (This is a conscious deviation from "every `tool:execute:*` runs via sandbox:spawn" — the sandbox is for untrusted *code*, not for file access already scoped by path validation.)

Tests:
1. `read_file` returns file contents for a path inside workspace.
2. `read_file` rejects path outside workspace.
3. `write_file` writes bytes; size cap (e.g., 1 MiB) enforced via Zod.
4. `write_file` rejects path outside workspace.
5. `read_file` on a 10 MiB file → rejected with `content-too-large` (pick rejection over truncation; less surprising to model).

Commit per test.

---

## Phase 6 — `@ax/llm-anthropic`

### Security checklist (re-invoke)

- **Sandbox:** Makes HTTPS calls to `api.anthropic.com`. Single network destination; not caller-influenced. `ANTHROPIC_API_KEY` read via `process.env.ANTHROPIC_API_KEY` at plugin init; fail fast with a clear error if missing. Key is NEVER included in error messages or in `llm:post-call` payloads.
- **Injection:** Returns model output. That output lands in `chat-loop` as `assistantMessage` and as `toolCalls[]`. The chat loop treats tool-call args as input to `tool:execute`, which is the designed flow. Subscribers on `llm:post-call` already receive the payload and can veto — that's the prompt-injection defense lever for future plugins.
- **Supply chain:**
  - Add `@anthropic-ai/sdk` pinned to an **exact version** (check `npm view @anthropic-ai/sdk version` and pin without `^` or `~`).
  - Check `npm view @anthropic-ai/sdk scripts` — confirm no `postinstall` / `preinstall` / `prepare` doing network work. If any are present, document them.
  - Skim `pnpm why` output for the new transitive surface after install; paste the list into the PR security note.

### Task 6.1: Scaffold and pin the SDK

**Files:**
- Create: `packages/llm-anthropic/package.json` — add `"@anthropic-ai/sdk": "<exact-version>"`.
- Run `pnpm install --filter @ax/llm-anthropic`.
- Run `pnpm why @anthropic-ai/sdk` and capture new transitives into `packages/llm-anthropic/SECURITY.md`.
- Add changeset.

Commit `feat(llm-anthropic): scaffold package and pin SDK`.

### Task 6.2: Implement `llm:call`

Manifest:
```ts
{ name: '@ax/llm-anthropic', version: '0.1.0', registers: ['llm:call'], calls: [] }
```

Port auth + request shape from v1 `src/providers/anthropic.ts`. Skip orchestration.

```ts
async function llmCall(ctx, input: LlmRequest): Promise<LlmResponse> {
  const res = await client.messages.create({
    model: config.model ?? 'claude-sonnet-4-6',
    max_tokens: config.maxTokens ?? 4096,
    messages: toAnthropicMessages(input.messages),
    tools: config.tools,
  });
  return { assistantMessage: fromAnthropicMessage(res), toolCalls: extractToolCalls(res) };
}
```

Tests (mock the SDK — **do not hit real network in CI**):
1. Happy path: SDK returns `content: [{ type: 'text', text: 'hi' }]` → `assistantMessage.content === 'hi'`, `toolCalls: []`.
2. Tool call: SDK returns `content: [{ type: 'tool_use', id: 'x', name: 'bash', input: { command: 'ls' } }]` → `toolCalls[0] === { id: 'x', name: 'bash', input: { command: 'ls' } }`.
3. Missing `ANTHROPIC_API_KEY` at init → `PluginError({ code: 'init-failed', plugin: '@ax/llm-anthropic' })`.
4. API error (401) → surfaced as `PluginError`, with no key in the message.

Commit per test.

### Task 6.3: Manual real-network smoke (documented, not in CI)

Add a script `packages/llm-anthropic/scripts/smoke.ts` that makes one real call (requires env var set locally). Document in README; do NOT wire into CI. Commit.

---

## Phase 7 — `ax.config.ts` loader

### Task 7.1: Config schema

**Files:**
- Create: `packages/cli/src/config/schema.ts`
- Tests: `packages/cli/src/config/__tests__/schema.test.ts`

```ts
export const AxConfigSchema = z.object({
  llm: z.enum(['anthropic', 'mock']).default('mock'),
  sandbox: z.enum(['subprocess']).default('subprocess'),
  tools: z.array(z.enum(['bash', 'file-io'])).default(['bash', 'file-io']),
  storage: z.enum(['sqlite']).default('sqlite'),
  anthropic: z.object({ model: z.string().optional(), maxTokens: z.number().int().positive().optional() }).optional(),
});
```

Tests: default config parses; unknown llm rejected; partial config fills in defaults.

### Task 7.2: Loader

**Files:**
- Create: `packages/cli/src/config/load.ts`

Behavior:
- Look for `ax.config.ts` in cwd.
- If absent → use schema defaults (preserves current CLI behavior).
- If present → dynamic `import(pathToFileURL(resolved).href)`, `default` export parsed via schema.
- Propagate validation errors with a human-readable message.

Tests:
1. No config file → defaults returned.
2. Valid config → merged over defaults.
3. Invalid config → throws with line-level Zod error.

### Task 7.3: Wire loader into `main.ts`

Replace the hardcoded preset. Based on resolved config, build plugin list:

```ts
const plugins = [
  storageSqlitePlugin,
  auditLogPlugin,
  sandboxSubprocessPlugin,
  toolDispatcherPlugin,
  ...(cfg.tools.includes('bash') ? [toolBashPlugin] : []),
  ...(cfg.tools.includes('file-io') ? [toolFileIoPlugin] : []),
  cfg.llm === 'anthropic' ? llmAnthropicPlugin : llmMockPlugin,
];
```

Update the existing CLI e2e test to continue passing with defaults (llm=mock). Commit.

---

## Phase 8 — E2E acceptance test

### Task 8.1: Mocked-Anthropic smoke test

**Files:**
- Create: `packages/cli/src/__tests__/e2e-real-llm.test.ts`

Approach:
- Use vitest's `vi.mock('@anthropic-ai/sdk', ...)` to intercept at the SDK boundary.
- Script a two-turn exchange: first response returns a `tool_use` for `bash` with `{ command: 'ls' }`; second response returns a final `text` message.
- Spawn the CLI via `execa` (matching the existing Week 3 e2e shape in `packages/cli/src/__tests__/`).
- Use `ax.config.ts` fixture with `llm: 'anthropic'`, `tools: ['bash']`.
- Set `ANTHROPIC_API_KEY=fake-test-key` for the subprocess.
- Assert:
  - Final outcome `{ kind: 'complete' }`.
  - Final assistant message is non-empty.
  - SQLite `outcomes` row exists with the run's chat id.
  - The mocked SDK was called exactly twice.
  - The `bash` tool's stdout (from the real sandbox running real `/bin/bash -c ls`) made it back into the message array.

**Subtle point:** The mock intercepts `@anthropic-ai/sdk` inside the *CLI subprocess*, not the test process. Easiest way: ship a `packages/cli/src/__tests__/fixtures/anthropic-mock-preload.ts` and set `NODE_OPTIONS=--import=...` in the spawn. If that's too finicky, alternative: expose a `__TEST_LLM_OVERRIDE__` env var that `main.ts` honors in test-only builds. Pick the less-invasive one at implementation time and document the decision.

Commit when green.

### Task 8.2: Extend Week 3 e2e to still pass

Run the original Week-3 e2e with `llm: 'mock'` default config. Should be green without changes. If red → config loader regressed defaults.

---

## Phase 9 — Release

### Task 9.1: Changeset

`pnpm changeset` with a summary enumerating each new package + the IPC primitives addition to `@ax/core`.

### Task 9.2: PR description

Open PR against `main` with:
- Summary (1–3 bullets).
- Boundary review answers for EACH new hook: `sandbox:spawn`, `tool:execute` (dispatcher), `tool:execute:bash`, `tool:execute:read_file`, `tool:execute:write_file`. Follow CLAUDE.md "Boundary review" section — name alternate impls, list potentially-leaky field names, subscriber risk.
- `## Security review` block aggregating the per-package security notes into a single top-level summary.
- Test plan checklist.

### Task 9.3: After merge

Update `.claude/memory/context.md` and `decisions.md` with:
- Decisions 1a/2a/3b/4a/5a were made as recommended — record briefly.
- Sandbox-per-call overhead numbers observed in tests (for Week 7–9 context when long-lived agent sandboxing is reconsidered).

---

## Risks & open threads (surface to reviewer)

1. **`sandbox:spawn` not used by `tool-file-io`.** Conscious deviation from "all tool:execute go through sandbox." If the reviewer wants strict uniformity, we add a file-io path through the sandbox in a follow-up — but the current ergonomics argument stands.
2. **`@anthropic-ai/sdk` transitive surface.** We haven't audited it yet; the task captures what to do, but the actual list might prompt a conversation at PR time. If it's ugly, alternative is a thin fetch-based client (~40 LOC) against `api.anthropic.com/v1/messages`. Flag early.
3. **Mock-the-SDK inside CLI subprocess** (Task 8.1). The `NODE_OPTIONS=--import` trick is standard but brittle across Node minor versions. Acceptable for now; revisit if CI flakes.
4. **Tool-dispatcher's empty `calls:[]`.** The `tool:execute:<name>` sub-services are dynamic. Verified by `verifyCalls` skipping this pattern (already does — it only validates declared `calls`). Still, mention it explicitly in the PR so the invariant "no half-wired plugins" isn't mis-flagged.

---

## Execution notes

- **Parallelism:** Phases 4 and 5 run in parallel after Phase 3 merges. Everything else is sequential.
- **Commit cadence:** Every task's final step is a commit. Most tasks produce 3–7 commits. Intentional — do not squash during execution; let the reviewer see the TDD trail.
- **Skill re-invocations:** Invoke `security-checklist` at the start of Phases 1, 2, 4, 5, 6 (every phase with a new trust boundary). Invoke `ax-conventions` whenever about to register a new hook (Phases 2, 3, 4, 5, 6).
- **Verification gate before claiming done:** Use `superpowers:verification-before-completion` before marking each phase complete. `pnpm build && pnpm test` must be green.
