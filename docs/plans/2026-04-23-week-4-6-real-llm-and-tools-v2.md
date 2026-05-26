# Week 4–6 — Real LLM + Tools + Sandbox Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
> Controller reads this plan once, extracts every task with full text + context, creates a TodoWrite entry per task, then dispatches a fresh implementer subagent per task followed by a two-stage review (spec compliance → code quality) before the next task.
>
> Invoke `security-checklist` at the start of every phase that touches a trust boundary (Phases 1, 2, 4, 5, 6) — the per-phase "Security checklist" block below is the prefilled output contract; the skill re-invocation is to sanity-check it against the actual diff. Invoke `ax-conventions` whenever registering a new hook (Phases 2, 3, 4, 5, 6, and Phase 0.3 for the rename).

---

## Why a v2 exists

A v1 of this plan (`docs/plans/2026-04-23-week-4-6-real-llm-and-tools.md`, untracked) was written and executed at low effort. It shipped as PR #3, merged, then main was rolled back. The v1 attempt picked up **12 review comments** from `coderabbitai` + 1 from `github-code-quality`, and left **two of three** kernel follow-ups from the Week 4–6 handoff unaddressed. This v2 folds those gaps into explicit tasks so the next attempt doesn't repeat them.

The v2 changes fall into 12 invariants (I1–I12) carried forward into the per-phase tasks. Each invariant cites the v1 failure mode it closes, so a reviewer can audit the revision against the original PR.

---

## Goal

Ship the first slice where real model output and real tool output flow through the hook bus — `@ax/llm-anthropic` + `@ax/tool-bash` + `@ax/tool-file-io` + `@ax/sandbox-subprocess`, behind an `ax.config.ts` loader, all exercised by a mocked-API smoke test.

## Architecture

Follows `docs/plans/2026-04-22-plugin-architecture-design.md` Section 10 and the Week 4–6 handoff (`docs/plans/2026-04-23-week-4-6-handoff.md`). Decisions locked from handoff:

- **1a** — Tool dispatch via a thin `@ax/tool-dispatcher` that registers `tool:execute` and fans out to `tool:execute:<name>` sub-services.
- **2a** — Subprocess-per-call sandbox (Node `child_process.spawn`, argv-array, `shell:false`). Long-lived-agent sandboxing deferred to Week 7–9.
- **3b** — No `@ax/llm-router`. One LLM per config.
- **4a** — `ax.config.ts` (TypeScript config file, dynamic-import) replaces the hardcoded preset.
- **5a** — `ANTHROPIC_API_KEY` read from env. `@ax/credentials` plugin deferred.

## Tech stack

TypeScript strict, pnpm workspaces, Node `child_process.spawn` (never `shell:true`), `@anthropic-ai/sdk` (pinned exact), `zod`, `vitest`.

## Branch

Week 3 is merged to `main` (`42bb4bf`). Cut `feat/week-4-6-real-llm-v2` off `main`. The old branch `feat/week-4-6-real-llm` stays intact as a reference for the coderabbit threads — do not delete until v2 is merged.

---

## v1 post-mortem: the twelve invariants to carry forward

Each invariant names the v1 failure, the file(s) it lived in, and the phase where v2 closes it. A reviewer should cross-reference the final PR against this list.

### I1 — `sandbox:spawn` types live in `@ax/core`, not in any sandbox plugin.

**v1 failure:** `packages/tool-bash/src/plugin.ts` imported `SandboxSpawnInput` / `SandboxSpawnResult` directly from `@ax/sandbox-subprocess`, and `packages/tool-bash/package.json` declared a workspace dep on `@ax/sandbox-subprocess`. Both violate invariant #2 ("no cross-plugin imports"). v1 caught this late and moved the types to `@ax/core` in a fixup commit.

**v2 closes:** Phase 1 Task 1.3 creates `packages/core/src/sandbox.ts` with the types and Zod schemas, BEFORE Phase 2 scaffolds the sandbox plugin. No cross-plugin import ever lands.

### I2 — Env allow-list merges LAST; caller cannot override.

**v1 failure:** `packages/sandbox-subprocess/src/spawn.ts` built the child env as `childEnv = { ...allowlist, ...caller }`. A tool plugin passing `env: { ANTHROPIC_API_KEY: 'x', PATH: '/evil' }` would override the allowlist. The allowlist was theatrical.

**v2 closes:** Phase 2 Task 2.3 merges in the opposite order — `env = { ...callerEnv, ...allowlist }` — with an explicit test that caller-supplied `ANTHROPIC_API_KEY` and `PATH` do **not** reach the child.

### I3 — `safePath` uses segment-aware `..` check, not `rel.startsWith('..')`.

**v1 failure:** `packages/tool-file-io/src/safe-path.ts:42` used `rel.startsWith('..')`, which false-positives on legitimate names like `..foo.txt` and `.hidden.txt` in some locales.

**v2 closes:** Phase 5 Task 5.1 rejects a segment only if the segment equals `'..'` exactly (split on `path.sep`), and adds an explicit test that `..foo.txt` is accepted.

### I4 — Byte cap via `Buffer.byteLength(s, 'utf8')`, not Zod `.max()` on UTF-16 strings.

**v1 failure:** `packages/tool-file-io/src/plugin.ts` enforced the 1 MiB write cap via `z.string().max(1_048_576)`. Zod `.max()` on strings counts JS UTF-16 code units. A ~600 000-emoji string is ~2.4 MiB UTF-8 but ~1.2 M UTF-16 code units — it **fails** Zod's 1 MiB cap at 1.2 million units, which still emits >1 MiB to disk. The changeset claimed behavior that didn't work.

**v2 closes:** Phase 5 Task 5.2 removes `.max()` on `content`, computes `Buffer.byteLength(content, 'utf8')` before writing, and rejects with `content-too-large` if over cap. Test includes a multi-byte-character string that exceeds the byte cap.

### I5 — No test-only dynamic-import backdoors.

**v1 failure:** `packages/llm-anthropic/src/plugin.ts` honored an `AX_TEST_ANTHROPIC_FIXTURE` env var — `await import(fixturePath)` — so tests could swap the client. That's arbitrary module load under the plugin's trust boundary, gated only by "we already have process-exec."

**v2 closes:** Phase 6 Task 6.2 uses constructor injection (`clientFactory` option on plugin config) and `vi.mock('@anthropic-ai/sdk', ...)` in vitest. The env-var backdoor is removed entirely.

### I6 — `encodeFrame` throws `PluginError`, not raw `TypeError`.

**v1 failure:** `packages/core/src/ipc/framing.ts:32` called `JSON.stringify` without a try, so circular / `undefined` / symbol input threw a raw `TypeError` that the chat loop's `classify()` couldn't route.

**v2 closes:** Phase 1 Task 1.2 wraps the stringify and surfaces a `PluginError({ code: 'invalid-payload', hookName: 'ipc' })`.

### I7 — `child.stdin` always has an error handler.

**v1 failure:** `packages/sandbox-subprocess/src/spawn.ts:132` wrote to `child.stdin` without an error listener. If the child closed stdin before the write drained, the EPIPE bubbled up unhandled and crashed the host.

**v2 closes:** Phase 2 Task 2.3 attaches `.on('error', ...)` before the first write.

### I8 — Tool-name whitelist in the dispatcher.

**v1 failure:** `packages/tool-dispatcher/src/plugin.ts:30` composed `'tool:execute:' + input.name` and looked up via `bus.hasService`. Safe today (Map lookup), but the `input.name` string reaches a hook name directly — a belt-and-suspenders whitelist prevents future IPC paths from surprising us.

**v2 closes:** Phase 3 Task 3.2 validates `input.name` against `/^[a-z][a-z0-9_-]{0,31}$/` before composing the sub-service key.

### I9 — E2E test does NOT run `pnpm build` inside vitest.

**v1 failure:** `packages/cli/src/__tests__/e2e-real-llm.test.ts:28` shelled out to `pnpm build` before execa'ing the binary. Two problems: (a) nested `pnpm` can deadlock the outer pnpm lockfile; (b) on stale `dist/main.js` the test runs an old binary.

**v2 closes:** Phase 8 Task 8.1 invokes `main()` as a library entry with an injected config (no subprocess), while Phase 8 Task 8.2 keeps Week 3's binary-spawning e2e as the "does the shebang wrap run" check.

### I10 — Kernel follow-ups from the handoff are explicit tasks.

**v1 failure:** Handoff listed three kernel follow-ups: replace `classify()` regex, max-turns guard, rename `detectCycles`. v1 only did max-turns; `classify()` stayed next to `hookName`, `detectCycles` kept its name.

**v2 closes:** Phase 0 Tasks 0.2 (classify removal) and 0.3 (detectCycles rename) — separate commits so the reviewer can audit in isolation.

### I11 — Changeset bullets must match implementation.

**v1 failure:** The v1 changeset advertised "1 MiB caps on both read and write" — but I4 means the write cap didn't work. Every changeset bullet is a promise to the user.

**v2 closes:** Phase 9 Task 9.1 — each release-note bullet is cross-referenced with a named test that enforces it. A bullet without a test is dropped.

### I12 — `@anthropic-ai/sdk` transitive surface is captured.

**v1 failure:** No `pnpm why @anthropic-ai/sdk` snapshot was committed. The security-checklist supply-chain section was not substantiated.

**v2 closes:** Phase 6 Task 6.1 commits a `pnpm why` snapshot to `packages/llm-anthropic/SECURITY.md` and records the `npm view @anthropic-ai/sdk scripts` output (confirms no `postinstall` / `preinstall` / `prepare`).

---

## Phase overview

| Phase | Tasks | Outcome |
|-------|-------|---------|
| 0 | Branch + kernel follow-ups | Feature branch off `main`, `classify()` replaced, `detectCycles` renamed |
| 1 | IPC primitives + shared sandbox types in `@ax/core` | Framing, wire schemas, `SandboxSpawn*` types — ready for plugin use |
| 2 | `@ax/sandbox-subprocess` | `sandbox:spawn` service hook; hardened env order, argv check, stdin handler |
| 3 | `@ax/tool-dispatcher` | Fan-out `tool:execute` → `tool:execute:<name>` with name whitelist |
| 4 | `@ax/tool-bash` | `tool:execute:bash` via sandbox |
| 5 | `@ax/tool-file-io` | `tool:execute:read_file` / `write_file` with segment-aware `safePath` + byte cap |
| 6 | `@ax/llm-anthropic` | `llm:call` via pinned SDK, 1-retry on transient, key redaction |
| 7 | `ax.config.ts` loader in `@ax/cli` | Dynamic import + schema, plugin list built from config |
| 8 | E2E acceptance | Mocked-SDK library-mode test + preserved Week 3 binary-mode test |
| 9 | Release | Accurate changeset, full boundary reviews, security-note aggregation, PR |

**Parallelism:** Phases 4 and 5 can run in either order after Phase 3 merges. All other phases are sequential.

