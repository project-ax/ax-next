# Phase 6.6 Implementation Plan — rebuild e2e test coverage retired by Phase 6 PR-A

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the four end-to-end test files Phase 6 PR-A retired (one skipped CLI canary, one parked SDK-runner suite, two deleted preset acceptance suites) plus absorb the deleted `mcp-client.e2e.test.ts` MCP-stdio coverage. Build them against a **stub runner binary** shipped from `@ax/test-harness` so the chat pipeline can be exercised end-to-end without real Anthropic credentials, the real `claude` grandchild, or platform-specific SDK binaries.

**Architecture:** PR-A retired five tests because they all depended on the deleted mock-LLM topology (`@ax/llm-mock` + native runner). The replacement strategy is a small `stub-runner` binary in `@ax/test-harness/dist/` that speaks the IPC protocol fluently (issues `tool.list`, `tool.pre-call`, `tool.execute-host`, `event.tool-post-call`, `event.chat-end`) and replays a canned tool-call/assistant-message script from a JSON file. Tests inject the stub via a new `MainOptions.runnerBinaryOverride?: string` seam, and a `createTestProxyPlugin()` helper provides the `proxy:open-session`/`proxy:close-session` pair the orchestrator now requires. Production code (`@ax/agent-claude-sdk-runner`, `@ax/cli/main.ts`) gains nothing test-only beyond the single `runnerBinaryOverride` field.

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- pnpm workspace + tsconfig refs
- Existing `@ax/test-harness` infrastructure (`mcp-server-stub`, `mock-services`, `mock-workspace`, `test-host-tool`, `harness`)
- New: stub-runner binary + test-proxy plugin in `@ax/test-harness`
- No new top-level dependencies

**Out-of-scope (deferred):**

- Real-Anthropic e2e coverage. Already lives in `packages/cli/src/__tests__/credential-proxy.e2e.test.ts` (gated on `AX_TEST_ANTHROPIC_KEY`). Phase 6.6 doesn't change it.
- Phase 7's kernel-type audit. The stub runner consumes the same `LlmRequest`/`LlmResponse` schemas the real runner would — leaving them in place is part of why Phase 7 hasn't pulled them yet.
- Tool-dispatcher → mcp-client merge. Out of scope; Phase 6.6 just consumes the existing dispatcher.
- `@ax/agent-runner-core` merge. Same.
- A `darwin-only` gate. The stub runner is platform-neutral; tests run everywhere.

---

## Reality check — what PR-A retired vs. what we need to rebuild

| PR-A action | What it covered | Phase 6.6 replacement |
|---|---|---|
| `packages/cli/src/__tests__/e2e.test.ts:37` made `it.skip` ("runs a full chat and persists the outcome to SQLite") | CLI default-config canary: spawns the real CLI binary, completes a chat, writes audit-log row to SQLite. | **Re-enable** with stub runner. Same intent, same assertions on the SQLite outcome row. |
| `packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts` parked (300 LOC body trimmed in PR-A's review fix) | Week 6.5d acceptance test: full topology, host pre/post subscribers fire on built-in `Bash` AND host-mediated `test-host-echo` MCP tool, in-order. | **Rename** to `chat-pipeline.e2e.test.ts` (the new shape isn't SDK-runner-specific). Stub runner. Same pre/post + ordering assertions. |
| `packages/cli/src/__tests__/mcp-client.e2e.test.ts` deleted | MCP-stdio subprocess round-trip + dead-server graceful handling. | **New file** `packages/cli/src/__tests__/mcp-stdio.e2e.test.ts`. Stub runner + real `mcp-server-stub` subprocess. |
| `presets/k8s/src/__tests__/acceptance.test.ts` deleted | K8s preset CI canary: builds plugin set, completes a chat. | **New file**, same path. Stub runner. |
| `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts` deleted | Multi-tenant ACL gate: agent A's session cannot reach agent B's resources. | **New file**, same path. Stub runner with two scripts (one per tenant). |

**What stays:**