---

## Phase 0 — Branch + kernel polish

### Task 0.1: Cut the v2 feature branch

**Files:** none (git only).

**Step 1 — Verify clean tree:**

```bash
git status --short
git log -1 --oneline
```

Expected: `?? README.md`, `?? ax.config.ts`, `?? .worktrees/`, `?? ax-next-chat.sqlite*`, `?? test-bwrap.yaml` — all untracked artifacts from the rolled-back v1 attempt. No staged / modified tracked files. HEAD at `42bb4bf` (or any newer `main`).

If any tracked files are modified or staged → STOP. This plan assumes a clean `main` starting point.

**Step 2 — Create branch:**

```bash
git checkout -b feat/week-4-6-real-llm-v2
```

**Step 3 — Commit an empty start marker** (keeps the v2 branch point explicit in the log):

```bash
git commit --allow-empty -m "chore: start Week 4-6 v2 (real LLM + tools + sandbox)"
```

---

### Task 0.2: Replace `classify(err)` regex with structured `hookName` reads

**Rationale (handoff + I10):** `PluginError` already carries `hookName?: string`; the regex-based `classify()` is obsolete and fragile. The v1 left it in place alongside `hookName`.

**Files:**
- Modify: `packages/core/src/chat-loop.ts`
- Modify: `packages/core/src/__tests__/chat-loop.test.ts`

**Step 1 — Inspect current shape:**

```bash
grep -n "classify\|hookName\|reasonFromError\|PluginError" packages/core/src/chat-loop.ts
grep -n "PluginError\|hookName" packages/core/src/errors.ts
```

Expected: `classify(err)` declared and called in `chat-loop.ts`. `PluginError` with `hookName?: string` in `errors.ts`.

**Step 2 — Write failing test** in `chat-loop.test.ts`:

```ts
it('terminates with ${hookName}:${message} when a service throws a PluginError with hookName', async () => {
  const bus = makeBus();
  bus.registerService<LlmRequest, LlmResponse>('llm:call', 'fake-llm', async () => {
    throw new PluginError({
      code: 'auth-failed',
      plugin: 'fake-llm',
      hookName: 'llm:call',
      message: 'unauthorized',
    });
  });
  registerChatLoop(bus);
  const outcome = await bus.call<ChatRunInput, ChatOutcome>(
    'chat:run',
    makeCtx(),
    { message: { role: 'user', content: 'hi' } },
  );
  expect(outcome).toMatchObject({ kind: 'terminated', reason: 'llm:call:unauthorized' });
});

it('falls back to plugin:${message} when hookName is absent', async () => {
  const bus = makeBus();
  bus.registerService<LlmRequest, LlmResponse>('llm:call', 'fake-llm', async () => {
    throw new PluginError({ code: 'boom', plugin: 'fake-llm', message: 'blew up' });
  });
  registerChatLoop(bus);
  const outcome = await bus.call<ChatRunInput, ChatOutcome>(
    'chat:run',
    makeCtx(),
    { message: { role: 'user', content: 'hi' } },
  );
  expect(outcome).toMatchObject({ kind: 'terminated', reason: 'plugin:blew up' });
});
```

**Step 3 — Run tests, expect FAIL:**

```bash
pnpm -r test --filter @ax/core -- chat-loop
```

**Step 4 — Replace `classify(err)` with `reasonFromError(err)`**. In `chat-loop.ts`:

```ts
import { PluginError } from './errors.js';

function reasonFromError(err: unknown): string {
  if (err instanceof PluginError) {
    return err.hookName ? `${err.hookName}:${err.message}` : `plugin:${err.message}`;
  }
  return 'uncaught';
}
```

Replace the sole `classify(err)` call with `reasonFromError(err)`. Delete the `classify` function and any regexes.

**Step 5 — Run tests, expect PASS:**

```bash
pnpm -r test --filter @ax/core
```

**Step 6 — Commit:**

```bash
git add packages/core
git commit -m "refactor(core): replace classify regex with structured hookName reads"
```

---

### Task 0.3: Rename `detectCycles` in `bootstrap.ts`

**Rationale (handoff + I10):** The function also does duplicate-producer detection in the v1 branch (a separate helper was added). xhigh consolidates naming: one function, one descriptive name. Also exposes the renamed symbol to any test that imports it directly.

**Files:**
- Modify: `packages/core/src/bootstrap.ts`
- Modify: `packages/core/src/__tests__/bootstrap.test.ts`

**Step 1 — Find call sites:**

```bash
grep -rn "detectCycles\|checkDuplicateRegisters" packages/core/src
```

**Step 2 — Rename** `detectCycles` → `validateDependencyGraph`. If the v1 helper `checkDuplicateRegisters` exists, merge its body into `validateDependencyGraph` (single pass over the manifest graph: detect cycles AND duplicate `registers` entries). If `checkDuplicateRegisters` does not exist on `main`, just do the rename.

New shape:

```ts
function validateDependencyGraph(
  graph: Map<string, { calls: string[]; registers: string[] }>
): void {
  // 1. duplicate-producer detection: no two plugins register the same service hook
  // 2. missing-dependency detection: every `calls` entry must be registered by some plugin
  // 3. cycle detection: transitive `calls` graph must be acyclic
}
```

**Step 3 — Update tests** to import and exercise `validateDependencyGraph` (including the duplicate-producer case).

**Step 4 — Run tests, expect PASS:**

```bash
pnpm -r test --filter @ax/core
pnpm -r build
```

**Step 5 — Commit:**

```bash
git add packages/core
git commit -m "refactor(core): consolidate cycle+duplicate detection as validateDependencyGraph"
```

---

## Phase 1 — IPC primitives + shared sandbox types in `@ax/core`

### Security checklist (prefilled — copies into the Phase 9 security note)

```
- Sandbox: Framing parses bytes from an untrusted child. Hard 4 MiB cap on any frame,
  enforced BEFORE Buffer.alloc. Malformed frames and oversize prefixes throw
  PluginError({code:'invalid-payload', hookName:'ipc'}) — never raw throws. No FDs
  or handles ever appear in frame payloads.
- Injection: Framing is JSON-only; downstream consumers Zod-parse before use. No
  eval, no template-string interpolation, no dynamic require.
- Supply chain: N/A — no new deps. zod is already in @ax/core.
```

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

  it('rejects request with non-string action', () => {
    expect(WireRequestSchema.safeParse({ id: '1', action: 5, payload: {} }).success).toBe(false);
  });

  it('rejects request with id over 64 chars', () => {
    expect(WireRequestSchema.safeParse({ id: 'a'.repeat(65), action: 'x', payload: {} }).success).toBe(false);
  });

  it('round-trips ok + err response variants', () => {
    expect(WireResponseSchema.safeParse({ id: '1', ok: true, result: { stdout: '' } }).success).toBe(true);
    expect(WireResponseSchema.safeParse({ id: '1', ok: false, error: { code: 'timeout', message: 't' } }).success).toBe(true);
  });

  it('rejects discriminator missing', () => {
    expect(WireResponseSchema.safeParse({ id: '1', result: {} }).success).toBe(false);
  });
});
```

**Step 2 — Run, expect FAIL** (module missing):

```bash
pnpm -r test --filter @ax/core -- wire
```

**Step 3 — Implement** (`wire.ts`):

```ts
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Action = z.string().min(1).max(128);

export const WireRequestSchema = z.object({
  id: Id,
  action: Action,
  payload: z.unknown(),
});

export const WireResponseSchema = z.discriminatedUnion('ok', [
  z.object({ id: Id, ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: Id,
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

export type WireRequest = z.infer<typeof WireRequestSchema>;
export type WireResponse = z.infer<typeof WireResponseSchema>;
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git add packages/core/src/ipc
git commit -m "feat(core): wire message schemas for IPC"
```

---

### Task 1.2: Length-prefixed framer/parser (I6 enforced)

**Files:**
- Create: `packages/core/src/ipc/framing.ts`
- Create: `packages/core/src/ipc/__tests__/framing.test.ts`

**Design:**
- 4-byte big-endian length prefix, then UTF-8 JSON body.
- `MAX_FRAME = 4 * 1024 * 1024`.
- `encodeFrame(obj)` → `Buffer`. Catches `JSON.stringify` errors (circular, `undefined`, `BigInt`) and throws `PluginError({code:'invalid-payload', hookName:'ipc'})`. **This is I6** — v1 threw raw `TypeError`.
- `FrameDecoder.feed(chunk: Buffer): unknown[]` — stateful, returns zero-or-more completed JSON-parsed objects. Throws `PluginError({code:'invalid-payload', hookName:'ipc'})` when a declared length exceeds `MAX_FRAME` (BEFORE allocation) or when a body is not valid UTF-8 JSON.

**Step 1 — Write failing tests** (each a separate `it` block):

```ts
import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameDecoder, MAX_FRAME } from '../framing.js';
import { PluginError } from '../../errors.js';

describe('framing', () => {
  it('round-trips a single frame', () => {
    const buf = encodeFrame({ hello: 'world' });
    const dec = new FrameDecoder();
    expect(dec.feed(buf)).toEqual([{ hello: 'world' }]);
  });

  it('recombines a chunk split mid-prefix', () => {
    const buf = encodeFrame({ x: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(buf.subarray(0, 2))).toEqual([]);
    expect(dec.feed(buf.subarray(2))).toEqual([{ x: 1 }]);
  });

  it('recombines a chunk split mid-payload', () => {
    const buf = encodeFrame({ x: 1 });
    const dec = new FrameDecoder();
    expect(dec.feed(buf.subarray(0, 5))).toEqual([]);
    expect(dec.feed(buf.subarray(5))).toEqual([{ x: 1 }]);
  });

  it('emits two frames from one chunk', () => {
    const a = encodeFrame({ a: 1 });
    const b = encodeFrame({ b: 2 });
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.concat([a, b]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('no-ops on empty chunk', () => {
    const dec = new FrameDecoder();
    expect(dec.feed(Buffer.alloc(0))).toEqual([]);
  });

  it('throws PluginError (not TypeError) on oversize-declared frame BEFORE allocation', () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_FRAME + 1, 0);
    const dec = new FrameDecoder();
    expect(() => dec.feed(prefix)).toThrow(PluginError);
  });

  it('throws PluginError on malformed JSON body', () => {
    const bad = Buffer.from('not json');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bad.length, 0);
    const dec = new FrameDecoder();
    expect(() => dec.feed(Buffer.concat([prefix, bad]))).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on circular input (not raw TypeError)', () => {
    const obj: any = {};
    obj.self = obj;
    expect(() => encodeFrame(obj)).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on undefined input', () => {
    expect(() => encodeFrame(undefined)).toThrow(PluginError);
  });

  it('encodeFrame throws PluginError on BigInt in input', () => {
    expect(() => encodeFrame({ n: 1n as unknown as number })).toThrow(PluginError);
  });
});
```

**Step 2 — Run, expect FAIL:**

```bash
pnpm -r test --filter @ax/core -- framing
```

**Step 3 — Implement** (`framing.ts`, ~80 LOC):

```ts
import { PluginError } from '../errors.js';

export const MAX_FRAME = 4 * 1024 * 1024;

export function encodeFrame(obj: unknown): Buffer {
  let json: string;
  try {
    json = JSON.stringify(obj);
  } catch (e) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: `encodeFrame: unserializable input (${(e as Error).message})`,
    });
  }
  if (json === undefined) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: 'encodeFrame: input serialized to undefined',
    });
  }
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_FRAME) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: '@ax/core',
      hookName: 'ipc',
      message: `encodeFrame: body ${body.length} > MAX_FRAME ${MAX_FRAME}`,
    });
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const declared = this.buf.readUInt32BE(0);
      if (declared > MAX_FRAME) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/core',
          hookName: 'ipc',
          message: `FrameDecoder: declared ${declared} > MAX_FRAME ${MAX_FRAME}`,
        });
      }
      if (this.buf.length < 4 + declared) break;
      const body = this.buf.subarray(4, 4 + declared);
      this.buf = this.buf.subarray(4 + declared);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (e) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: '@ax/core',
          hookName: 'ipc',
          message: `FrameDecoder: invalid JSON (${(e as Error).message})`,
        });
      }
      out.push(parsed);
    }
    return out;
  }
}
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git add packages/core/src/ipc
git commit -m "feat(core): length-prefixed IPC framing with size cap and PluginError on invalid input"
```

---

### Task 1.3: Shared `SandboxSpawn*` types in `@ax/core` (I1)

**Files:**
- Create: `packages/core/src/sandbox.ts`
- Create: `packages/core/src/__tests__/sandbox.test.ts`

**Step 1 — Write failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { SandboxSpawnInputSchema, SandboxSpawnResultSchema } from '../sandbox.js';

describe('SandboxSpawn schemas', () => {
  it('accepts a minimal well-formed input', () => {
    const r = SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo', 'hi'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeoutMs).toBe(30_000);
      expect(r.data.maxStdoutBytes).toBe(1_048_576);
    }
  });

  it('rejects empty argv', () => {
    expect(SandboxSpawnInputSchema.safeParse({ argv: [], cwd: '/tmp', env: {} }).success).toBe(false);
  });

  it('rejects lowercase env key', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: { path: '/usr/bin' },
    }).success).toBe(false);
  });

  it('rejects env key containing a semicolon', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: { 'A;B': 'x' },
    }).success).toBe(false);
  });

  it('rejects timeoutMs over 300_000', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: '/tmp', env: {}, timeoutMs: 300_001,
    }).success).toBe(false);
  });

  it('rejects non-absolute cwd', () => {
    expect(SandboxSpawnInputSchema.safeParse({
      argv: ['/bin/echo'], cwd: 'tmp', env: {},
    }).success).toBe(false);
  });

  it('accepts a well-formed result', () => {
    expect(SandboxSpawnResultSchema.safeParse({
      exitCode: 0, signal: null, stdout: 'hi', stderr: '',
      truncated: { stdout: false, stderr: false }, timedOut: false,
    }).success).toBe(true);
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement** (`sandbox.ts`):

```ts
import { z } from 'zod';

const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env keys must be A-Z / 0-9 / _ and start with A-Z or _');

export const SandboxSpawnInputSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().regex(/^\//, 'cwd must be absolute'),
  env: z.record(EnvKey, z.string()),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  maxStdoutBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1_048_576),
  maxStderrBytes: z.number().int().positive().max(10 * 1024 * 1024).default(1_048_576),
});

export type SandboxSpawnInput = z.infer<typeof SandboxSpawnInputSchema>;

export const SandboxSpawnResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  timedOut: z.boolean(),
});

export type SandboxSpawnResult = z.infer<typeof SandboxSpawnResultSchema>;
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git add packages/core
git commit -m "feat(core): SandboxSpawn types live in core (no cross-plugin imports)"
```

---

### Task 1.4: Export the IPC + sandbox surface from `@ax/core`

**Files:**
- Modify: `packages/core/src/index.ts`

Add:

```ts
export {
  WireRequestSchema,
  WireResponseSchema,
  type WireRequest,
  type WireResponse,
} from './ipc/wire.js';
export { encodeFrame, FrameDecoder, MAX_FRAME } from './ipc/framing.js';
export {
  SandboxSpawnInputSchema,
  SandboxSpawnResultSchema,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from './sandbox.js';
```

**Step 1 — Build + test:**

```bash
pnpm -r build
pnpm -r test --filter @ax/core
```

**Step 2 — Commit:**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): re-export IPC primitives and SandboxSpawn types"
```

---

## Phase 2 — `@ax/sandbox-subprocess`

First real sandbox. Short-lived child per `tool:execute:*` call. Host and child communicate over stdin/stdout using Phase 1 framing (though this week the `tool:*` plugins call `sandbox:spawn` directly in-process — full IPC-routed tools land in Week 7+).

### Security checklist (prefilled)

```
- Sandbox: child_process.spawn with shell:false and fixed argv array. argv[0] 
  validated against /^[A-Za-z0-9_./-]+$/ (defense-in-depth — shell:false already 
  blocks metachar interpretation, but belt-and-suspenders). env strictly built 
  from an allowlist (PATH, HOME, LANG, LC_ALL, TZ, NODE_OPTIONS='') merged AFTER 
  caller env, so caller cannot override (I2). ANTHROPIC_API_KEY explicitly 
  verified absent from child env (test). cwd validated absolute via Zod schema 
  (Phase 1). stdio is piped-only — no inherited file descriptors or IPC channel. 
  Timeout → SIGKILL, default 30s, cap 300s. stdout/stderr accumulators cap at 1 
  MiB each and set truncation flag. child.stdin.on('error') handler to absorb 
  EPIPE (I7).
- Injection: Child stdout/stderr returned as strings; host never interpolates 
  them into another shell or prompt. Content flows into the chat:messages array 
  as tool-result content — the model is the expected sink, and llm:post-call 
  subscribers are the designed veto point.
- Supply chain: No new runtime deps — Node built-ins (child_process) only. 
  zod is already present via @ax/core. N/A with reason.
```

### Task 2.1: Scaffold package

**Files:**
- Create: `packages/sandbox-subprocess/package.json`
- Create: `packages/sandbox-subprocess/tsconfig.json`
- Create: `packages/sandbox-subprocess/vitest.config.ts`
- Create: `packages/sandbox-subprocess/src/index.ts` (placeholder export)
- Create: `packages/sandbox-subprocess/src/plugin.ts` (manifest + empty init)
- Modify: root `tsconfig.json` (add reference)

**`package.json`:**

```json
{
  "name": "@ax/sandbox-subprocess",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  },
  "ax": {
    "registers": ["sandbox:spawn"],
    "calls": []
  }
}
```

**Critical v2 invariant:** the only `@ax/*` dependency is `@ax/core`. No `@ax/test-harness` except in devDependencies (if used in tests).

**`plugin.ts` (placeholder):**

```ts
import type { Plugin } from '@ax/core';

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/sandbox-subprocess',
      version: '0.0.0',
      registers: ['sandbox:spawn'],
      calls: [],
    },
    async init() {
      // filled in Task 2.2
    },
  };
}
```

**Step 1 — `pnpm install`** (updates workspace lockfile).

**Step 2 — `pnpm -r build`** — expect green.

**Step 3 — Commit:**

```bash
git add packages/sandbox-subprocess tsconfig.json pnpm-lock.yaml
git commit -m "feat(sandbox-subprocess): scaffold package"
```

---

### Task 2.2: Register the `sandbox:spawn` service hook

**Files:**
- Modify: `packages/sandbox-subprocess/src/plugin.ts`
- Create: `packages/sandbox-subprocess/src/__tests__/register.test.ts`

**Step 1 — Failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { createHookBus, type HookBus } from '@ax/core';
import { createSandboxSubprocessPlugin } from '../plugin.js';

describe('sandbox-subprocess registration', () => {
  it('registers sandbox:spawn', async () => {
    const bus: HookBus = createHookBus();
    const plugin = createSandboxSubprocessPlugin();
    await plugin.init({ bus, config: {}, logger: console });
    expect(bus.hasService('sandbox:spawn')).toBe(true);
  });

  it('rejects empty argv via Zod before spawning', async () => {
    const bus = createHookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {}, logger: console });
    await expect(
      bus.call('sandbox:spawn', makeCtx(), { argv: [], cwd: '/tmp', env: {} }),
    ).rejects.toThrow(/argv|invalid/i);
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement** registration in `plugin.ts`:

```ts
import { SandboxSpawnInputSchema, type SandboxSpawnInput, type SandboxSpawnResult, type Plugin } from '@ax/core';
import { spawnImpl } from './spawn.js';

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: { name: '@ax/sandbox-subprocess', version: '0.0.0', registers: ['sandbox:spawn'], calls: [] },
    async init({ bus }) {
      bus.registerService<SandboxSpawnInput, SandboxSpawnResult>(
        'sandbox:spawn',
        '@ax/sandbox-subprocess',
        async (ctx, raw) => {
          const parsed = SandboxSpawnInputSchema.parse(raw);
          return spawnImpl(ctx, parsed);
        },
      );
    },
  };
}
```

Create a stub `spawn.ts`:

```ts
import type { SandboxSpawnInput, SandboxSpawnResult } from '@ax/core';
export async function spawnImpl(_ctx: unknown, _input: SandboxSpawnInput): Promise<SandboxSpawnResult> {
  throw new Error('not yet implemented'); // Task 2.3 replaces this
}
```

**Step 4 — Run registration tests, expect PASS** (empty-argv test passes because Zod rejects before the stub throws; the register test passes).

**Step 5 — Commit:**

```bash
git add packages/sandbox-subprocess/src
git commit -m "feat(sandbox-subprocess): define sandbox:spawn hook contract"
```

---

### Task 2.3: Implement `spawnImpl` (each sub-step a TDD cycle)

**Files:**
- Replace: `packages/sandbox-subprocess/src/spawn.ts`
- Create: `packages/sandbox-subprocess/src/__tests__/spawn.test.ts`

**Each test is its own TDD cycle** (write → fail → implement → pass → commit). Target ~100 LOC for `spawn.ts`. The ordered tests, in increasing complexity:

**2.3.a — Echo test (happy path, minimum viable).**

```ts
it('echo: stdout hi, exit 0', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'process.stdout.write("hi")'], cwd: '/tmp', env: {},
  }));
  expect(r).toMatchObject({ exitCode: 0, stdout: 'hi', stderr: '', timedOut: false });
  expect(r.truncated).toEqual({ stdout: false, stderr: false });
});
```

Minimal impl: `spawn(argv[0], argv.slice(1), { shell: false, cwd: input.cwd, env: buildEnv({}), stdio:['pipe','pipe','pipe']})`, accumulate stdout/stderr, resolve on 'exit'.

Commit: `feat(sandbox-subprocess): spawn + stdout capture`.

**2.3.b — Nonzero exit surfaces exitCode.**

```ts
it('nonzero exit: exitCode 3', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'process.exit(3)'], cwd: '/tmp', env: {},
  }));
  expect(r.exitCode).toBe(3);
});
```

Commit: `feat(sandbox-subprocess): surface nonzero exit`.

**2.3.c — Timeout + SIGKILL.**

```ts
it('timeout: SIGKILL after timeoutMs, timedOut true', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'setInterval(()=>{}, 1000)'], cwd: '/tmp', env: {}, timeoutMs: 200,
  }));
  expect(r.timedOut).toBe(true);
  expect(r.signal).toBe('SIGKILL');
});
```

Impl addition: `const killTimer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs); child.on('exit', () => clearTimeout(killTimer));` — set `result.timedOut = true` when the kill timer fires.

**Note:** use `timeoutMs: 200` (not 100 like v1), giving a 2x safety margin on slow CI. Per I9/test-quality feedback.

Commit: `feat(sandbox-subprocess): timeout via SIGKILL`.

**2.3.d — stdout cap + truncation flag.**

```ts
it('stdout cap: truncated at maxStdoutBytes', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'process.stdout.write("x".repeat(2_000_000))'],
    cwd: '/tmp', env: {}, maxStdoutBytes: 1024,
  }));
  expect(r.stdout.length).toBe(1024);
  expect(r.truncated.stdout).toBe(true);
});
```

Impl: accumulator pattern — each `data` event slices `chunk.subarray(0, remaining)` before appending; once cap reached, set truncated flag and ignore further data.

Commit: `feat(sandbox-subprocess): stdout/stderr caps with truncation flag`.

**2.3.e — `I2`: env allowlist wins (CRITICAL TEST).**

```ts
it('env: caller cannot override allowlist; ANTHROPIC_API_KEY never forwarded', async () => {
  process.env.ANTHROPIC_API_KEY = 'secret-parent-key';
  try {
    const r = await spawnImpl(makeCtx(), parseInput({
      argv: ['node', '-e',
        'console.log(JSON.stringify({' +
        'key: process.env.ANTHROPIC_API_KEY ?? "GONE",' +
        'path: process.env.PATH' +
        '}))'],
      cwd: '/tmp',
      // caller tries to override:
      env: { ANTHROPIC_API_KEY: 'caller-supplied', PATH: '/evil:only' },
    }));
    const child = JSON.parse(r.stdout);
    expect(child.key).toBe('GONE'); // key not forwarded from parent OR caller
    expect(child.path).not.toBe('/evil:only'); // caller cannot set PATH
    expect(child.path).toContain(process.env.PATH ?? '');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
```

Impl: merge order — `const env = { ...input.env, ...allowlistFromParent() };`

```ts
function allowlistFromParent(): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    LANG: process.env.LANG ?? 'C',
    LC_ALL: process.env.LC_ALL ?? 'C',
    TZ: process.env.TZ ?? 'UTC',
    NODE_OPTIONS: '',
  };
  return base;
}
```

Commit: `feat(sandbox-subprocess): env allowlist wins over caller env`.

**2.3.f — Shell metachar in argv[0] rejected (defense-in-depth).**

```ts
it('rejects argv[0] containing shell metachar', async () => {
  await expect(spawnImpl(makeCtx(), parseInput({
    argv: ['/bin/bash; rm -rf /', 'noop'], cwd: '/tmp', env: {},
  }))).rejects.toThrow(/invalid-argv/);
});
```

Impl: before spawn, `if (!/^[A-Za-z0-9_./-]+$/.test(input.argv[0])) throw new PluginError({code:'invalid-argv', hookName:'sandbox:spawn', ...})`.

Commit: `feat(sandbox-subprocess): validate argv[0] shape`.

**2.3.g — No shell expansion (sanity check).**

```ts
it('no shell: $HOME is literal', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['/bin/echo', '$HOME'], cwd: '/tmp', env: {},
  }));
  expect(r.stdout.trim()).toBe('$HOME');
});
```

Commit: `test(sandbox-subprocess): assert shell:false contract`.

**2.3.h — cwd honored.**

```ts
it('cwd: runs inside specified directory', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-cwd-'));
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'process.stdout.write(process.cwd())'],
    cwd: tmp, env: {},
  }));
  expect(r.stdout).toBe(await fs.realpath(tmp));
});
```

Commit: `test(sandbox-subprocess): cwd honored`.

**2.3.i — `I7`: stdin EPIPE handled.**

```ts
it('stdin EPIPE: does not crash the host', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'process.stdin.destroy(); setTimeout(()=>process.exit(0), 20)'],
    cwd: '/tmp', env: {}, stdin: 'x'.repeat(10_000),
  }));
  expect(r.exitCode).toBe(0);
});
```

Impl: before `child.stdin.write(...)`, `child.stdin.on('error', () => {/* swallowed; EPIPE / ECONNRESET expected when child closes early */});`. Then `child.stdin.end(input.stdin)`.

Commit: `feat(sandbox-subprocess): swallow stdin EPIPE to keep host alive`.

**2.3.j — No inherited IPC channel.**

```ts
it('no inherited IPC channel (process.channel is undefined in child)', async () => {
  const r = await spawnImpl(makeCtx(), parseInput({
    argv: ['node', '-e', 'console.log(typeof process.channel)'],
    cwd: '/tmp', env: {},
  }));
  expect(r.stdout.trim()).toBe('undefined');
});
```

(Already enforced by `stdio:['pipe','pipe','pipe']` — this is a regression test.)

Commit: `test(sandbox-subprocess): no inherited IPC channel`.

**Final task step — run full suite:**

```bash
pnpm -r test --filter @ax/sandbox-subprocess
pnpm -r build
```

---

### Task 2.4: SECURITY.md

**Files:**
- Create: `packages/sandbox-subprocess/SECURITY.md`

Content: paste the prefilled security-checklist output block from the start of Phase 2. Append a "Known scope limits" section:

```markdown
## Known scope limits (not enforced by this plugin)

These require OS-level primitives beyond `child_process.spawn` and are deferred to
Week 7–9 (`@ax/sandbox-k8s`) or later hardening:

- **No uid/gid drop.** Child runs as the host user.
- **No ulimit / cgroup / namespaces.** No CPU, memory, or fd limits beyond what 
  Node inherits.
- **No network isolation.** Child inherits the host's network stack.
- **No filesystem namespace.** Child sees the host's filesystem (subject to 
  workspace-relative cwd).

These are acceptable for the subprocess sandbox's purpose (preventing casual 
shell-injection escape), but NOT sufficient for untrusted-code execution. 
Document this assumption in any chat where external input can drive tool calls.
```

Commit:

```bash
git add packages/sandbox-subprocess/SECURITY.md
git commit -m "docs(sandbox-subprocess): security review + scope limits"
```

---

## Phase 3 — `@ax/tool-dispatcher`

### Task 3.1: Scaffold + manifest

**Files:**
- Create: `packages/tool-dispatcher/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/tool-dispatcher/src/index.ts`, `plugin.ts`

Manifest:

```ts
{ name: '@ax/tool-dispatcher', version: '0.0.0', registers: ['tool:execute'], calls: [] }
```

**Note on `calls: []`:** the `tool:execute:<name>` sub-services are resolved dynamically at dispatch time via `bus.hasService(...)`. Declaring them statically would require listing every future tool. This is the one legitimate use of `calls: []` with runtime lookup — document it in the Phase 9 PR description under Boundary Review ("Alternate impl: one plugin per tool registers `tool:execute` directly; rejected because of the one-producer rule").

Commit: `feat(tool-dispatcher): scaffold package`.

---

### Task 3.2: Implement dispatch (I8 enforced)

**Files:**
- Modify: `packages/tool-dispatcher/src/plugin.ts`
- Create: `packages/tool-dispatcher/src/__tests__/dispatch.test.ts`

**Step 1 — Failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { createHookBus, PluginError, type ToolCall } from '@ax/core';
import { createToolDispatcherPlugin } from '../plugin.js';

describe('tool-dispatcher', () => {
  it('registers tool:execute', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    expect(bus.hasService('tool:execute')).toBe(true);
  });

  it('returns the sub-service result', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    bus.registerService('tool:execute:echo', 'test', async (_c, i) => ({ seen: i }));
    const r = await bus.call<ToolCall, unknown>(
      'tool:execute', makeCtx(),
      { id: 't1', name: 'echo', input: { x: 1 } },
    );
    expect(r).toEqual({ seen: { x: 1 } });
  });

  it('throws no-service when sub is missing', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: 'mystery', input: {},
    })).rejects.toSatisfy((e) => e instanceof PluginError && e.hookName === 'tool:execute:mystery');
  });

  it('I8: rejects invalid tool name "../escape"', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: '../escape', input: {},
    })).rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'invalid-tool-name');
  });

  it('I8: rejects invalid tool name "UPPER"', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: 'UPPER', input: {},
    })).rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'invalid-tool-name');
  });

  it('I8: rejects empty tool name', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: '', input: {},
    })).rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'invalid-tool-name');
  });

  it('accepts name "bash"', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    bus.registerService('tool:execute:bash', 'test', async () => ({ ok: true }));
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: 'bash', input: {},
    })).resolves.toEqual({ ok: true });
  });

  it('accepts name "read_file"', async () => {
    const bus = createHookBus();
    await createToolDispatcherPlugin().init({ bus, config: {}, logger: console });
    bus.registerService('tool:execute:read_file', 'test', async () => ({ ok: true }));
    await expect(bus.call('tool:execute', makeCtx(), {
      id: 't1', name: 'read_file', input: {},
    })).resolves.toEqual({ ok: true });
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement:**

```ts
import { PluginError, type Plugin, type ToolCall } from '@ax/core';

const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function createToolDispatcherPlugin(): Plugin {
  return {
    manifest: { name: '@ax/tool-dispatcher', version: '0.0.0', registers: ['tool:execute'], calls: [] },
    async init({ bus }) {
      bus.registerService<ToolCall, unknown>(
        'tool:execute',
        '@ax/tool-dispatcher',
        async (ctx, input) => {
          if (typeof input?.name !== 'string' || !TOOL_NAME_RE.test(input.name)) {
            throw new PluginError({
              code: 'invalid-tool-name',
              plugin: '@ax/tool-dispatcher',
              hookName: 'tool:execute',
              message: `invalid tool name: ${JSON.stringify(input?.name).slice(0, 64)}`,
            });
          }
          const sub = `tool:execute:${input.name}`;
          if (!bus.hasService(sub)) {
            throw new PluginError({
              code: 'no-service',
              plugin: '@ax/tool-dispatcher',
              hookName: sub,
              message: `no tool plugin registers '${sub}'`,
            });
          }
          return bus.call(sub, ctx, input.input);
        },
      );
    },
  };
}
```

**Step 4 — Run, expect PASS.** Commit per logical group (1 commit per 2-3 tests is fine for this task since they share impl):

```bash
git commit -m "feat(tool-dispatcher): fan out tool:execute with tool-name whitelist"
```

---

## Phase 4 — `@ax/tool-bash`

### Security checklist (prefilled)

```
- Sandbox: Executes via @ax/core sandbox:spawn with argv:['/bin/bash','-c',command].
  The `-c` form IS a shell — that's the bash-tool contract. Isolation is the 
  sandbox's responsibility (env allowlist, caps, timeout, shell:false around 
  /bin/bash itself). The tool plugin does NOT pass any env to sandbox:spawn 
  (passes env:{}, sandbox fills its own allowlist).
- Injection: `command` is model output (untrusted). Flows verbatim into bash by 
  design. Output flows back into the model as tool-result content — the expected 
  sink. tool:post-call subscribers (future plugins like output scanners) are the 
  designed veto / rewrite lever.
- Supply chain: N/A — depends only on @ax/core.
```

### Task 4.1: Scaffold + manifest

**Files:**
- Create: `packages/tool-bash/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/tool-bash/src/index.ts`, `plugin.ts`

Manifest:

```ts
{ name: '@ax/tool-bash', version: '0.0.0', registers: ['tool:execute:bash'], calls: ['sandbox:spawn'] }
```

**package.json dependencies:** `@ax/core`, `zod`. **NO `@ax/sandbox-subprocess`** (I1). Import `SandboxSpawnInput` / `SandboxSpawnResult` from `@ax/core`.

Also export a **tool descriptor** (name, description, input JSON schema) that the CLI will forward to the LLM:

```ts
export const bashToolDescriptor = {
  name: 'bash',
  description: 'Execute a shell command in /bin/bash -c and return stdout/stderr/exitCode.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', maxLength: 16_384 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
} as const;
```

Commit: `feat(tool-bash): scaffold package with descriptor`.

---

### Task 4.2: Implement `tool:execute:bash`

**Files:**
- Modify: `packages/tool-bash/src/plugin.ts`
- Create: `packages/tool-bash/src/__tests__/bash.test.ts`

**Step 1 — Failing tests:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createHookBus, type SandboxSpawnInput, type SandboxSpawnResult } from '@ax/core';
import { createToolBashPlugin } from '../plugin.js';

describe('tool-bash', () => {
  it('registers tool:execute:bash', async () => {
    const bus = createHookBus();
    await createToolBashPlugin().init({ bus, config: {}, logger: console });
    expect(bus.hasService('tool:execute:bash')).toBe(true);
  });

  it('delegates to sandbox:spawn with /bin/bash -c <command>', async () => {
    const bus = createHookBus();
    const spy = vi.fn(async (_ctx, i: SandboxSpawnInput): Promise<SandboxSpawnResult> => ({
      exitCode: 0, signal: null, stdout: 'ran', stderr: '',
      truncated: { stdout: false, stderr: false }, timedOut: false,
    }));
    bus.registerService('sandbox:spawn', 'fake-sandbox', spy);
    await createToolBashPlugin().init({ bus, config: {}, logger: console });

    const r = await bus.call('tool:execute:bash', makeCtx({ workspace: { rootPath: '/tmp/ws' } }),
      { command: 'echo hi' });
    expect(r).toMatchObject({ stdout: 'ran', stderr: '', exitCode: 0, timedOut: false });

    expect(spy).toHaveBeenCalledOnce();
    const arg = spy.mock.calls[0][1];
    expect(arg.argv).toEqual(['/bin/bash', '-c', 'echo hi']);
    expect(arg.env).toEqual({});            // I2 / env allowlist: we pass nothing
    expect(arg.cwd).toBe('/tmp/ws');
  });

  it('rejects oversize command (>16 KiB) at Zod before spawning', async () => {
    const bus = createHookBus();
    const spy = vi.fn();
    bus.registerService('sandbox:spawn', 'fake-sandbox', spy);
    await createToolBashPlugin().init({ bus, config: {}, logger: console });

    await expect(bus.call('tool:execute:bash', makeCtx(), {
      command: 'x'.repeat(16_385),
    })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('honors timeoutMs when provided', async () => {
    const bus = createHookBus();
    let seen: SandboxSpawnInput | null = null;
    bus.registerService<SandboxSpawnInput, SandboxSpawnResult>('sandbox:spawn', 'fake', async (_c, i) => {
      seen = i;
      return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: { stdout: false, stderr: false }, timedOut: false };
    });
    await createToolBashPlugin().init({ bus, config: {}, logger: console });
    await bus.call('tool:execute:bash', makeCtx(), { command: 'sleep 1', timeoutMs: 15_000 });
    expect(seen!.timeoutMs).toBe(15_000);
  });

  it('integrates with real sandbox: echo hello', async () => {
    const bus = createHookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {}, logger: console });
    await createToolBashPlugin().init({ bus, config: {}, logger: console });
    const r = await bus.call<unknown, { stdout: string; exitCode: number | null }>(
      'tool:execute:bash', makeCtx({ workspace: { rootPath: process.cwd() } }),
      { command: 'echo hello' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement** (`plugin.ts`):

```ts
import { z } from 'zod';
import {
  type Plugin,
  type SandboxSpawnInput,
  type SandboxSpawnResult,
} from '@ax/core';

const BashInputSchema = z.object({
  command: z.string().min(1).max(16_384),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export function createToolBashPlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/tool-bash',
      version: '0.0.0',
      registers: ['tool:execute:bash'],
      calls: ['sandbox:spawn'],
    },
    async init({ bus }) {
      bus.registerService(
        'tool:execute:bash',
        '@ax/tool-bash',
        async (ctx, raw) => {
          const parsed = BashInputSchema.parse(raw);
          const out = await bus.call<SandboxSpawnInput, SandboxSpawnResult>(
            'sandbox:spawn',
            ctx,
            {
              argv: ['/bin/bash', '-c', parsed.command],
              cwd: ctx.workspace.rootPath,
              env: {},
              timeoutMs: parsed.timeoutMs ?? 30_000,
            },
          );
          return {
            stdout: out.stdout,
            stderr: out.stderr,
            exitCode: out.exitCode,
            timedOut: out.timedOut,
            truncated: out.truncated,
          };
        },
      );
    },
  };
}
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git commit -m "feat(tool-bash): execute via sandbox:spawn with 16 KiB command cap"
```

---

## Phase 5 — `@ax/tool-file-io`

### Security checklist (prefilled)

```
- Sandbox: Caller-provided `path` resolved via safePath against 
  ctx.workspace.rootPath. safePath: per-segment rejection of '..' (I3: exact 
  segment match, not prefix), '/', '\\', ':', null byte, empty; then path.resolve 
  + boundary assertion; then fs.realpath on nearest-existing ancestor + boundary 
  re-assertion (catches symlinks pointing outside root). Reject-semantics: any 
  violation throws PluginError(code:'path-out-of-scope'). File I/O uses 
  fs/promises directly, NOT via sandbox:spawn — the path boundary is the 
  isolation contract for file access; a subprocess-per-read is wasteful. This 
  is a conscious deviation from "every tool:execute:* runs via sandbox" and is 
  called out in the PR boundary-review.
- Injection: File bytes returned to model as tool-result. Same model-is-the-sink 
  pattern as bash; documented.
- Supply chain: N/A — depends only on @ax/core + Node fs/promises.
```

### Task 5.1: Port `safePath` (I3 enforced)

**Files:**
- Create: `packages/tool-file-io/src/safe-path.ts`
- Create: `packages/tool-file-io/src/__tests__/safe-path.test.ts`

**Design decision — reject, don't sanitize.** Legacy `~/dev/ai/ax/src/utils/safe-path.ts` SANITIZES (replaces `..` → `_`, `/` → `_`, etc. per segment, then contains). That was the right choice for multi-tenant web contexts where loud errors cascade. ax-next runs in a single-operator, plan-driven context; loud rejection gives the model + user a clear signal. We REJECT with `PluginError`.

**Import from legacy (read-only):** the per-segment character-class list. Don't copy any multi-mode sandbox conditional.

**Step 1 — Failing tests** (each a TDD cycle — one file, one commit per group):

```ts
import { describe, it, expect } from 'vitest';
import { safePath } from '../safe-path.js';
import { PluginError } from '@ax/core';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

async function mkRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'ax-safepath-'));
}

describe('safePath', () => {
  it('accepts relative path inside root', async () => {
    const root = await mkRoot();
    const r = await safePath(root, 'a/b.txt');
    expect(r).toBe(path.join(root, 'a', 'b.txt'));
  });

  it('accepts the root itself', async () => {
    const root = await mkRoot();
    expect(await safePath(root, '.')).toBe(await fs.realpath(root));
  });

  it('rejects segment ".."', async () => {
    const root = await mkRoot();
    await expect(safePath(root, '../etc/passwd'))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });

  it('I3: ACCEPTS segment "..foo.txt" (not a traversal)', async () => {
    const root = await mkRoot();
    const r = await safePath(root, '..foo.txt');
    expect(r).toBe(path.join(root, '..foo.txt'));
  });

  it('I3: ACCEPTS segment ".hidden"', async () => {
    const root = await mkRoot();
    const r = await safePath(root, '.hidden');
    expect(r).toBe(path.join(root, '.hidden'));
  });

  it('rejects absolute path input', async () => {
    const root = await mkRoot();
    await expect(safePath(root, '/etc/passwd'))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });

  it('rejects null byte in segment', async () => {
    const root = await mkRoot();
    await expect(safePath(root, 'a\0b'))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });

  it('rejects backslash in segment (Windows escape attempt)', async () => {
    const root = await mkRoot();
    await expect(safePath(root, 'a\\..\\b'))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });

  it('rejects symlink inside root that points outside root', async () => {
    const root = await mkRoot();
    const outside = await mkRoot();
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(safePath(root, 'link/evil.txt'))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });

  it('accepts a non-existent leaf inside root (for write_file on new file)', async () => {
    const root = await mkRoot();
    const r = await safePath(root, 'new/dir/file.txt');
    expect(r).toBe(path.join(root, 'new', 'dir', 'file.txt'));
  });

  it('rejects empty string path', async () => {
    const root = await mkRoot();
    await expect(safePath(root, ''))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'path-out-of-scope');
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement** (`safe-path.ts`):

```ts
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PluginError } from '@ax/core';

function reject(message: string): never {
  throw new PluginError({
    code: 'path-out-of-scope',
    plugin: '@ax/tool-file-io',
    hookName: 'safePath',
    message,
  });
}

/**
 * Resolve `userPath` (possibly relative) against `rootAbs` (which MUST be absolute),
 * rejecting any path that escapes the root via '..', absolute prefix, null byte,
 * backslash, or symlink redirection. Segment-aware '..' check (I3): a segment is
 * treated as traversal only if it is exactly '..', not just "starts with ..".
 */
export async function safePath(rootAbs: string, userPath: string): Promise<string> {
  if (typeof userPath !== 'string' || userPath === '') {
    reject('empty or non-string path');
  }
  if (!path.isAbsolute(rootAbs)) {
    reject('root must be absolute');
  }
  // Split on POSIX sep AND backslash; we reject backslash explicitly below, but
  // split first so Windows-style inputs don't sneak through path.resolve.
  const segments = userPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') reject(`path contains '..' segment: ${userPath}`);
    if (seg.includes('\0')) reject(`path contains null byte: ${userPath}`);
    if (seg.includes('\\')) reject(`path contains backslash: ${userPath}`);
    if (seg.includes(':')) reject(`path contains colon: ${userPath}`);
  }
  if (path.isAbsolute(userPath)) {
    reject(`path is absolute: ${userPath}`);
  }

  const rootReal = await fs.realpath(rootAbs);
  const resolved = path.resolve(rootReal, userPath);
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    reject(`path resolves outside root: ${resolved}`);
  }

  // Walk up to find the nearest existing ancestor; realpath that, re-check boundary.
  // This allows write_file on a non-existent leaf while still canonicalizing any
  // existing symlinks in the ancestor chain.
  let probe = resolved;
  while (probe !== rootReal) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        reject(`symlink canonicalizes outside root: ${real}`);
      }
      // Attach the remaining (non-existent) suffix onto the canonicalized prefix:
      const suffix = path.relative(probe, resolved);
      return suffix === '' ? real : path.join(real, suffix);
    } catch {
      probe = path.dirname(probe);
    }
  }
  return resolved; // nothing inside root exists yet; resolved is already canonical
}
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git commit -m "feat(tool-file-io): port safePath with segment-aware .. check and realpath canonicalization"
```

---

### Task 5.2: Register `read_file` and `write_file` (I4 enforced)

**Files:**
- Create: `packages/tool-file-io/src/plugin.ts`
- Create: `packages/tool-file-io/src/__tests__/file-io.test.ts`

Manifest:

```ts
{ name: '@ax/tool-file-io', version: '0.0.0',
  registers: ['tool:execute:read_file', 'tool:execute:write_file'], calls: [] }
```

Descriptors (exported alongside the plugin factory):

```ts
export const readFileToolDescriptor = {
  name: 'read_file',
  description: 'Read a UTF-8 file from the workspace.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 4096 } },
    required: ['path'],
    additionalProperties: false,
  },
} as const;