- `packages/cli/src/__tests__/credential-proxy.e2e.test.ts` — the real-Anthropic gated e2e. Untouched.
- `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (82 cases) — unit-level coverage of the real SDK runner's `query()` + IPC path. Untouched.
- `packages/mcp-client/src/__tests__/` (97 cases) — mcp-client plugin unit tests. Untouched.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/test-harness/src/index.ts` | Add new exports: `createStubRunnerScript()` schema, `createTestProxyPlugin()`. |
| `packages/test-harness/src/stub-runner.ts` (NEW) | The stub runner binary. Compiled to `dist/stub-runner.js`. |
| `packages/test-harness/src/test-proxy-plugin.ts` (NEW) | Test-only plugin that registers `proxy:open-session` + `proxy:close-session` with a dummy `proxyConfig` (endpoint never reached) plus optional `envMap` overrides. |
| `packages/test-harness/src/script-schema.ts` (NEW) | Zod schema + types for the stub runner's canned script JSON. |
| `packages/test-harness/__tests__/stub-runner.test.ts` (NEW) | Unit tests for the stub runner: parses script, dispatches IPC actions in order, exits cleanly. |
| `packages/test-harness/__tests__/test-proxy-plugin.test.ts` (NEW) | Unit tests for the proxy stub plugin's hook shapes. |
| `packages/test-harness/package.json` | Add `bin` entry for `ax-stub-runner` (so tests can `requireFromCli.resolve('@ax/test-harness/stub-runner')`). |
| `packages/cli/src/main.ts` | Add `MainOptions.runnerBinaryOverride?: string`. When set, replaces the hardcoded `requireFromCli.resolve('@ax/agent-claude-sdk-runner')` for the chat-orchestrator's `runnerBinary`. |
| `packages/cli/src/__tests__/e2e.test.ts` | Re-enable the skipped first test. Use stub runner via `runnerBinaryOverride` (or via the CLI's `node …` invocation: pass an env var that the test plugin reads). |
| `packages/cli/src/__tests__/chat-pipeline.e2e.test.ts` (renamed from `claude-sdk-runner.e2e.test.ts`) | Rebuild around stub runner + `createTestHostToolPlugin()` (already exists in test-harness). |
| `packages/cli/src/__tests__/mcp-stdio.e2e.test.ts` (NEW) | MCP subprocess round-trip via stub runner + `mcp-server-stub` from test-harness. |
| `presets/k8s/src/__tests__/acceptance.test.ts` (NEW) | K8s preset canary using stub runner + mocked `sandbox:open-session`. |
| `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts` (NEW) | Multi-tenant ACL test using stub runner. |
| `packages/cli/src/__tests__/credentials-wiring.test.ts` (existing) | May need a `runnerBinaryOverride` reference if any test relied on the old skipDefaultLlm seam. Audit during Task 1. |

**Reference patterns in the codebase to mirror:**

- Stub-server pattern: `packages/test-harness/src/mcp-server-stub.ts` + its `__tests__/mcp-server-stub.test.ts`. Same shape: a dedicated subprocess binary that's installed via package.json `bin` entry and dispatched via `node <path-to-dist>` in tests.
- IPC client usage: `packages/agent-runner-core/src/ipc-client.ts` (`createIpcClient`, action call shape, env wiring). The stub runner will reuse this — no need to reimplement the HTTP/IPC framing.
- Test harness pattern: `packages/test-harness/src/harness.ts` (`createTestHarness`). Tests build a minimal plugin set via this, register service stubs, run their assertions.

**Pre-execution greps the executor MUST re-run before Task 1:**

```bash
# Confirm the parked test files are in the state PR-A left them in.
ls -la packages/cli/src/__tests__/{e2e,claude-sdk-runner.e2e,credential-proxy.e2e}.test.ts
ls -la presets/k8s/src/__tests__/

# Confirm @ax/test-harness ships the existing helpers PR-B will build on.
grep -n "createTestHostToolPlugin\|mcp-server-stub" packages/test-harness/src/index.ts

# Confirm the runner binary is currently hardcoded in cli/main.ts.
grep -n "runnerBinary" packages/cli/src/main.ts | head -10

# Confirm the orchestrator's gating still requires proxy:open-session.
grep -n "proxy-not-loaded\|proxy:open-session" packages/chat-orchestrator/src/orchestrator.ts | head -5

# Confirm sandbox-subprocess still requires proxyConfig with endpoint XOR
# unixSocketPath. Plan picks "endpoint='http://127.0.0.1:1' (dummy)" for
# the test-proxy plugin — never reached because the stub runner makes no
# upstream calls.
grep -n "ProxyConfigSchema\|proxyConfig must set" packages/sandbox-subprocess/src/open-session.ts | head -5
```

If any deviation surfaces, STOP and reconcile before continuing.

---

## Invariants (verified per task)

PR-A's I1–I18 carry forward where they apply. Phase 6.6 adds I_R1–I_R5 (one per retired-test slot) plus four new ones (I19–I22).

**Carry-forwards from PR-A:**
- I1: `chat:end` fires exactly once per `agent:invoke` (every test asserts).
- I7: `proxy:close-session` fires once per `proxy:open-session` (the test-proxy plugin's lifecycle).
- I9: `pnpm build` + `pnpm test` clean across the workspace at every commit.
- I10: No new half-wired plugins or hooks. The stub runner + test-proxy plugin live in `@ax/test-harness`, registered via `extraPlugins` only when tests opt in.
- I12: `AgentInvokeInput` shape unchanged.
- I15: No retained package imports any deletion target (still zero).
- I17: Deterministic lockfile after `pnpm install`.
- I18: Orchestrator's `'proxy-hooks-misconfigured'` and `'proxy-not-loaded'` paths stay distinct.

**New (Phase 6.6 specific):**

- **I_R1 — Default-config CLI invocation completes a chat end-to-end (sans real Anthropic).** The skipped first test in `e2e.test.ts` runs again and asserts the SQLite outcome shape. *Prevents:* a regression where `@ax/cli`'s plugin wiring breaks the happy path silently.
- **I_R2 — Host pre/post subscribers fire in order across both built-in and MCP-host tool calls.** `chat-pipeline.e2e.test.ts` asserts the exact order driven by the canned script. *Prevents:* a regression in `tool.pre-call`/`event.tool-post-call` routing or in the host MCP server's classifier (the one that strips `mcp__ax-host-tools__` prefixes).
- **I_R3 — MCP-stdio subprocess round-trip succeeds AND a dead MCP server doesn't terminate the chat.** `mcp-stdio.e2e.test.ts` asserts both. *Prevents:* a regression in `@ax/mcp-client`'s subprocess lifecycle (server crash recovery, stderr framing, dispatch error mapping).
- **I_R4 — K8s preset boots its full plugin set and runs a chat through.** `presets/k8s/__tests__/acceptance.test.ts` asserts. *Prevents:* a preset wiring drift that ships green in unit tests but breaks the boot order.
- **I_R5 — Multi-tenant ACL gate: agent A's session cannot consume agent B's resources.** `multi-tenant-acceptance.test.ts` asserts cross-agent rejection. *Prevents:* a regression in `agents:resolve` or session-claim ACL.

**New (infrastructure):**

- **I19 — Stub runner exits 0 on a clean script and non-zero on a malformed script.** Unit-tested in `__tests__/stub-runner.test.ts`. *Prevents:* a stub that swallows IPC errors and looks green when it shouldn't.
- **I20 — Stub runner ships in `dist/` of `@ax/test-harness` (compiled, executable bit set).** Verified by the build pipeline; its `package.json` `bin` entry points there. *Prevents:* a stub that fails to resolve when consuming packages call `requireFromCli.resolve('@ax/test-harness/stub-runner')`.
- **I21 — `MainOptions.runnerBinaryOverride` is the only new field on `MainOptions` in PR-B.** Audit-log: `git diff main..HEAD packages/cli/src/main.ts | grep '^[+]\s*[a-z]\+:'` shows only this addition. *Prevents:* surface creep — Phase 6 already shrunk `MainOptions`, don't grow it.
- **I22 — Test infrastructure code lives in `@ax/test-harness`, not in production packages.** Stub runner, test-proxy plugin, script schema all in `@ax/test-harness`. The `@ax/cli` and `@ax/agent-claude-sdk-runner` source trees gain only the `runnerBinaryOverride` field. *Prevents:* test-only branches in production code (the stub-SDK-module alternative).

---

## Open questions resolved before execution

1. **Stub runner OR stub SDK module?** **Stub runner.**
   - The stub-SDK-module alternative (env-gated dynamic import inside `@ax/agent-claude-sdk-runner/src/main.ts`) puts test code in production. Phase 6 just shrunk that file; growing it back with `if (process.env.AX_TEST_STUB_QUERY_MODULE) ...` is a regression on intent.
   - The stub runner approach exercises everything PR-A actually needs to defend (CLI plugin wiring, sandbox subprocess spawn, IPC routing, host MCP server, pre/post subscribers) without exercising the SDK runner's internals — and the SDK runner has 82 unit tests that already cover those.
   - The renamed `chat-pipeline.e2e.test.ts` is more honest about what's tested.
2. **One JSON-script format for all tests, or per-test scripts?** **One JSON format, scripts per test.**
   - Schema lives in `@ax/test-harness/src/script-schema.ts`. Each test builds its own script literal in TypeScript and writes it to a tmp file, OR passes inline as a `Buffer`-backed env var (cap 64 KiB so we don't blow the env limit).
   - Plan picks env-var-passed inline (no tmp file). Faster, no cleanup, no fs race.
3. **How does the test proxy plugin satisfy `sandbox-subprocess`'s `proxyConfig` schema?** **Dummy endpoint.**
   - `endpoint: 'http://127.0.0.1:1'` (port 1 is unassigned; never reached because the stub runner makes no upstream calls).
   - `caCertPem: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n'` (a fixed test-only self-signed PEM, also never validated).
   - `envMap: { AX_TEST_STUB_SCRIPT: '<base64-of-script-json>' }` — the stub runner reads this to drive its behavior.
4. **Where does the script live — file path env var or inline base64?** **Inline base64 in `envMap`.**
   - Sidesteps tmp-file creation, cleanup, race conditions across parallel vitest workers.
   - Cap at 64 KiB (Node env-var limit on Linux is ~128 KiB total per process; 64 KiB per var is safe). All planned scripts fit (~1-3 KiB each).
5. **Does the renamed `chat-pipeline.e2e.test.ts` keep the darwin-only gate?** **No — drop the gate.**
   - The gate existed because the real SDK pulled in claude-sdk's platform-specific `claude` binary, which had libc-detection issues on Linux CI. The stub runner has no such dep.
   - Test runs on every platform/CI now.
6. **Does the e2e canary in `e2e.test.ts` get a stub runner via `runnerBinaryOverride` or via env var?** **Env var.**
   - The canary spawns the CLI binary (`spawnSync('node', [cliEntry, 'hi'])`). It can't pass `MainOptions` through the binary boundary.
   - Plan: `AX_TEST_RUNNER_BINARY_OVERRIDE` env var read by `cli/main.ts` and applied to chat-orchestrator's `runnerBinary` IFF set. Test sets it to the stub runner's `dist/stub-runner.js` path before invoking.
   - This adds **one** env-var read in production code, gated behind a `process.env.NODE_ENV === 'test'` AND `process.env.AX_TEST_RUNNER_BINARY_OVERRIDE !== undefined` check, so the production path is unaffected. (Decision: actually drop the `NODE_ENV` half-gate — `AX_TEST_*` is the convention; `NODE_ENV` is unreliable in subprocess invocation. The `AX_TEST_*` prefix is the test-only signal.)
7. **Does the k8s preset canary spawn a real subprocess sandbox?** **No.**
   - The deleted version tested at the plugin level via `createTestHarness` + a mocked `sandbox:open-session`. Same shape works here. The stub runner is invoked in-process (no spawn) for the preset acceptance — `runnerBinary` is just a path string the orchestrator hands the sandbox provider, and a mocked sandbox provider can ignore it.
   - The CLI e2e tests DO spawn — they're testing CLI binary boot.
8. **Do any tests need the credential-proxy actually loaded?** **No — opt out via `MainOptions.skipCredentialProxy: true`.**
   - The test-proxy plugin provides `proxy:open-session`/`proxy:close-session` so the orchestrator's gate passes.
   - Loading the real credential-proxy adds AX_CREDENTIALS_KEY + a seeded credential dance; we don't need that for chat-pipeline coverage.
9. **What does the stub runner's script support?** **Tool calls + assistant messages, in order.**
   - Each script entry: `{ kind: 'tool-call', name: string, input: unknown, executesIn: 'host' | 'sandbox', expectPostCall: boolean }` OR `{ kind: 'assistant-text', content: string }` OR `{ kind: 'finish', reason: 'end_turn' | 'tool_use' }`.
   - Stub runner replays in order, calls IPC for tool-host actions, fires `event.tool-post-call` after each, fires `event.chat-end` at the end. No retries, no streaming chunks (those are SDK-runner internals; out of scope).
10. **Does PR-B touch `@ax/audit-log`?** **No.** Same I11 carry-forward from Phase 6.
11. **Does PR-B touch `chat-orchestrator`?** **No.** Phase 6 already added `proxy-not-loaded`. PR-B just consumes the existing surface.

---

## Tasks

### Task 1: Pre-execution survey + baseline confirmation

**Goal:** Verify the workspace is at PR-A's HEAD and all retired-test slots are in the state PR-A left them. Memory `feedback_check_plan_vs_reality.md`.

**Files:** Read-only.

**Step 1.1: Confirm baseline**

```bash
git log --oneline main -1   # Should show "Merge pull request #24 …"
ls packages/cli/src/__tests__/{e2e,claude-sdk-runner.e2e,credential-proxy.e2e}.test.ts
ls packages/cli/src/__tests__/mcp-client.e2e.test.ts 2>&1   # Expected: not found
ls presets/k8s/src/__tests__/                                 # Expected: only preset.test.ts
```

**Step 1.2: Confirm `@ax/test-harness` exports**

```bash
grep -n "export" packages/test-harness/src/index.ts
```

Expected exports: `createTestHostToolPlugin`, plus harness/mock-services/mock-workspace/mcp-server-stub.

**Step 1.3: Confirm CLI runner-binary hardcode**

```bash
grep -n "runnerBinary" packages/cli/src/main.ts | head -10
```

Expected: a single `requireFromCli.resolve('@ax/agent-claude-sdk-runner')` site, no `runnerBinaryOverride` field on `MainOptions`.

**Step 1.4: Baseline build + test**

```bash
pnpm build
pnpm test
```

Expected: clean, 1590 passing / 4 skipped / 0 failing (PR-A's last numbers).

**Step 1.5: No commit** — read-only verification.

---

### Task 2: Define the stub runner's script schema

**Goal:** Land the JSON schema first (TDD-friendly: write tests against the schema before implementing the runner). Lives in `@ax/test-harness/src/script-schema.ts`.

**Files:**
- Create: `packages/test-harness/src/script-schema.ts`
- Create: `packages/test-harness/src/__tests__/script-schema.test.ts`
- Modify: `packages/test-harness/src/index.ts` (add export)

**Step 2.1: Write the schema test**

```ts
// packages/test-harness/src/__tests__/script-schema.test.ts
import { describe, it, expect } from 'vitest';
import { StubRunnerScriptSchema, encodeScript, decodeScript } from '../script-schema.js';

describe('StubRunnerScriptSchema', () => {
  it('accepts a minimal finish-only script', () => {
    const parsed = StubRunnerScriptSchema.parse({
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    });
    expect(parsed.entries).toHaveLength(1);
  });

  it('accepts a tool-call entry with executesIn=host', () => {
    const parsed = StubRunnerScriptSchema.parse({
      entries: [
        { kind: 'tool-call', name: 'test-host-echo', input: { text: 'hi' }, executesIn: 'host', expectPostCall: true },
        { kind: 'finish', reason: 'end_turn' },
      ],
    });
    expect(parsed.entries[0]?.kind).toBe('tool-call');
  });

  it('rejects an unknown entry kind', () => {
    const r = StubRunnerScriptSchema.safeParse({ entries: [{ kind: 'wat' }] });
    expect(r.success).toBe(false);
  });

  it('rejects a tool-call without name', () => {
    const r = StubRunnerScriptSchema.safeParse({
      entries: [{ kind: 'tool-call', input: {}, executesIn: 'host', expectPostCall: true }],
    });
    expect(r.success).toBe(false);
  });

  it('round-trips through encode/decode (base64 envMap path)', () => {
    const script = {
      entries: [
        { kind: 'assistant-text' as const, content: 'hello' },
        { kind: 'finish' as const, reason: 'end_turn' as const },
      ],
    };
    const encoded = encodeScript(script);
    const decoded = decodeScript(encoded);
    expect(decoded).toEqual(script);
  });

  it('encodeScript produces a string ≤ 64 KiB for typical scripts', () => {
    const script = StubRunnerScriptSchema.parse({
      entries: Array.from({ length: 50 }, () => ({ kind: 'assistant-text', content: 'lorem ipsum' as const })).concat([
        { kind: 'finish', reason: 'end_turn' as const },
      ]),
    });
    expect(encodeScript(script).length).toBeLessThan(64 * 1024);
  });
});
```

**Step 2.2: Run the test (FAIL — module doesn't exist)**

```bash
pnpm --filter @ax/test-harness test
```

Expected: FAIL.

**Step 2.3: Implement the schema**

```ts
// packages/test-harness/src/script-schema.ts
import { z } from 'zod';

export const StubRunnerScriptEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool-call'),
    name: z.string().min(1),
    input: z.unknown(),
    executesIn: z.enum(['host', 'sandbox']),
    expectPostCall: z.boolean(),
  }),
  z.object({
    kind: z.literal('assistant-text'),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('finish'),
    reason: z.enum(['end_turn', 'tool_use']),
  }),
]);

export const StubRunnerScriptSchema = z.object({
  entries: z.array(StubRunnerScriptEntrySchema).min(1),
});

export type StubRunnerScript = z.infer<typeof StubRunnerScriptSchema>;

export function encodeScript(script: StubRunnerScript): string {
  // base64-encode the JSON so we can pass via envMap without quoting headaches.
  return Buffer.from(JSON.stringify(script), 'utf-8').toString('base64');
}

export function decodeScript(encoded: string): StubRunnerScript {
  const json = Buffer.from(encoded, 'base64').toString('utf-8');
  return StubRunnerScriptSchema.parse(JSON.parse(json));
}
```

**Step 2.4: Add the export**

```ts
// packages/test-harness/src/index.ts (append)
export {
  StubRunnerScriptSchema,
  type StubRunnerScript,
  encodeScript,
  decodeScript,
} from './script-schema.js';
```

**Step 2.5: Run + commit**

```bash
pnpm --filter @ax/test-harness build
pnpm --filter @ax/test-harness test
```

Expected: PASS (~6 new tests).

```bash
git add packages/test-harness/src/script-schema.ts \
        packages/test-harness/src/__tests__/script-schema.test.ts \
        packages/test-harness/src/index.ts
git commit -m "feat(test-harness): add StubRunnerScript schema [Phase 6.6]"
```

---

### Task 3: Build the stub runner binary

**Goal:** Land `packages/test-harness/src/stub-runner.ts` — the binary the chat orchestrator spawns instead of `@ax/agent-claude-sdk-runner` for tests. Speaks the IPC protocol via `createIpcClient` from `@ax/agent-runner-core`.

**Files:**
- Create: `packages/test-harness/src/stub-runner.ts`
- Create: `packages/test-harness/__tests__/stub-runner.test.ts`
- Modify: `packages/test-harness/package.json` (add `bin` entry)
- Modify: `packages/test-harness/tsconfig.json` (verify build emits stub-runner.js)

**Step 3.1: Write the stub-runner integration test (TDD)**

The test spawns the stub-runner as a subprocess against a fake IPC server (similar to `agent-runner-core/__tests__/ipc-client.test.ts`'s `startFakeServer` pattern), passes a script via env, and asserts the IPC actions fire in order.

Test cases:
- `it('exits 0 on a finish-only script and fires event.chat-end exactly once')`
- `it('fires tool.list at startup before any tool-call entry')`
- `it('fires tool.execute-host for executesIn:host entries and synthesizes the post-call event')`
- `it('does NOT fire tool.execute-host for executesIn:sandbox entries (built-in tools — host has no execute role)')`
- `it('fires tool.pre-call before each tool-call entry')`
- `it('exits non-zero on a malformed script (unparseable JSON in env)')`
- `it('exits non-zero when AX_TEST_STUB_SCRIPT env var is missing')`
- `it('fires event.chat-end with the assistant-text content when present')`

Each test follows the pattern:
1. Build a script literal
2. base64-encode via `encodeScript`
3. Spawn `node dist/stub-runner.js` with `AX_TEST_STUB_SCRIPT=<encoded>`, `AX_RUNNER_ENDPOINT=unix://<sock>`, `AX_SESSION_ID=test`, `AX_AUTH_TOKEN=tok`, `AX_WORKSPACE_ROOT=/tmp/...`
4. Assert the fake IPC server saw the expected requests in order
5. Assert exit code

**Step 3.2: Implement the stub runner**

```ts
// packages/test-harness/src/stub-runner.ts
#!/usr/bin/env node
import { createIpcClient } from '@ax/agent-runner-core';
import { decodeScript, type StubRunnerScript } from './script-schema.js';

interface RunnerEnv {
  runnerEndpoint: string;
  sessionId: string;
  authToken: string;
  workspaceRoot: string;
  script: StubRunnerScript;
}

function readEnv(): RunnerEnv {
  const required = (k: string): string => {
    const v = process.env[k];
    if (v === undefined || v === '') {
      console.error(`stub-runner: missing required env var ${k}`);
      process.exit(2);
    }
    return v;
  };
  const runnerEndpoint = required('AX_RUNNER_ENDPOINT');
  const sessionId = required('AX_SESSION_ID');
  const authToken = required('AX_AUTH_TOKEN');
  const workspaceRoot = required('AX_WORKSPACE_ROOT');
  const encoded = required('AX_TEST_STUB_SCRIPT');
  let script: StubRunnerScript;
  try {
    script = decodeScript(encoded);
  } catch (err) {
    console.error(`stub-runner: failed to decode AX_TEST_STUB_SCRIPT: ${err}`);
    process.exit(2);
  }
  return { runnerEndpoint, sessionId, authToken, workspaceRoot, script };
}

async function run(): Promise<number> {
  const env = readEnv();
  const client = createIpcClient({
    runnerEndpoint: env.runnerEndpoint,
    token: env.authToken,
  });

  // Match the SDK runner's startup: list tools so the host knows what's
  // registered. We don't actually use the result, but firing the IPC keeps
  // the wire shape identical.
  await client.call('tool.list', {});

  const messages: { role: 'assistant'; content: string }[] = [];

  for (const entry of env.script.entries) {
    if (entry.kind === 'tool-call') {
      const callId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const call = { id: callId, name: entry.name, input: entry.input };
      const pre = await client.call('tool.pre-call', { call });
      if (pre.verdict === 'reject') continue; // honor host veto
      const finalCall = pre.verdict === 'allow' && pre.modifiedCall ? pre.modifiedCall : call;

      let output: unknown = { ok: true };
      if (entry.executesIn === 'host') {
        const result = await client.call('tool.execute-host', { call: finalCall });
        output = result.output;
      } else {
        // sandbox-side tool — stub runner pretends it ran and synthesizes
        // a trivial output. Real SDK runner would have run it via the
        // SDK's built-in tool. Tests don't need the actual execution; they
        // just assert the pre/post subscribers fire.
        output = { ok: true, simulated: true };
      }
      if (entry.expectPostCall) {
        await client.event('event.tool-post-call', {
          call: finalCall,
          output,
        });
      }
    } else if (entry.kind === 'assistant-text') {
      messages.push({ role: 'assistant', content: entry.content });
    } else if (entry.kind === 'finish') {
      // Fire chat:end with a complete outcome. The orchestrator's
      // chat:end subscribers (audit-log, conversations, channel-web)
      // pick this up.
      await client.event('event.chat-end', {
        outcome: { kind: 'complete', messages },
      });
      return 0;
    }
  }
  // Ran out of entries without a finish — that's a script bug.
  console.error('stub-runner: script ended without a finish entry');
  return 1;
}

run()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`stub-runner: fatal: ${err}`);
    process.exit(1);
  });
```

**Step 3.3: Wire the bin entry**

```json
// packages/test-harness/package.json (add to "bin")
"bin": {
  "ax-stub-runner": "./dist/stub-runner.js"
}
```

Verify `tsconfig.json` includes `src/stub-runner.ts` in the compile (it should — `include: ["src"]` is the existing pattern).

**Step 3.4: Run + commit**

```bash
pnpm --filter @ax/test-harness build
pnpm --filter @ax/test-harness test
```

Expected: PASS (~8 new tests).

```bash
git add packages/test-harness/src/stub-runner.ts \
        packages/test-harness/__tests__/stub-runner.test.ts \
        packages/test-harness/package.json
git commit -m "feat(test-harness): ship stub runner binary [Phase 6.6]"
```

---

### Task 4: Add the test-proxy plugin helper

**Goal:** A factory that registers `proxy:open-session` and `proxy:close-session` returning a dummy `proxyConfig` plus an injected `envMap` carrying the encoded stub script. Test code uses this instead of loading the real `@ax/credential-proxy`.

**Files:**
- Create: `packages/test-harness/src/test-proxy-plugin.ts`
- Create: `packages/test-harness/src/__tests__/test-proxy-plugin.test.ts`
- Modify: `packages/test-harness/src/index.ts` (add export)

**Step 4.1: Write the unit tests (TDD)**

```ts
// packages/test-harness/src/__tests__/test-proxy-plugin.test.ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '../harness.js';
import { createTestProxyPlugin, type StubRunnerScript } from '../index.js';

describe('createTestProxyPlugin', () => {
  it('registers proxy:open-session returning a dummy proxyConfig with the encoded script in envMap', async () => {
    const script: StubRunnerScript = {
      entries: [{ kind: 'finish', reason: 'end_turn' }],
    };
    const plugin = createTestProxyPlugin({ script });
    const h = await createTestHarness({ plugins: [plugin] });

    const result = await h.bus.call(
      'proxy:open-session', { /* ctx */ },
      { sessionId: 's1', userId: 'u1', allowlist: ['api.anthropic.com'] },
    );
    expect(result.proxyEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof result.caCertPem).toBe('string');
    expect(result.envMap.AX_TEST_STUB_SCRIPT).toBeDefined();
  });

  it('registers proxy:close-session as a no-op', async () => {
    const plugin = createTestProxyPlugin({ script: { entries: [{ kind: 'finish', reason: 'end_turn' }] } });
    const h = await createTestHarness({ plugins: [plugin] });
    const result = await h.bus.call('proxy:close-session', {}, { sessionId: 's1' });
    expect(result).toEqual({});
  });

  it('encodes the script as base64 in envMap', async () => {
    const script: StubRunnerScript = {
      entries: [
        { kind: 'assistant-text', content: 'hi' },
        { kind: 'finish', reason: 'end_turn' },
      ],
    };
    const plugin = createTestProxyPlugin({ script });
    const h = await createTestHarness({ plugins: [plugin] });
    const result = await h.bus.call('proxy:open-session', {}, { sessionId: 's1', userId: 'u1', allowlist: [] });
    const decoded = JSON.parse(Buffer.from(result.envMap.AX_TEST_STUB_SCRIPT, 'base64').toString('utf-8'));
    expect(decoded).toEqual(script);
  });
});
```

**Step 4.2: Implement**

```ts
// packages/test-harness/src/test-proxy-plugin.ts
import type { Plugin } from '@ax/core';
import { encodeScript, type StubRunnerScript } from './script-schema.js';

const DUMMY_CA_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBkTCB+wIJAJ...test-only never validated...\n' +
  '-----END CERTIFICATE-----\n';

interface TestProxyPluginOpts {
  script: StubRunnerScript;
  /** Optional extra envMap entries (merged after the script). Useful for
   *  custom test scenarios. */
  envExtra?: Record<string, string>;
}

export function createTestProxyPlugin(opts: TestProxyPluginOpts): Plugin {
  return {
    name: '@ax/test-harness/test-proxy',
    async init(bus) {
      const encoded = encodeScript(opts.script);
      bus.registerService('proxy:open-session', async () => ({
        proxyEndpoint: 'http://127.0.0.1:1', // never reached
        caCertPem: DUMMY_CA_PEM,
        envMap: {
          AX_TEST_STUB_SCRIPT: encoded,
          ...(opts.envExtra ?? {}),
        },
      }));
      bus.registerService('proxy:close-session', async () => ({}));
    },
  };
}
```

**Step 4.3: Export**

```ts
// packages/test-harness/src/index.ts (append)
export { createTestProxyPlugin } from './test-proxy-plugin.js';
```

**Step 4.4: Run + commit**

```bash
pnpm --filter @ax/test-harness build
pnpm --filter @ax/test-harness test
```

Expected: PASS.

```bash
git add packages/test-harness/src/test-proxy-plugin.ts \
        packages/test-harness/src/__tests__/test-proxy-plugin.test.ts \
        packages/test-harness/src/index.ts
git commit -m "feat(test-harness): add createTestProxyPlugin helper [Phase 6.6]"
```

---

### Task 5: Add `MainOptions.runnerBinaryOverride` test seam to `@ax/cli`

**Goal:** A single new field on `MainOptions` (and a single env-var read for the binary-spawn case) that lets tests substitute the runner. I21 + I22 cap the surface area.

**Files:**
- Modify: `packages/cli/src/main.ts` (add field + apply it)
- Modify: `packages/cli/src/__tests__/main-options.test.ts` (NEW or amend existing) — assert the field exists and overrides the resolve

**Step 5.1: Write the unit test**

```ts
// packages/cli/src/__tests__/main-options.test.ts (NEW)
import { describe, it, expect } from 'vitest';
import { main } from '../main.js';
import type { MainOptions } from '../main.js';

describe('MainOptions.runnerBinaryOverride', () => {
  it('uses the override when set', async () => {
    // Mock the chat-orchestrator factory to capture its runnerBinary arg.
    // (Pattern: spy on the factory via vi.mock — see existing main tests
    // for the shape.)
    // … assertion: the captured runnerBinary equals the override path,
    // not the @ax/agent-claude-sdk-runner resolve.
  });

  it('falls back to @ax/agent-claude-sdk-runner when override is absent', async () => {
    // … assertion: the captured runnerBinary ends in /agent-claude-sdk-runner/dist/main.js.
  });

  it('reads AX_TEST_RUNNER_BINARY_OVERRIDE env var as a fallback override', async () => {
    process.env.AX_TEST_RUNNER_BINARY_OVERRIDE = '/tmp/fake-runner.js';
    // … assertion: captured runnerBinary === '/tmp/fake-runner.js'.
    delete process.env.AX_TEST_RUNNER_BINARY_OVERRIDE;
  });
});
```

**Step 5.2: Implement**

In `packages/cli/src/main.ts`:

```ts
export interface MainOptions {
  // … existing fields (extraPlugins, skipCredentialProxy)
  /**
   * Test-only seam: override the runner binary path. When set, the chat
   * orchestrator spawns this instead of @ax/agent-claude-sdk-runner.
   *
   * Production code never sets this. Tests use it to substitute the
   * stub runner from @ax/test-harness.
   *
   * Also accepts the AX_TEST_RUNNER_BINARY_OVERRIDE env var (so the
   * `cli` binary entrypoint, which can't pass MainOptions through the
   * argv boundary, can still substitute via env).
   */
  runnerBinaryOverride?: string;
}

// … inside main():
const runnerBinary =
  opts.runnerBinaryOverride ??
  process.env.AX_TEST_RUNNER_BINARY_OVERRIDE ??
  requireFromCli.resolve('@ax/agent-claude-sdk-runner');

plugins.push(createChatOrchestratorPlugin({
  runnerBinary,
  chatTimeoutMs,
}));
```

**Step 5.3: Run + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: PASS.

```bash
git add packages/cli/src/main.ts packages/cli/src/__tests__/main-options.test.ts
git commit -m "feat(cli): add MainOptions.runnerBinaryOverride test seam [Phase 6.6]"
```

---

### Task 6: Re-enable `e2e.test.ts` default-config canary (I_R1)

**Goal:** Restore the `it.skip` test in `packages/cli/src/__tests__/e2e.test.ts` to active, using the stub runner via the env var seam.

**Files:**
- Modify: `packages/cli/src/__tests__/e2e.test.ts` (un-skip + plumb stub)

**Step 6.1: Update the test**

```ts
it('runs a full chat and persists the outcome to SQLite', () => {
  workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
  const dbPath = join(workDir, 'e2e.sqlite');

  const stubRunnerPath = require.resolve('@ax/test-harness/dist/stub-runner.js');
  const script = encodeScript({
    entries: [
      { kind: 'assistant-text', content: 'hello' },
      { kind: 'finish', reason: 'end_turn' },
    ],
  });

  const result = spawnSync('node', [cliEntry, 'hi'], {
    env: {
      ...process.env,
      AX_DB: dbPath,
      AX_CREDENTIALS_KEY: '42'.repeat(32),
      AX_TEST_RUNNER_BINARY_OVERRIDE: stubRunnerPath,
      // Need a test-proxy: the orchestrator's `proxy-not-loaded` gate
      // requires proxy:open-session registered. We pass the script via
      // AX_TEST_STUB_PROXY=1 + AX_TEST_STUB_SCRIPT_BASE64=<encoded>;
      // a tiny init-time hook in cli/main.ts loads the test-proxy plugin
      // when AX_TEST_STUB_PROXY=1 is set.
      AX_TEST_STUB_PROXY: '1',
      AX_TEST_STUB_SCRIPT_BASE64: script,
    },
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('hello');
  // … existing SQLite assertions
});
```

**Step 6.2: Wire the `AX_TEST_STUB_PROXY` opt-in in `cli/main.ts`**

Add this above the credential-proxy load block (production code, but SAME pattern as `runnerBinaryOverride` — gated by `AX_TEST_*` env var, no impact unless explicitly opted-in):

```ts
if (process.env.AX_TEST_STUB_PROXY === '1') {
  const { createTestProxyPlugin, decodeScript } = await import('@ax/test-harness');
  const encoded = process.env.AX_TEST_STUB_SCRIPT_BASE64;
  if (encoded === undefined) {
    throw new Error('AX_TEST_STUB_PROXY=1 requires AX_TEST_STUB_SCRIPT_BASE64');
  }
  plugins.push(createTestProxyPlugin({ script: decodeScript(encoded) }));
} else if (opts.skipCredentialProxy !== true) {
  plugins.push(createCredentialProxyPlugin(/* … */));
}
```

This adds ONE conditional branch in production code, gated explicitly by `AX_TEST_*` (the convention). I22 boundary holds — the test infrastructure (proxy plugin, script schema) lives in `@ax/test-harness`; only the env-gated import lives in `@ax/cli`.

**Step 6.3: Run + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: PASS, including the now-unskipped canary.

```bash
git add packages/cli/src/main.ts packages/cli/src/__tests__/e2e.test.ts
git commit -m "test(cli): re-enable default-config canary using stub runner [Phase 6.6]"
```

---

### Task 7: Build `chat-pipeline.e2e.test.ts` (I_R2)

**Goal:** Replace the parked `claude-sdk-runner.e2e.test.ts` with a renamed `chat-pipeline.e2e.test.ts` that exercises:
- Full CLI plugin wiring
- Sandbox subprocess spawn (real)
- IPC dispatch (real)
- Host MCP server routing for `executesIn:'host'` tools (via `tool.execute-host`)
- `tool:pre-call` and `event.tool-post-call` host subscribers fire IN ORDER for both built-in and host-mediated tools

**Files:**
- Delete: `packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts`
- Create: `packages/cli/src/__tests__/chat-pipeline.e2e.test.ts`

**Step 7.1: Build the script and assertions**

The script drives the stub runner through:
1. Built-in `Bash` call (`executesIn: 'sandbox'`, `expectPostCall: true`)
2. Host-mediated `test-host-echo` MCP call (`executesIn: 'host'`, `expectPostCall: true`)
3. Assistant text "ok"
4. Finish

Test plugin set:
- `extraPlugins: [createTestProxyPlugin({ script }), createTestHostToolPlugin()]`
- Subscribe to `tool:pre-call` and `event.tool-post-call` on the host bus, capture the order

Assertions:
- Process exit code 0
- Pre-call events fire in order: `Bash`, `test-host-echo`
- Post-call events fire in order: `Bash`, `test-host-echo`
- The classifier strips `mcp__ax-host-tools__` — host subscribers see `test-host-echo`, NOT `mcp__ax-host-tools__test-host-echo`

**Step 7.2: Drop the darwin-only gate**

The stub runner has no platform-specific deps. Test runs everywhere now.

**Step 7.3: Run + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: PASS.

```bash
git rm packages/cli/src/__tests__/claude-sdk-runner.e2e.test.ts
git add packages/cli/src/__tests__/chat-pipeline.e2e.test.ts
git commit -m "test(cli): rebuild chat-pipeline e2e using stub runner [Phase 6.6]"
```

---

### Task 8: Build `mcp-stdio.e2e.test.ts` (I_R3)

**Goal:** Restore the MCP-stdio coverage that retired with `mcp-client.e2e.test.ts`. Stub runner + real `mcp-server-stub` subprocess from `@ax/test-harness`.

**Files:**
- Create: `packages/cli/src/__tests__/mcp-stdio.e2e.test.ts`

**Step 8.1: Build the test cases**

Two cases:
- `it('round-trips a tool call through MCP and fires host pre/post subscribers')` — drives the stub MCP server's `echo` tool via the stub runner script.
- `it('surfaces MCP_SERVER_UNAVAILABLE without terminating the chat when the server dies')` — script calls `crash` then continues. Assert `rc === 0` and the chat completes.

**Step 8.2: Run + commit**

```bash
pnpm --filter @ax/cli build
pnpm --filter @ax/cli test
```

Expected: PASS.

```bash
git add packages/cli/src/__tests__/mcp-stdio.e2e.test.ts
git commit -m "test(cli): rebuild mcp-stdio e2e using stub runner [Phase 6.6]"
```

---

### Task 9: Build `presets/k8s/__tests__/acceptance.test.ts` (I_R4)

**Goal:** K8s preset CI canary against the stub runner. Asserts the preset's plugin set boots cleanly and a chat completes.

**Files:**
- Create: `presets/k8s/src/__tests__/acceptance.test.ts`

**Step 9.1: Build the test**

The deleted version used `llmMockPlugin()` to drive a canned chat. The new version uses `createTestProxyPlugin({ script })` + a mocked `sandbox:open-session` that simulates the k8s sandbox provider's behavior (reads the `runnerBinary` arg, spawns the stub-runner via `node`, threads IPC).

The test exercises:
1. K8s preset's plugin set initializes (`pnpm test --filter @ax/preset-k8s` exit 0)
2. A chat through the preset returns `outcome: { kind: 'complete' }`
3. Audit-log row written to in-memory storage

**Step 9.2: Run + commit**

```bash
pnpm --filter @ax/preset-k8s build
pnpm --filter @ax/preset-k8s test
```

Expected: PASS.

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(preset-k8s): rebuild acceptance canary using stub runner [Phase 6.6]"
```

---

### Task 10: Build `presets/k8s/__tests__/multi-tenant-acceptance.test.ts` (I_R5)

**Goal:** Multi-tenant ACL gate. Two agents, two sessions; agent A's session-claim CANNOT consume agent B's resources.

**Files:**
- Create: `presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts`

**Step 10.1: Build the test**

Setup:
- Register two agents A and B via `agents:resolve` mock (returns different agents based on `agentId` in request)
- Two stub-runner scripts (one per session)
- Two `agent:invoke` calls in parallel (or sequential), one per agent
- Assert each session's chat:end carries the right `agentId`
- Try a cross-tenant call: agent A's session token attempts to read agent B's resource → `agents:resolve` rejects → outcome `'terminated'` with `reason: 'agents-resolve-rejected'` (or whatever the existing reason string is)

**Step 10.2: Run + commit**

```bash
pnpm --filter @ax/preset-k8s build
pnpm --filter @ax/preset-k8s test
```

Expected: PASS.

```bash
git add presets/k8s/src/__tests__/multi-tenant-acceptance.test.ts
git commit -m "test(preset-k8s): rebuild multi-tenant ACL canary using stub runner [Phase 6.6]"
```

---

### Task 11: Final verification + boundary-review note

**Goal:** Confirm the workspace is green, every retired-test slot has a replacement, and the new surface area on `MainOptions` is minimal.

**Step 11.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: ~1610+ tests passing (1590 baseline + ~20 new — Task 2 schema tests + Task 3 stub-runner tests + Task 4 proxy-plugin tests + Task 5 main-options tests + 5 rebuilt e2e tests).

**Step 11.2: I21 audit**

```bash
git diff main..HEAD packages/cli/src/main.ts | grep '^[+]\s*[a-z]\+:' | grep -v '^[+]\s*\(name\|init\|require\|import\)'
```

Expected: ONE new field — `runnerBinaryOverride?: string`. If more, reconcile.

**Step 11.3: I22 audit**

```bash
git diff main..HEAD --stat | grep -E 'packages/(test-harness|cli|chat-orchestrator|agent-claude-sdk-runner)/src/'
```

Expected: stub runner / proxy plugin / script schema all in `packages/test-harness/`. CLI gains only the `runnerBinaryOverride` field + the `AX_TEST_STUB_PROXY` env-gated import branch. `agent-claude-sdk-runner` has zero changes.

**Step 11.4: Compose the boundary-review block**

Phase 6.6 doesn't add new hooks. Single boundary surface to call out: `MainOptions.runnerBinaryOverride` (test-only). Document in PR description:

```markdown
## Boundary review — runnerBinaryOverride seam

- **Alternate impl this contract could have:** none — `runnerBinary` is a path, not a hook signature. Future runners satisfy the IPC contract.
- **Payload field names that might leak:** none. `runnerBinaryOverride: string` is just a path.
- **Subscriber risk:** none — this is a startup-time path resolution.
- **Wire surface:** none. The override changes WHICH binary spawns; the binary's IPC contract is unchanged.
```

**Step 11.5: No commit** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1 | `chat:end` fires exactly once per `agent:invoke` | All five rebuilt tests assert |
| I7 | `proxy:close-session` fires once per `proxy:open-session` | Test-proxy plugin's lifecycle, asserted in chat-pipeline.e2e |
| I9 | Workspace clean per commit | Per-task `pnpm build` + `pnpm test` |
| I10 | No new half-wired plugins | Stub runner + proxy plugin live in `@ax/test-harness`, opt-in via `extraPlugins`/env vars |
| I12 | `AgentInvokeInput` shape unchanged | `git diff main..HEAD packages/chat-orchestrator/src/orchestrator.ts` shows zero `AgentInvokeInput` edits |
| I15 | No retained imports of deleted packages | `rg "from '@ax/(llm-anthropic\|llm-mock\|...)'"` returns zero |
| I17 | Deterministic lockfile | `pnpm install --frozen-lockfile` clean |
| I18 | Orchestrator gating paths stay distinct | Existing tests still pass |
| I_R1 | Default-config CLI canary completes a chat | `e2e.test.ts` first test runs (no longer skipped) |
| I_R2 | Pre/post subscribers fire in order across built-in and MCP-host tools | `chat-pipeline.e2e.test.ts` asserts |
| I_R3 | MCP-stdio round-trip works; dead server doesn't terminate chat | `mcp-stdio.e2e.test.ts` asserts both |
| I_R4 | K8s preset boots and runs a chat | `acceptance.test.ts` asserts |
| I_R5 | Multi-tenant ACL gate rejects cross-tenant access | `multi-tenant-acceptance.test.ts` asserts |
| I19 | Stub runner exits 0 on clean script, non-zero on malformed | `__tests__/stub-runner.test.ts` asserts both |
| I20 | Stub runner ships in `dist/`, executable | Build pipeline + bin entry |
| I21 | One new field on `MainOptions` | Task 11.2 audit |
| I22 | Test infrastructure stays in `@ax/test-harness` | Task 11.3 audit |

---

## Phase 6 PR-A lessons feeding into Phase 6.6

| Lesson | How it shapes Phase 6.6 |
|---|---|
| **`feedback_check_plan_vs_reality.md`** — Phase 5's CLI test fallout exceeded the plan's expectation. | Task 1 is a read-only baseline confirming `e2e.test.ts:37` is `it.skip`, `claude-sdk-runner.e2e.test.ts` is the trimmed-to-35-line placeholder, and the two preset tests don't exist. If reality differs, STOP. |
| **`feedback_targeted_followup_commits.md`** — small follow-up commits beat amends. | Each task is its own commit. Review-driven fixes get their own commits, not amends. |
| **`feedback_minor_issues_non_blocking.md`** — reviewer Minor + ship = ship. | Don't gate on "perfect" stub runner ergonomics; ship when the five I_R invariants are restored. |
| **`feedback_plan_revision_after_rollback.md`** — number invariants explicitly. | Phase 6.6 has 22 invariants (PR-A's 18 + 4 new). Each I_R earns its slot — see Acceptance criteria. |
| **`feedback_half_wired_window_pattern.md`** — close windows in the same PR. | The stub runner is loaded by tests in the same PR that ships the binary. The `AX_TEST_STUB_PROXY` env-gate is loaded by the env-checking branch in cli/main.ts in the same PR that ships `createTestProxyPlugin`. No half-wiring. |
| **PR-A reviewer feedback — explicit close-spy beats structural implication.** | `chat-pipeline.e2e.test.ts` asserts pre/post counts AND order via direct subscribers, not via "if X is registered, close must have been called." |
| **PR-A reviewer feedback — trim parked test bodies, don't leave dead seams.** | When deleting `claude-sdk-runner.e2e.test.ts`, the new `chat-pipeline.e2e.test.ts` is built from scratch — no copy-pasted dead seams. |

---

## Estimated landing

- **Tasks:** 11 (1 read-only survey + 9 substantive + 1 verification).
- **Commits:** ~9-10 (one per task; rebuild tasks may need 2 commits if a test reveals a stub-runner gap).
- **Files touched:** ~15-20 (5 new in `@ax/test-harness`, 1 modified + 4 new tests in `@ax/cli`, 2 new in `presets/k8s`, plus tsconfig/package.json deltas).
- **LOC delta:** approximately **+800-1200 LOC** (stub runner + helpers + 5 e2e tests, against +0 production-code growth besides 2 small env-gate branches).
- **Risk:** **Medium.** The IPC client's wire shape is well-tested at the unit level, but the stub runner is a fresh integration. Most likely friction: (a) the canned-script schema needs a couple of iterations to fit all five test scenarios; (b) the k8s preset's mocked sandbox provider needs attention to thread the stub-runner binary path correctly through `sandbox:open-session`. Both are surfaced early (Tasks 3 and 9) and are bisect-friendly.
- **Predecessors:** Phase 6 PR-A (PR #24, merged). Hard dependency.
- **Successors:**
  - **Phase 7** — kernel-type audit + audit-log subscription switch + AgentMessage role narrowing.
  - **Tool-dispatcher → mcp-client merge** — separate slice.
  - **`@ax/agent-runner-core` merge into SDK runner** — separate slice.

---

## Out-of-scope reminder

Phase 6.6 does NOT:

- Modify `@ax/agent-claude-sdk-runner/src/main.ts` beyond the zero-change baseline.
- Change `chat-orchestrator` (Phase 6 PR-A's `proxy-not-loaded` is consumed as-is).
- Change `@ax/audit-log` (Phase 7 owns the subscription switch).
- Add new IPC actions or hook signatures.
- Touch `@ax/tool-dispatcher`'s catalog ownership.
- Restore `@ax/llm-mock` or any other deleted package.
- Add a real-Anthropic e2e (the existing `credential-proxy.e2e.test.ts` already covers that path, gated).