export const writeFileToolDescriptor = {
  name: 'write_file',
  description: 'Write a UTF-8 file inside the workspace (max 1 MiB).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 4096 },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
} as const;
```

**Step 1 — Failing tests:**

```ts
describe('tool-file-io', () => {
  it('read_file returns contents for a path inside workspace', async () => { ... });
  it('read_file rejects a path outside workspace', async () => { ... });
  it('read_file rejects a file larger than 1 MiB via fs.stat', async () => { ... });
  it('write_file writes bytes inside workspace', async () => { ... });
  it('write_file rejects a path outside workspace', async () => { ... });
  it('I4: write_file rejects a multi-byte string that exceeds 1 MiB in UTF-8', async () => {
    // A single emoji is 4 bytes in UTF-8 but 2 UTF-16 code units.
    // 300_000 * 4 = 1_200_000 bytes > 1 MiB, while JS str.length = 600_000.
    const s = '😀'.repeat(300_000);
    const bus = makeBusWithFileIo(root);
    await expect(bus.call('tool:execute:write_file', makeCtx({ workspace: { rootPath: root } }),
      { path: 'out.txt', content: s },
    )).rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'content-too-large');
  });
  it('write_file accepts a 1 KiB ASCII string', async () => { ... });
  it('read_file follows a symlink that stays inside root', async () => { ... });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement:**

```ts
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import { PluginError, type Plugin } from '@ax/core';
import { safePath } from './safe-path.js';

const ReadFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
});

const WriteFileInputSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string(), // I4: no .max here; byte cap enforced via Buffer.byteLength
});

const MAX_FILE_BYTES = 1_048_576;

export function createToolFileIoPlugin(): Plugin {
  return {
    manifest: {
      name: '@ax/tool-file-io',
      version: '0.0.0',
      registers: ['tool:execute:read_file', 'tool:execute:write_file'],
      calls: [],
    },
    async init({ bus }) {
      bus.registerService(
        'tool:execute:read_file',
        '@ax/tool-file-io',
        async (ctx, raw) => {
          const parsed = ReadFileInputSchema.parse(raw);
          const resolved = await safePath(ctx.workspace.rootPath, parsed.path);
          const stat = await fs.stat(resolved);
          if (stat.size > MAX_FILE_BYTES) {
            throw new PluginError({
              code: 'content-too-large',
              plugin: '@ax/tool-file-io',
              hookName: 'tool:execute:read_file',
              message: `file exceeds ${MAX_FILE_BYTES} bytes (size=${stat.size})`,
            });
          }
          const content = await fs.readFile(resolved, 'utf8');
          return { path: parsed.path, content, bytes: stat.size };
        },
      );
      bus.registerService(
        'tool:execute:write_file',
        '@ax/tool-file-io',
        async (ctx, raw) => {
          const parsed = WriteFileInputSchema.parse(raw);
          const bytes = Buffer.byteLength(parsed.content, 'utf8');
          if (bytes > MAX_FILE_BYTES) {
            throw new PluginError({
              code: 'content-too-large',
              plugin: '@ax/tool-file-io',
              hookName: 'tool:execute:write_file',
              message: `write exceeds ${MAX_FILE_BYTES} bytes (got ${bytes})`,
            });
          }
          const resolved = await safePath(ctx.workspace.rootPath, parsed.path);
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, parsed.content, 'utf8');
          return { path: parsed.path, bytes };
        },
      );
    },
  };
}
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git commit -m "feat(tool-file-io): read/write with segment-aware boundary and UTF-8 byte cap"
```

---

### Task 5.3: SECURITY.md

**Files:**
- Create: `packages/tool-file-io/SECURITY.md`

Paste the prefilled security-review block + document the "file-io does not go through sandbox:spawn" deviation explicitly with its rationale.

Commit: `docs(tool-file-io): security review + boundary rationale`.

---

## Phase 6 — `@ax/llm-anthropic`

### Security checklist (prefilled)

```
- Sandbox: HTTPS only to api.anthropic.com (single destination, not 
  caller-influenced). ANTHROPIC_API_KEY read from process.env at plugin init; 
  fail-fast with generic PluginError(code:'missing-api-key') if absent. Key 
  NEVER appears in error messages (redactKey wraps all SDK-originating errors) 
  or in log output (explicit test). No test-time import backdoors (I5) — 
  tests use vi.mock('@anthropic-ai/sdk') or clientFactory constructor injection.
- Injection: Model output returned as assistantMessage / toolCalls; chat-loop 
  dispatches tool calls. Subscribers on llm:post-call can veto/rewrite — the 
  designed prompt-injection lever for future plugins.
- Supply chain: @anthropic-ai/sdk pinned to exact version <X.Y.Z>. No 
  postinstall / preinstall / prepare scripts (verified via `npm view 
  @anthropic-ai/sdk scripts`). Transitive surface captured in SECURITY.md via 
  `pnpm why` snapshot. If the sdk pulls in anything surprising at install time 
  (e.g., platform-specific binaries), document.
```

### Task 6.1: Scaffold + pin SDK + audit transitive surface (I12)

**Files:**
- Create: `packages/llm-anthropic/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/llm-anthropic/src/index.ts`, `plugin.ts` (stub)
- Create: `packages/llm-anthropic/SECURITY.md`

**Step 1 — Query current SDK version + scripts:**

```bash
npm view @anthropic-ai/sdk version
npm view @anthropic-ai/sdk scripts
```

Expected: a concrete version string (e.g., `0.90.0`). Scripts should have NO `postinstall` / `preinstall` / `prepare`. If any appear, stop and document.

**Step 2 — Add dep pinned EXACTLY** (no `^` or `~`):

```bash
pnpm add --filter @ax/llm-anthropic @anthropic-ai/sdk@<EXACT-VERSION>
```

Then hand-edit `packages/llm-anthropic/package.json` to remove any `^` or `~` prefix pnpm may have added.

**Step 3 — Audit transitives:**

```bash
pnpm why @anthropic-ai/sdk > /tmp/anthropic-why.txt
cat /tmp/anthropic-why.txt
```

Copy the output into `packages/llm-anthropic/SECURITY.md` under a `## Transitive dependencies (as of <version> @ <date>)` heading. Also record the `npm view ... scripts` output.

**Step 4 — Commit:**

```bash
git add packages/llm-anthropic pnpm-lock.yaml
git commit -m "feat(llm-anthropic): scaffold, pin @anthropic-ai/sdk, capture transitive snapshot"
```

---

### Task 6.2: Implement `llm:call` (I5 enforced, retry added)

**Files:**
- Modify: `packages/llm-anthropic/src/plugin.ts`
- Create: `packages/llm-anthropic/src/__tests__/llm-call.test.ts`

**Design:**
- Plugin factory accepts a `Config` with `model?`, `maxTokens?`, and `clientFactory?` (the test-injection seam — I5 replaces the env-var backdoor).
- On `llm:call`, map `LlmRequest.messages` → Anthropic `messages`, map `LlmRequest.tools` → Anthropic `tools`, invoke `client.messages.create`.
- **Single retry on transient error** (HTTP 5xx, HTTP 429, network error). Fixed 1s backoff. No more than one retry — schedule-holding risks higher retries.
- Key redaction: any error-message string that contains the API key value is replaced with `<redacted>`. Key is also never included in log lines.

**Step 1 — Failing tests:**

```ts
describe('llm-anthropic', () => {
  it('happy path: maps text response', async () => {
    const fakeClient = makeFakeClient([
      { content: [{ type: 'text', text: 'hi' }] },
    ]);
    const plugin = createLlmAnthropicPlugin({ clientFactory: () => fakeClient });
    const bus = createHookBus();
    process.env.ANTHROPIC_API_KEY = 'test';
    await plugin.init({ bus, config: {}, logger: console });
    const r = await bus.call('llm:call', makeCtx(), { messages: [{ role: 'user', content: 'hi' }] });
    expect(r).toMatchObject({ assistantMessage: { role: 'assistant', content: 'hi' }, toolCalls: [] });
  });

  it('tool-use: maps tool_use block to toolCalls[]', async () => { ... });

  it('missing ANTHROPIC_API_KEY at init → init-failed PluginError (no key in message)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const plugin = createLlmAnthropicPlugin({});
    const bus = createHookBus();
    await expect(plugin.init({ bus, config: {}, logger: console }))
      .rejects.toSatisfy((e) => e instanceof PluginError && e.code === 'missing-api-key' && !/test|key/i.test(e.message));
  });

  it('API 401: surfaces PluginError with redacted message', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-supersecret';
    const fake = makeFailingClient({ status: 401, message: 'Bad key: sk-supersecret' });
    const plugin = createLlmAnthropicPlugin({ clientFactory: () => fake });
    const bus = createHookBus();
    await plugin.init({ bus, config: {}, logger: console });
    const err = await bus.call('llm:call', makeCtx(), { messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.message).not.toContain('sk-supersecret');
  });

  it('API 500: retries once then succeeds', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    let calls = 0;
    const fake = {
      messages: {
        create: async () => {
          calls++;
          if (calls === 1) throw new AnthropicAPIError({ status: 500, message: 'boom' });
          return { content: [{ type: 'text', text: 'recovered' }] };
        },
      },
    };
    const plugin = createLlmAnthropicPlugin({ clientFactory: () => fake });
    const bus = createHookBus();
    await plugin.init({ bus, config: {}, logger: console });
    const r = await bus.call('llm:call', makeCtx(), { messages: [{ role: 'user', content: 'x' }] });
    expect(calls).toBe(2);
    expect((r as any).assistantMessage.content).toBe('recovered');
  });

  it('API 500 twice: surfaces PluginError, no key in message', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-secret';
    const fake = makeFailingClient({ status: 500, message: 'internal' });
    const plugin = createLlmAnthropicPlugin({ clientFactory: () => fake });
    const bus = createHookBus();
    await plugin.init({ bus, config: {}, logger: console });
    const err = await bus.call('llm:call', makeCtx(), { messages: [{ role: 'user', content: 'x' }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.message).not.toContain('sk-secret');
  });

  it('I5: no AX_TEST_ANTHROPIC_FIXTURE env-var load path exists', async () => {
    process.env.AX_TEST_ANTHROPIC_FIXTURE = '/tmp/evil.mjs'; // should be ignored
    process.env.ANTHROPIC_API_KEY = 'test';
    const plugin = createLlmAnthropicPlugin({});
    const bus = createHookBus();
    await plugin.init({ bus, config: {}, logger: console });
    // If AX_TEST_ANTHROPIC_FIXTURE were honored, an import() would fail with MODULE_NOT_FOUND.
    // Since it is not honored, plugin init succeeds without attempting a load.
    expect(bus.hasService('llm:call')).toBe(true);
    delete process.env.AX_TEST_ANTHROPIC_FIXTURE;
  });
});
```

**Step 2 — Run, expect FAIL.**

**Step 3 — Implement.** (The retry helper + redaction utility can live inline in `plugin.ts`.)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { PluginError, type Plugin, type LlmRequest, type LlmResponse } from '@ax/core';

interface Config {
  model?: string;
  maxTokens?: number;
  clientFactory?: (apiKey: string) => { messages: { create: (req: unknown) => Promise<unknown> } };
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function isTransient(e: unknown): boolean {
  const status = (e as any)?.status ?? (e as any)?.response?.status;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

function redact(message: string, apiKey: string | undefined): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('<redacted>');
}

export function createLlmAnthropicPlugin(cfg: Config = {}): Plugin {
  return {
    manifest: { name: '@ax/llm-anthropic', version: '0.0.0', registers: ['llm:call'], calls: [] },
    async init({ bus }) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new PluginError({
          code: 'missing-api-key',
          plugin: '@ax/llm-anthropic',
          hookName: 'init',
          message: 'ANTHROPIC_API_KEY not set',
        });
      }
      const client = cfg.clientFactory
        ? cfg.clientFactory(apiKey)
        : new Anthropic({ apiKey });

      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        '@ax/llm-anthropic',
        async (_ctx, input) => {
          const request = toAnthropicRequest(input, cfg);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const res = await client.messages.create(request);
              return fromAnthropicResponse(res);
            } catch (e) {
              if (attempt === 0 && isTransient(e)) {
                await new Promise((r) => setTimeout(r, 1000));
                continue;
              }
              throw new PluginError({
                code: isTransient(e) ? 'transient' : 'llm-error',
                plugin: '@ax/llm-anthropic',
                hookName: 'llm:call',
                message: redact((e as Error).message ?? 'unknown', apiKey),
              });
            }
          }
          throw new PluginError({
            code: 'unreachable',
            plugin: '@ax/llm-anthropic',
            hookName: 'llm:call',
            message: 'retry loop exhausted without resolution',
          });
        },
      );
    },
  };
}
```

**Step 4 — Run, expect PASS.** Commit:

```bash
git commit -m "feat(llm-anthropic): llm:call with one-retry, key redaction, no env backdoor"
```

---

### Task 6.3: Manual real-network smoke script (not in CI)

**Files:**
- Create: `packages/llm-anthropic/scripts/smoke.ts`
- Modify: `packages/llm-anthropic/README.md`

The script makes one real call against `api.anthropic.com`, requires `ANTHROPIC_API_KEY` set locally, prints the response. It's NOT invoked by any `pnpm` script; the README documents how to run it manually and when (one-time check per PR).

Commit: `chore(llm-anthropic): manual real-network smoke script`.

---

## Phase 7 — `ax.config.ts` loader

### Task 7.1: Config schema

**Files:**
- Create: `packages/cli/src/config/schema.ts`
- Create: `packages/cli/src/config/__tests__/schema.test.ts`

```ts
import { z } from 'zod';

export const AxConfigSchema = z.object({
  llm: z.enum(['anthropic', 'mock']).default('mock'),
  sandbox: z.enum(['subprocess']).default('subprocess'),
  tools: z.array(z.enum(['bash', 'file-io'])).default(['bash', 'file-io']),
  storage: z.enum(['sqlite']).default('sqlite'),
  anthropic: z.object({
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
  }).optional(),
});

export type AxConfig = z.infer<typeof AxConfigSchema>;
```

Tests:
1. Empty object parses → all defaults.
2. Unknown llm value rejected.
3. Partial config merges with defaults.
4. Invalid anthropic.maxTokens (zero) rejected.
5. Extra top-level keys rejected (`.strict()` via `z.object({...}).strict()` — **ADD `.strict()` to the schema**).

Commit: `feat(cli): config schema for ax.config.ts`.

---

### Task 7.2: Loader

**Files:**
- Create: `packages/cli/src/config/load.ts`
- Create: `packages/cli/src/config/__tests__/load.test.ts`

Behavior:
- Look for `ax.config.ts` (or `.js` / `.mjs`) in `cwd`.
- If absent → `AxConfigSchema.parse({})` (defaults).
- If present → `import(pathToFileURL(resolved).href)`, validate `default` export via `AxConfigSchema.parse()`.

**Important:** Use `pathToFileURL` on the absolute resolved path (ESM import-over-path-string is broken on Windows). Wrap Zod errors into `PluginError` with a line-readable message.

Tests:
1. No config file → schema defaults.
2. Valid `ax.config.ts` → merged over defaults.
3. Invalid config (wrong type) → throws with Zod details in message.
4. Config file exists but has no `default` export → throws with `missing-default` error.

Commit: `feat(cli): config loader with cwd-relative discovery`.

---

### Task 7.3: Wire loader into `main.ts`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/__tests__/main.test.ts` (existing Week 3 e2e must still pass)

Build plugin list from resolved config:

```ts
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { createAuditLogPlugin } from '@ax/audit-log';
import { createSandboxSubprocessPlugin } from '@ax/sandbox-subprocess';
import { createToolDispatcherPlugin } from '@ax/tool-dispatcher';
import { createToolBashPlugin, bashToolDescriptor } from '@ax/tool-bash';
import { createToolFileIoPlugin, readFileToolDescriptor, writeFileToolDescriptor } from '@ax/tool-file-io';
import { createLlmMockPlugin } from '@ax/llm-mock';
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';

function buildPlugins(cfg: AxConfig) {
  const plugins = [
    createStorageSqlitePlugin(),
    createAuditLogPlugin(),
    createSandboxSubprocessPlugin(),
    createToolDispatcherPlugin(),
    ...(cfg.tools.includes('bash') ? [createToolBashPlugin()] : []),
    ...(cfg.tools.includes('file-io') ? [createToolFileIoPlugin()] : []),
    cfg.llm === 'anthropic'
      ? createLlmAnthropicPlugin(cfg.anthropic ?? {})
      : createLlmMockPlugin(),
  ];
  return plugins;
}

function buildToolDescriptors(cfg: AxConfig) {
  return [
    ...(cfg.tools.includes('bash') ? [bashToolDescriptor] : []),
    ...(cfg.tools.includes('file-io') ? [readFileToolDescriptor, writeFileToolDescriptor] : []),
  ];
}
```

Expose `main({ message, configOverride?, workspaceRoot?, sqlitePath? })` as a library entry. The binary wrapper (`dist/main.js`) calls it.

Commit: `feat(cli): build plugin list from ax.config.ts`.

---

## Phase 8 — E2E acceptance test

### Task 8.1: Mocked-SDK library-mode smoke test (I9 enforced)

**Files:**
- Create: `packages/cli/src/__tests__/e2e-real-llm.test.ts`

**Approach — library invocation, NOT subprocess.** The test imports `main({ ... })` and calls it directly with `vi.mock('@anthropic-ai/sdk')` intercepting the client. No `pnpm build` inside vitest; no subprocess; the binary wrapper is already covered by Week 3's e2e.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn()
        .mockResolvedValueOnce({
          content: [
            { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo hello' } },
          ],
          stop_reason: 'tool_use',
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        }),
    };
  },
}));

import { main } from '../main.js';

describe('real-llm e2e (mocked SDK)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-e2e-'));
    process.env.ANTHROPIC_API_KEY = 'fake-test';
  });

  it('completes a two-turn chat with bash tool', async () => {
    const outcome = await main({
      message: { role: 'user', content: 'list files in cwd' },
      configOverride: {
        llm: 'anthropic', sandbox: 'subprocess',
        tools: ['bash'], storage: 'sqlite',
      },
      workspaceRoot: tmp,
      sqlitePath: path.join(tmp, 'test.db'),
    });
    expect(outcome.kind).toBe('complete');
    expect(outcome.messages.length).toBeGreaterThanOrEqual(3);
    const tail = outcome.messages[outcome.messages.length - 1];
    expect(tail.role).toBe('assistant');
    expect(typeof tail.content === 'string' ? tail.content : '').toContain('done');
    // bash result landed in the message array as a tool-result
    const toolResult = outcome.messages.find((m) =>
      typeof m.content === 'string' && m.content.includes('hello'));
    expect(toolResult).toBeTruthy();
  });
});
```

Commit: `test(cli): library-mode e2e with mocked Anthropic + real bash sandbox`.

---

### Task 8.2: Preserve Week 3 binary-mode e2e

Re-run the existing `packages/cli/src/__tests__/main.test.ts` (or whichever file). Default config (llm=mock) must still produce a green Week 3 e2e. If it fails → the config loader regressed defaults.

Fix any regression in the same commit. No new test file needed.

Commit (only if regression was found): `fix(cli): preserve Week 3 e2e default config behavior`.

---

## Phase 9 — Release

### Task 9.1: Changeset (I11 enforced)

**Files:**
- Create: `.changeset/week-4-6-real-llm-v2.md`

Template:

```
---
"@ax/core": minor
"@ax/sandbox-subprocess": minor
"@ax/tool-dispatcher": minor
"@ax/tool-bash": minor
"@ax/tool-file-io": minor
"@ax/llm-anthropic": minor
"@ax/cli": minor
---

Week 4–6 slice: real LLM + tools + sandbox (v2, post-rollback).

- @ax/core: IPC framing + wire schemas; shared `SandboxSpawn*` types.
- @ax/sandbox-subprocess: subprocess-per-call sandbox. Env allowlist merged AFTER 
  caller env (allowlist wins). argv[0] shape validated. stdout/stderr capped at 
  1 MiB (truncation flag). SIGKILL timeout, 30s default, 300s max. stdin EPIPE 
  handler.
- @ax/tool-dispatcher: fan-out for `tool:execute:<name>`. Tool names validated 
  against `/^[a-z][a-z0-9_-]{0,31}$/`.
- @ax/tool-bash: bash command execution via `sandbox:spawn`. Command cap 16 KiB.
- @ax/tool-file-io: `read_file` / `write_file` with `safePath` (segment-aware 
  `..` check, realpath-canonicalized, reject-on-escape) and 1 MiB byte cap 
  (enforced via `Buffer.byteLength(content, 'utf8')`, NOT Zod UTF-16 
  `.max()` — this fixes the v1 bug where emoji-heavy strings bypassed the cap).
- @ax/llm-anthropic: `llm:call` via pinned `@anthropic-ai/sdk`. One retry on 
  HTTP 5xx / 429. API key redaction in error messages. No runtime env-var 
  import backdoors.
- @ax/cli: `ax.config.ts` loader with schema defaults; plugin list built from 
  config.
```

**Gate:** each bullet MUST have a corresponding test in the repo. Run through this checklist before commit:

- [ ] allowlist-wins → Task 2.3.e test exists
- [ ] argv[0] shape → Task 2.3.f test exists
- [ ] stdout cap → Task 2.3.d test exists
- [ ] timeout → Task 2.3.c test exists
- [ ] stdin EPIPE → Task 2.3.i test exists
- [ ] tool-name whitelist → Task 3.2 tests exist (3 invalid-name tests)
- [ ] bash command cap → Task 4.2 oversize-command test exists
- [ ] safePath segment-aware → Task 5.1 `..foo.txt` test exists
- [ ] UTF-8 byte cap → Task 5.2 emoji-string test exists (I4)
- [ ] SDK pinned → verify `packages/llm-anthropic/package.json` has no `^`/`~`
- [ ] one-retry → Task 6.2 transient-then-success test exists
- [ ] key redaction → Task 6.2 401-with-key test exists
- [ ] no env backdoor → Task 6.2 I5 test exists

Commit: `chore: changeset for Week 4-6 v2 real LLM + tools slice`.

---

### Task 9.2: PR description with full boundary reviews

**Files:** (no file edit; PR description only.)

**Step 1 — Run `gh pr create` with a HEREDOC body following this skeleton:**

```
## Summary
- Real LLM (@ax/llm-anthropic) + real tools (bash, file-io) + subprocess sandbox, 
  behind an ax.config.ts loader.
- v2 of the Week 4–6 slice. The v1 branch (PR #3) merged and was rolled back; 
  this PR closes the 12 review comments v1 picked up. See 
  docs/plans/2026-04-23-week-4-6-real-llm-and-tools-v2.md for the v1→v2 diff 
  (invariants I1–I12).

## Boundary review (required by CLAUDE.md)

### sandbox:spawn (@ax/sandbox-subprocess)
- Alternate impl: @ax/sandbox-k8s (Week 7-9) which spawns a pod per call. 
  Input/output shape identical; backend differs.
- Payload field names that might leak: argv, cwd, env, stdin, timeoutMs, 
  maxStdout/StderrBytes, exitCode, signal, truncated, timedOut. All OS-process 
  vocabulary; would port 1:1 to pod-spec-equivalents. No git/sqlite/http 
  vocabulary.
- Subscriber risk: none (subscribers don't own sandbox:spawn since it's a 
  service hook).
- Wire surface: NOT exposed as an IPC action this week. Tool plugins are 
  in-process consumers. Week 7-9 may wire it through to agent-side tool-local 
  execution; that's a future decision.

### tool:execute (@ax/tool-dispatcher)
- Alternate impl: each tool plugin registers tool:execute directly. REJECTED 
  because of the one-producer rule.
- Payload field names: id, name, input. Transport-agnostic.
- Subscriber risk: tool:pre-call / tool:post-call subscribers already work 
  today against ToolCall; dispatcher is transparent to them.
- Wire surface: one IPC action (future) maps to this hook.

### tool:execute:bash, tool:execute:read_file, tool:execute:write_file
- Alternate impl: a Docker-exec tool (future) would register tool:execute:bash 
  instead — no signature change; only sandbox:spawn backend differs.
- Payload field names: command, path, content, bytes, stdout, stderr, exitCode. 
  OS vocabulary; transport-agnostic.
- Subscriber risk: workspace:applied subscribers DO NOT observe these today 
  (file-io does not go through workspace hooks; that's Week 7+). Document.
- Wire surface: N/A (not yet IPC-exposed).

### llm:call (@ax/llm-anthropic)
- Alternate impl: @ax/llm-mock, @ax/llm-openai (future). Signature unchanged.
- Payload field names: messages, tools, assistantMessage, toolCalls. No 
  provider-specific vocabulary.
- Subscriber risk: llm:pre-call / llm:post-call already stable.
- Wire surface: N/A this week.

## Security review

<aggregate each package's SECURITY.md top block into one list>

- Sandbox: <one-line per package>
- Injection: <one line>
- Supply chain: @anthropic-ai/sdk pinned at <version>, no install scripts, 
  pnpm why snapshot in packages/llm-anthropic/SECURITY.md. Other packages: no 
  new deps.

## Test plan
- [ ] pnpm -r build green
- [ ] pnpm -r test green
- [ ] Manual: packages/llm-anthropic/scripts/smoke.ts against real API with 
  local ANTHROPIC_API_KEY (one-time verification)
- [ ] Manual: `node packages/cli/dist/main.js "list files"` with a local 
  ax.config.ts using llm='anthropic' completes with a real response
```

Commit (body of `gh pr create` — no file change).

---

### Task 9.3: After merge

**Files:**
- Modify: `.claude/memory/MEMORY.md`
- Create or modify: `.claude/memory/project_week_4_6_shipped.md`
- Create or modify: `.claude/memory/feedback_plan_revision_after_rollback.md` (new feedback memory — the rollback-plan-revise loop is itself a pattern worth remembering)

Entries:

- `project_week_4_6_shipped.md` — what merged in v2, which follow-ups fired, perf notes (sandbox-per-call overhead observed in tests, for Week 7–9 context).
- `feedback_plan_revision_after_rollback.md` — lesson: when a user rolls back a merged slice and asks for a revised plan at higher effort, fold every reviewer comment into the revised plan as an explicit invariant (I1–I12 pattern in this plan). Each invariant names the prior failure, the fix, and the task that closes it.

Commit: `chore(memory): Week 4-6 v2 shipped + revision-after-rollback pattern`.

---

## Risks & open threads (surface to reviewer)

1. **`tool-file-io` deliberately bypasses `sandbox:spawn`.** Conscious design: the path-boundary is the isolation primitive for file I/O, not a subprocess boundary. Called out in `packages/tool-file-io/SECURITY.md`. If the reviewer wants strict uniformity ("all tool:execute go through sandbox"), the fix is a tiny `file-io-via-sandbox` wrapper added in a follow-up.
2. **Single retry on LLM transient errors.** A provider outage lasting >1s still surfaces as `PluginError`. Not ideal for UX, but the alternative (exponential backoff with jitter) introduces schedule-holding and starvation considerations that are not trivial and deserve their own slice.
3. **`@anthropic-ai/sdk` transitive surface audit** lands in `SECURITY.md` but is not automatically re-audited on bumps. Week 7+ should consider a pnpm audit gate in CI.
4. **`tool-dispatcher` `calls: []` vs runtime lookup.** Documented exception to the `calls:` manifest invariant. If the reviewer wants stricter enforcement, options are: (a) declare `calls: ['tool:execute:*']` and teach `validateDependencyGraph` wildcard handling, or (b) accept the exception. (a) is slow to get right.
5. **Library-mode e2e diverges from binary-mode e2e.** We keep both (Week 3's binary-spawn test + v2's library test). If they drift, the next person finds the divergence; better than deadlock risk inside vitest.
6. **No uid/gid/ulimit/cgroup in the subprocess sandbox.** Documented scope limit in `packages/sandbox-subprocess/SECURITY.md`. Week 7–9 `@ax/sandbox-k8s` provides full process isolation via pod spec.

---

## Execution notes

- **Controller runs under `superpowers:subagent-driven-development`.** Read this plan once. Extract every task (0.1, 0.2, 0.3, 1.1, …, 9.3) into a TodoWrite list. For each task, dispatch a fresh implementer subagent with full task text + task-relevant context (files, predecessors, security-checklist block). After the implementer reports done, dispatch spec-compliance reviewer; after that's ✅, dispatch code-quality reviewer. Only then mark the task complete and move on.

- **Security-checklist re-invocation:** before starting Phase 1, Phase 2, Phase 4, Phase 5, Phase 6. The prefilled block in each phase is the intended output; the skill re-invocation is to sanity-check against the actual diff before the phase's final commit.

- **Boundary review re-invocation:** before writing the PR description (Task 9.2), re-walk each new hook's alternate-impl, leak-field, subscriber-risk answer against the implemented signature. If anything shifted, update the PR body.

- **Verification gate:** before marking each phase complete, run `pnpm -r build && pnpm -r test`. A phase is not complete until both are green.

- **Parallelism:** Phases 4 and 5 are independent after Phase 3. Subagent-driven-development forbids parallel implementer dispatches (they'd conflict). Run them sequentially but in either order — the controller picks.

- **Commit cadence:** each task ends with a commit. Most tasks produce 3–8 small commits. Do NOT squash during execution — the TDD trail is the reviewer's audit log.

- **Kill-switch:** if any task discovers a deviation from this plan (e.g., `SandboxSpawnInputSchema` doesn't match real usage, or legacy `safePath` behaves differently than assumed), STOP and surface the deviation to the user before silently re-writing the plan. Per feedback memory: `check plan vs reality before following`.
