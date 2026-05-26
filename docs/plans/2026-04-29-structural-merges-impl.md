# Structural merges — `@ax/agent-runner-core` and `@ax/tool-dispatcher` collapse

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drop two package boundaries deferred since Phase 5. Slice 1 collapses `@ax/agent-runner-core` into a split: the IPC client + errors move to `@ax/ipc-protocol` (shared by SDK runner and test-harness stub-runner), the agent-runtime helpers (`inbox-loop`, `local-dispatcher`, `diff-accumulator`) move into `@ax/agent-claude-sdk-runner`. Slice 2 collapses `@ax/tool-dispatcher` into `@ax/mcp-client` so the catalog (`tool:register` / `tool:list`) lives in the same plugin that produces tool descriptors.

**Architecture:** Both merges are pure structural collapses — same code, fewer package boundaries. No new hooks, no new IPC actions, no behavior change. Each merge ships as its own PR with bisect-friendly commit pairs (move source first, delete the empty package + update consumers second).

**Tech Stack:**

- TypeScript / Node 20+
- Vitest (`.test.ts` per package)
- pnpm workspace + tsconfig refs
- No new dependencies; no protocol additions

---

## Out-of-scope (deferred)

- **Behavior changes inside any of these packages.** Pure file moves + import path updates. If a refactor opportunity surfaces during the move, surface it as a follow-up — don't bundle.
- **README narrative refresh** (`landing/install.html` still has `chat:start → llm:pre-call → llm:call` prose). Separate writing pass.
- **`cfg.sandbox` / `cfg.storage` single-value enum collapse.** Phase 7 noted; separate slice.
- **Stale `audit-log` comments in unrelated files** (cross-slice reviewer flagged 6+ sites). Separate sweep PR.
- **channel-web sidebar-collapse `useEffect` race** (CI flake on PR #26). Unrelated to these merges; separate fix.
- **Phase 6 deletion litter** (untracked `dist/` in 8 deleted packages). `pnpm clean` housekeeping.

---

## Reality check vs. user's stated assumption

**Memory `feedback_check_plan_vs_reality.md` applies.** The user's TODO described `agent-runner-core` as having "the SDK runner is now the only consumer". Pre-execution survey at HEAD shows that's NOT true:

| Consumer | What it imports |
|---|---|
| `packages/agent-claude-sdk-runner/src/{main,pre-tool-use,post-tool-use,host-mcp-server,can-use-tool,workspace-diff}.ts` + 5 test files | `IpcClient`, `DiffAccumulator`, `createDiffAccumulator`, `toWireChanges`, `SessionInvalidError`, others |
| **`packages/test-harness/src/stub-runner.ts:20`** | `createIpcClient` ← THIS IS THE SURPRISE |

The Phase 6.6 stub-runner (which I helped land) reuses `createIpcClient` to speak the IPC protocol fluently. That's by design — re-implementing IPC framing in the test harness would have been a clear violation of "one source of truth". So `agent-runner-core` has TWO production code paths today: the SDK runner AND the test-harness stub-runner.

**Why this matters:** a naive merge into `@ax/agent-claude-sdk-runner` would force `@ax/test-harness` to depend on `@ax/agent-claude-sdk-runner` to consume the IPC client. That drags `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk` into every test-harness consumer's bundle. Bloat + reverse direction (test-harness should not depend on a runner; the runner depends on test infra in tests, not the other way around).

**Resolution:** split, don't fold. Specifically:

- **`createIpcClient`, `IpcClient`, `IpcClientOptions`, `HostUnavailableError`, `IpcRequestError`, `SessionInvalidError`** → move into `@ax/ipc-protocol`. These are the wire helpers that pair naturally with the wire schemas. Both SDK runner and stub-runner already depend on `@ax/ipc-protocol`; this consolidates rather than fragments.
- **`createInboxLoop` + `InboxLoop` + `InboxLoopEntry` + `InboxLoopOptions`** → move into `@ax/agent-claude-sdk-runner` (sole consumer is the SDK runner's main loop).
- **`createLocalDispatcher` + `LocalDispatcher` + `LocalToolExecutor`** → move into `@ax/agent-claude-sdk-runner` (sole consumer; sandbox-side tool dispatch).
- **`createDiffAccumulator` + `toWireChanges` + `DiffAccumulator` + `AccumulatedFileChange`** → move into `@ax/agent-claude-sdk-runner` (sole consumer; per-turn diff helper).

After Slice 1: `@ax/agent-runner-core` is empty and deletes; `@ax/ipc-protocol` gains a small set of wire-client helpers; `@ax/agent-claude-sdk-runner` gains 4 internal modules.

For `@ax/tool-dispatcher`, the user's reality is mostly correct:

| Consumer | Type |
|---|---|
| `packages/cli/src/main.ts:23` | Production wiring |
| `presets/k8s/src/index.ts:11` | Production wiring |
| `packages/test-harness/src/__tests__/test-host-tool.test.ts:10` | Test |
| `packages/mcp-client/src/__tests__/plugin.test.ts:37` | Test (in merge target) |
| `packages/mcp-client/src/__tests__/admin-routes.test.ts:22` | Test (in merge target) |

After merge: 2 production wiring updates (CLI + preset import from mcp-client), 1 test-harness import update, 2 mcp-client tests collapse to relative imports.

---

## Slicing decision: two PRs, sequenced

Recommend **two separate PRs**, in order: agent-runner-core first, tool-dispatcher second. Reasons:

- **Different consumer footprints.** Slice 1 has zero production-wiring changes (the `@ax/cli` and `presets/k8s` `package.json` files don't list `agent-runner-core` directly — only the SDK runner and test-harness do). Slice 2 has 2 production-wiring changes (CLI + preset must swap `createToolDispatcherPlugin` → `createMcpClientPlugin` or equivalent).
- **Different risk profiles.** Slice 1 is mostly internal-to-package moves with one cross-package destination (`ipc-protocol`). Slice 2 changes plugin-load order in production presets.
- **Independent.** Neither blocks the other; reverting one doesn't affect the other.
- **Bisect cleanliness.** If Slice 2 surfaces an unexpected friction in the catalog merge, Slice 1's deletion of `agent-runner-core` should not roll back with it.

If reviewer prefers one PR with two slice-commits, the work is small enough (~−400 net LOC across both) that bundling is reasonable too. Each task below specifies its commit; the executor can re-bundle into one PR by merging task lists if directed.

**Slice 1 — `@ax/agent-runner-core` collapse** lands first (smaller diff, lower risk, no production wiring change).

**Slice 2 — `@ax/tool-dispatcher` → `@ax/mcp-client` merge** lands second.

---

## Reference material

ax-next files this plan touches (read before editing):

| File | Why |
|---|---|
| `packages/agent-runner-core/src/{ipc-client,errors,inbox-loop,local-dispatcher,diff-accumulator}.ts` | Slice 1. Source modules to move. |
| `packages/agent-runner-core/src/__tests__/*.test.ts` | Slice 1. Test files move with their source. |
| `packages/agent-runner-core/{package.json,tsconfig.json}` | Slice 1. Package itself deletes after empty. |
| `packages/ipc-protocol/src/index.ts` | Slice 1. New exports for `createIpcClient`, `IpcClient`, `IpcClientOptions`, `HostUnavailableError`, `IpcRequestError`, `SessionInvalidError`. |
| `packages/ipc-protocol/{package.json,tsconfig.json}` | Slice 1. May need new test deps for the moved tests. |
| `packages/agent-claude-sdk-runner/src/{main,pre-tool-use,post-tool-use,host-mcp-server,can-use-tool,workspace-diff}.ts` + tests | Slice 1. Update imports from `@ax/agent-runner-core` to either `@ax/ipc-protocol` (for IPC client + errors) or relative paths (for inbox-loop/local-dispatcher/diff-accumulator). |
| `packages/agent-claude-sdk-runner/{package.json,tsconfig.json}` | Slice 1. Drop `@ax/agent-runner-core` dep + tsconfig ref. |
| `packages/test-harness/src/stub-runner.ts` | Slice 1. Update import from `@ax/agent-runner-core` → `@ax/ipc-protocol`. |
| `packages/test-harness/{package.json,tsconfig.json}` | Slice 1. Drop `@ax/agent-runner-core` dep + tsconfig ref. |
| `tsconfig.json` (root) | Slices 1 + 2. Drop ref to deleted package. |
| `packages/tool-dispatcher/src/{plugin,catalog,scope}.ts` | Slice 2. Source modules to move. |
| `packages/tool-dispatcher/src/__tests__/*.test.ts` | Slice 2. Test files move. |
| `packages/mcp-client/src/plugin.ts` | Slice 2. New: register `tool:register` + `tool:list` services (currently registered by tool-dispatcher; mcp-client consumes them). |
| `packages/mcp-client/src/{catalog,scope}.ts` (NEW) | Slice 2. Catalog implementation moves here. |
| `packages/mcp-client/src/__tests__/{dispatch,list-with-agent-scope,scope}.test.ts` (NEW) | Slice 2. Tests move here. |
| `packages/mcp-client/src/index.ts` | Slice 2. Export `createToolDispatcherPlugin` from here for the cli + preset import paths to switch. *(Or rename the plugin factory; see Open question 1.)* |
| `packages/cli/src/main.ts` + `package.json` + `tsconfig.json` | Slice 2. Switch `@ax/tool-dispatcher` import → `@ax/mcp-client`. Drop dep + ref. |
| `presets/k8s/src/index.ts` + `package.json` + `tsconfig.json` | Slice 2. Same. |
| `packages/test-harness/src/__tests__/test-host-tool.test.ts` | Slice 2. Switch import. |
| `packages/mcp-client/{package.json,tsconfig.json}` | Slice 2. Drop dev-dep on `@ax/tool-dispatcher` (currently uses it in tests); add absorbed deps if any. |
| `packages/tool-dispatcher/{package.json,tsconfig.json}` | Slice 2. Package deletes. |

**Reference patterns in the codebase to mirror:**

- Hard-cut deletion precedent: Phase 6 PR-A and Phase 7. Same shape: re-grep before each task; commit-pair pattern (move/update consumers in commit A, delete package + drop refs in commit B).
- Cross-package move precedent: none in ax-next yet — this plan sets the pattern.
- Half-wired window: every move pair must close in the same PR (consumer migrated + package deleted in lockstep, no "we'll wire it later" intermediate state).

**Pre-execution greps the executor MUST re-run before Task 1:**

```bash
# Confirm the consumer footprints are still as the plan describes.
echo "=== @ax/agent-runner-core consumers ==="
rg -n "from ['\"]@ax/agent-runner-core['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/'

echo "=== @ax/tool-dispatcher consumers ==="
rg -n "from ['\"]@ax/tool-dispatcher['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/'

# Confirm @ax/ipc-protocol does NOT already export createIpcClient (collision check).
grep -n "createIpcClient\|IpcClientOptions" packages/ipc-protocol/src/index.ts

# Confirm @ax/mcp-client does NOT already register tool:register / tool:list services.
grep -n "registerService.*tool:register\|registerService.*tool:list" packages/mcp-client/src/plugin.ts

# Phase 6/7 self-marker greps — should be ZERO hits.
rg -n "Phase 5/6 deletes|Phase 6 deletes|Phase 7 deletes" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'

# Workspace baseline.
git log --oneline main -1   # Expected: post-PR-26 merge
pnpm build
pnpm test
```

If any deviation surfaces, STOP and reconcile in the reality-check section before continuing. Memory `feedback_check_plan_vs_reality.md`.

---

## Invariants (verified per task)

Phase 7's I1, I9, I10, I12, I15, I17, I18 carry forward. New invariants for this plan:

**Slice 1 invariants:**

- **I28 — `createIpcClient` semantics unchanged across the move.** Every consumer site that calls `createIpcClient(...)` produces a client that speaks the same IPC protocol with the same retry/timeout/auth behavior. Verified by: (a) no edits to `ipc-client.ts` body during the move (pure file relocation + import-path edits), (b) all existing `ipc-client.test.ts` cases pass at the new location.
- **I29 — `@ax/agent-runner-core` is gone from disk and from every package.json after Slice 1.** Verified by `ls packages/agent-runner-core` returning ENOENT and `rg "@ax/agent-runner-core" packages/ presets/` workspace-wide returning zero hits (excluding `pnpm-lock.yaml`'s historical resolution).
- **I30 — `@ax/test-harness` does NOT depend on `@ax/agent-claude-sdk-runner` after Slice 1.** Verified by `cat packages/test-harness/package.json | grep agent-claude-sdk-runner` returning empty. The split design is precisely to prevent this regression — if it breaks here, the split was wrong.
- **I31 — Test counts preserved across the move.** `agent-runner-core`'s 29 tests redistribute: ~15 (`ipc-client.test.ts`, `errors`-related) move to `@ax/ipc-protocol`'s test directory; ~14 (`inbox-loop`, `local-dispatcher`, `diff-accumulator`) move to `@ax/agent-claude-sdk-runner`. Net: zero tests lost; sum is exactly 29 + the redistribution.

**Slice 2 invariants:**

- **I32 — `tool:register` and `tool:list` service registrations preserved across the move.** Verified by: (a) the moved `plugin.ts`'s `bus.registerService('tool:register', ...)` and `bus.registerService('tool:list', ...)` calls fire on plugin init, (b) `@ax/mcp-client`'s tool-registration path that calls `tool:register` continues to work end-to-end (the existing mcp-client test suite is the canary).
- **I33 — `@ax/tool-dispatcher` is gone from disk and from every package.json after Slice 2.** Verified by `ls packages/tool-dispatcher` returning ENOENT.
- **I34 — Plugin load order preserved in CLI + preset.** Phase 6 retired the older `tool-dispatcher → tool descriptors → mcp-client` ordering note; the post-merge ordering is `mcp-client` registers BOTH the catalog and its own tool descriptors in one plugin init. Verified by reading the preset's section comment (lines around `presets/k8s/src/index.ts:58`) and confirming any "catalog assembly" prose either deletes or reframes around the unified plugin.
- **I35 — Net test count preserved across Slice 2.** `tool-dispatcher`'s 34 tests move to `@ax/mcp-client/__tests__/`. The two existing mcp-client tests that imported from `@ax/tool-dispatcher` switch to relative imports. Net: zero tests lost.

---

## Open questions resolved before execution

1. **In Slice 2, does the merged plugin keep the name `createToolDispatcherPlugin` or get renamed?** **Keep `createToolDispatcherPlugin` as the export.** Reason:
   - The CLI + preset import sites change ONE thing (the package path) instead of TWO (path + name).
   - The plugin's job — own the tool catalog — hasn't changed.
   - mcp-client's existing exports (e.g., `createMcpClientPlugin`) remain. After merge, `@ax/mcp-client` exports BOTH `createMcpClientPlugin` (what it always exported) AND `createToolDispatcherPlugin` (the absorbed plugin from `@ax/tool-dispatcher`). The CLI loads both, same as today.
   - Future refactor can rename or merge the two factories into one, but Slice 2's scope is "drop a package boundary", not "redesign the plugin shape".

2. **Does Slice 1 introduce a circular-import risk?** **No, but verify.** `@ax/ipc-protocol` currently has no dep on `@ax/core`-and-friends; `createIpcClient` uses `fetch` (Node 20+) and Zod schemas already in `@ax/ipc-protocol`. Verify by reading `packages/agent-runner-core/src/ipc-client.ts` for any non-protocol dep before the move. If it imports from `@ax/core`, decide whether to keep that dep edge or relocate the imported symbol.

3. **Should the IPC client exports live at `@ax/ipc-protocol` top-level or under a sub-path?** **Top-level.** Both consumers (SDK runner and stub-runner) can do `import { createIpcClient } from '@ax/ipc-protocol'` cleanly. Sub-paths add ceremony without earning weight at this scale.

4. **Does `@ax/agent-claude-sdk-runner` need a manifest update for the absorbed `tool:register`/`tool:list` registrations?** **Slice 2 N/A — they go to `@ax/mcp-client`'s manifest, not the SDK runner.** Update mcp-client's plugin manifest's `registers:` to include the catalog services.

5. **Cross-plugin import check (CLAUDE.md invariant #2).** After Slice 2, the CLI + preset import `createToolDispatcherPlugin` from `@ax/mcp-client`. That's the SAME pattern as today (importing a plugin factory from a plugin package); the lint rule `no-restricted-imports` (when wired) bans plugin-to-plugin imports of *internals*, not plugin factories from package roots. Confirm by reading the existing `eslint.config.mjs` if it has restrictions; otherwise this is a non-issue.

6. **Half-wired window discipline.** Each slice's commit pair MUST close in the same PR:
   - Slice 1 — Commit A: move source + redirect imports. Commit B: delete `@ax/agent-runner-core` package + drop refs from package.jsons + tsconfig + lockfile. Both in the SAME PR.
   - Slice 2 — Commit A: move source + register services in mcp-client + redirect imports. Commit B: delete `@ax/tool-dispatcher` package + drop refs + lockfile. Both in the SAME PR.

7. **Does Slice 1 affect the security boundary?** **No.** `@ax/ipc-protocol` is already the wire-protocol package; adding the IPC client to it doesn't expand the trust surface. The SDK runner's IPC bearer-token handling is unchanged. The `security-checklist` skill doesn't fire (no sandbox boundary change, no IPC handler change, no plugin loading change, no untrusted-content surface change).

8. **Lockfile commit cadence.** Same as Phase 6 PR-A — regenerate `pnpm-lock.yaml` ONCE per slice, in the package-deletion commit. Mid-task lockfile commits churn the diff.

9. **Does either slice land if `pnpm build` is dirty at HEAD?** **No.** The pre-execution survey's `pnpm build` is the gate. If anything's red at HEAD, fix that first (separate PR), then come back.

10. **`agent-runner-core` package itself — what stays after the moves?** **Nothing — the package deletes entirely.** All five source modules redistribute. The `index.ts` becomes empty after the moves; the package deletes in Commit B of Slice 1. No "shrunk to a re-export shim" intermediate state.

---

## Tasks

### Task 1: Pre-execution survey + baseline confirmation

**Goal:** Confirm consumer footprints, baseline-green, and that the reality-check (agent-runner-core has 2 production paths) still holds. Memory `feedback_check_plan_vs_reality.md`.

**Files:** Read-only.

**Step 1.1: Re-run consumer greps**

```bash
echo "=== @ax/agent-runner-core consumers ==="
rg -n "from ['\"]@ax/agent-runner-core['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/'

echo "=== @ax/tool-dispatcher consumers ==="
rg -n "from ['\"]@ax/tool-dispatcher['\"]" --no-heading -g '!node_modules' -g '!dist' -g '!docs/'
```

Expected `agent-runner-core` hits: 14 (8 in `agent-claude-sdk-runner` src + 5 in its tests + 1 in `test-harness/stub-runner.ts`). If only SDK-runner hits surface, `test-harness` removed its dep — re-evaluate split-vs-fold.

Expected `tool-dispatcher` hits: 5 (CLI, preset, test-harness test, two mcp-client tests).

**Step 1.2: Pre-condition checks for Slice 1's destination**

```bash
# Confirm @ax/ipc-protocol doesn't already export createIpcClient.
grep -n "createIpcClient\|IpcClientOptions" packages/ipc-protocol/src/index.ts packages/ipc-protocol/src/*.ts
# Expected: zero hits.

# Confirm ipc-client.ts has no surprise deps (e.g., @ax/core).
grep -n "^import" packages/agent-runner-core/src/ipc-client.ts
# Expected: only Node built-ins, zod, '@ax/ipc-protocol' (the wire schemas).

# Confirm errors.ts is similarly contained.
grep -n "^import" packages/agent-runner-core/src/errors.ts
```

**Step 1.3: Pre-condition checks for Slice 2's destination**

```bash
# Confirm mcp-client doesn't already register tool:register / tool:list.
grep -n "registerService.*tool:register\|registerService.*tool:list" packages/mcp-client/src/plugin.ts
# Expected: zero hits (mcp-client today CALLS tool:register, doesn't REGISTER it).

# Confirm tool-dispatcher's catalog/scope have no surprise deps.
grep -n "^import" packages/tool-dispatcher/src/{plugin,catalog,scope}.ts
```

**Step 1.4: Baseline build + test**

```bash
pnpm build
pnpm test
```

Expected: clean across all packages. If anything's red at HEAD, STOP and fix before either slice.

**Step 1.5: No commit** — read-only verification.

---

## Slice 1 — `@ax/agent-runner-core` collapse

### Task 2: Move `ipc-client` + `errors` into `@ax/ipc-protocol`

**Goal:** The IPC client and its errors live at `@ax/ipc-protocol`. Both SDK runner and stub-runner import from there.

**Files:**
- Create: `packages/ipc-protocol/src/ipc-client.ts` (move from `packages/agent-runner-core/src/ipc-client.ts`)
- Create: `packages/ipc-protocol/src/errors.ts` (move from `packages/agent-runner-core/src/errors.ts`)
- Create: `packages/ipc-protocol/src/__tests__/ipc-client.test.ts` (move from `packages/agent-runner-core/src/__tests__/ipc-client.test.ts`)
- Modify: `packages/ipc-protocol/src/index.ts` (add new exports)
- Modify: `packages/agent-runner-core/src/index.ts` (drop `ipc-client` + `errors` exports — re-exports stop existing once the module is gone)
- Delete: `packages/agent-runner-core/src/ipc-client.ts`, `errors.ts`, `__tests__/ipc-client.test.ts`

**Step 2.1: Move the source files (verbatim, no edits)**

```bash
git mv packages/agent-runner-core/src/ipc-client.ts packages/ipc-protocol/src/ipc-client.ts
git mv packages/agent-runner-core/src/errors.ts packages/ipc-protocol/src/errors.ts
git mv packages/agent-runner-core/src/__tests__/ipc-client.test.ts packages/ipc-protocol/src/__tests__/ipc-client.test.ts
```

**Step 2.2: Fix internal imports inside the moved files**

The moved files may import `'./errors.js'` (intra-module) — those stay correct. They may also import from `'@ax/ipc-protocol'` for schemas — those become `'./actions.js'` (or whichever sibling file) since they're now IN ipc-protocol. Read each moved file and fix any `'@ax/ipc-protocol'` self-references.

**Step 2.3: Update `@ax/ipc-protocol/src/index.ts` exports**

Append:

```ts
export { createIpcClient, type IpcClient, type IpcClientOptions } from './ipc-client.js';
export { HostUnavailableError, IpcRequestError, SessionInvalidError } from './errors.js';
```

**Step 2.4: Update `@ax/agent-runner-core/src/index.ts`**

Drop the lines that re-exported `ipc-client` and `errors` (they no longer have files to point at).

**Step 2.5: Run scoped tests**

```bash
pnpm --filter @ax/ipc-protocol build
pnpm --filter @ax/ipc-protocol test
```

Expected: PASS, with the moved `ipc-client.test.ts` cases passing at the new location. ipc-protocol test count rises by ~10-15 (moved tests).

agent-runner-core builds will fail at this point because consumers still import the moved symbols from there — that's resolved in Task 3.

**Step 2.6: No commit yet** — Tasks 2-5 land as one commit (Slice 1 Commit A: move + redirect). Mid-Slice-1 commits would leave the workspace red.

---

### Task 3: Update `@ax/agent-claude-sdk-runner` and `@ax/test-harness` consumers

**Goal:** Every consumer of `@ax/agent-runner-core`'s IPC client + errors now imports from `@ax/ipc-protocol` instead.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/{main,pre-tool-use,post-tool-use,host-mcp-server,can-use-tool,workspace-diff}.ts` (update imports)
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/*.test.ts` (update imports)
- Modify: `packages/test-harness/src/stub-runner.ts:20` (update import)

**Step 3.1: Bulk import-path replacement**

For each consumer, change:

```ts
import { ..., IpcClient, createIpcClient, SessionInvalidError, ... } from '@ax/agent-runner-core';
```

to either a single line or two lines, depending on what each consumer uses:

```ts
import { ..., IpcClient, createIpcClient, SessionInvalidError, ... } from '@ax/ipc-protocol';
```

**For symbols staying in `@ax/agent-runner-core` momentarily** (`DiffAccumulator`, `createDiffAccumulator`, `toWireChanges`, `createInboxLoop`, `createLocalDispatcher`): these still come from `@ax/agent-runner-core` until Task 4. Use a two-import shape during this commit:

```ts
import type { IpcClient } from '@ax/ipc-protocol';
import type { DiffAccumulator } from '@ax/agent-runner-core';
```

This keeps the commit's diff focused on the IPC-client move.

**Step 3.2: Verify build** (does NOT need to be green yet — agent-runner-core consumers for the OTHER symbols still work).

```bash
pnpm --filter @ax/agent-claude-sdk-runner build
pnpm --filter @ax/test-harness build
```

Expected: PASS. (The agent-runner-core package itself still has `inbox-loop`, `local-dispatcher`, `diff-accumulator` — its index.ts still exports them. The consumers split their imports accordingly.)

**Step 3.3: No commit yet** — bundle into the Slice 1 Commit A.

---

### Task 4: Move `inbox-loop`, `local-dispatcher`, `diff-accumulator` into `@ax/agent-claude-sdk-runner`

**Goal:** The agent-runtime helpers live where their sole consumer lives. After this task, `@ax/agent-runner-core/src/index.ts` exports nothing.

**Files:**
- Move: `packages/agent-runner-core/src/inbox-loop.ts` → `packages/agent-claude-sdk-runner/src/inbox-loop.ts`
- Move: `packages/agent-runner-core/src/local-dispatcher.ts` → `packages/agent-claude-sdk-runner/src/local-dispatcher.ts`
- Move: `packages/agent-runner-core/src/diff-accumulator.ts` → `packages/agent-claude-sdk-runner/src/diff-accumulator.ts`
- Move: corresponding `__tests__/*.test.ts` files alongside
- Update: every consumer site's import (was `@ax/agent-runner-core`, becomes relative `./inbox-loop.js` etc.)
- Update: `@ax/agent-runner-core/src/index.ts` (becomes empty)

**Step 4.1: Move the source files**

```bash
git mv packages/agent-runner-core/src/inbox-loop.ts packages/agent-claude-sdk-runner/src/inbox-loop.ts
git mv packages/agent-runner-core/src/local-dispatcher.ts packages/agent-claude-sdk-runner/src/local-dispatcher.ts
git mv packages/agent-runner-core/src/diff-accumulator.ts packages/agent-claude-sdk-runner/src/diff-accumulator.ts
git mv packages/agent-runner-core/src/__tests__/inbox-loop.test.ts packages/agent-claude-sdk-runner/src/__tests__/inbox-loop.test.ts
git mv packages/agent-runner-core/src/__tests__/local-dispatcher.test.ts packages/agent-claude-sdk-runner/src/__tests__/local-dispatcher.test.ts
git mv packages/agent-runner-core/src/__tests__/diff-accumulator.test.ts packages/agent-claude-sdk-runner/src/__tests__/diff-accumulator.test.ts
```

**Step 4.2: Fix imports in the moved files**

Each moved file may have `'@ax/ipc-protocol'` imports — those stay. Internal imports like `'./errors.js'` become `'@ax/ipc-protocol'` since errors moved (Task 2). Read each file and adjust.

**Step 4.3: Update SDK runner consumers**

For each `agent-claude-sdk-runner/src/*.ts` and test that imported `DiffAccumulator`, `createDiffAccumulator`, `toWireChanges`, `createInboxLoop`, `InboxLoop`, `LocalDispatcher`, etc. from `@ax/agent-runner-core`, change to a relative import:

```ts
// before
import type { DiffAccumulator } from '@ax/agent-runner-core';

// after
import type { DiffAccumulator } from './diff-accumulator.js';
```

Use `git grep "from '@ax/agent-runner-core'" packages/agent-claude-sdk-runner/` to find every site.

**Step 4.4: Empty the agent-runner-core index**

`packages/agent-runner-core/src/index.ts` should now be:

```ts
// (intentionally empty — package retained for one commit transition; deleted in Task 5)
export {};
```

**Step 4.5: Verify build + test**

```bash
pnpm build
pnpm test
```

Expected: clean across all packages. Test counts shift between packages but total is preserved.

**Step 4.6: Commit (Slice 1 Commit A)**

```bash
git add packages/ipc-protocol/ packages/agent-runner-core/ packages/agent-claude-sdk-runner/ packages/test-harness/src/stub-runner.ts
git commit -m "refactor(ipc-protocol,agent-claude-sdk-runner): absorb @ax/agent-runner-core surface area"
```

(Subject without a phase suffix — this isn't a numbered phase, just structural cleanup. Body of the commit message references the design Section 6 deferral history and PR #26 as predecessor.)

---

### Task 5: Delete `@ax/agent-runner-core` package

**Goal:** Drop the empty package, its package.json, its tsconfig, and every reference. Workspace is clean. (Slice 1 Commit B.)

**Files:**
- Delete: `packages/agent-runner-core/` (whole directory)
- Modify: `packages/agent-claude-sdk-runner/package.json` (drop `@ax/agent-runner-core` dep)
- Modify: `packages/agent-claude-sdk-runner/tsconfig.json` (drop ref)
- Modify: `packages/test-harness/package.json` (drop `@ax/agent-runner-core` dep)
- Modify: `packages/test-harness/tsconfig.json` (drop ref)
- Modify: `tsconfig.json` (root — drop `{ "path": "packages/agent-runner-core" }` ref)
- Regenerate: `pnpm-lock.yaml` via `pnpm install`

**Step 5.1: Drop refs**

Edit the package.json + tsconfig files. Use `grep -rn "agent-runner-core" packages/ presets/ tsconfig.json` to find every site. Drop each line.

**Step 5.2: Delete the package**

```bash
git rm -r packages/agent-runner-core
```

**Step 5.3: Regenerate lockfile + verify**

```bash
pnpm install
pnpm build
pnpm test
```

Expected: clean.

**Step 5.4: Commit (Slice 1 Commit B)**

```bash
git add packages/agent-claude-sdk-runner/{package.json,tsconfig.json} \
        packages/test-harness/{package.json,tsconfig.json} \
        tsconfig.json pnpm-lock.yaml
git rm -r packages/agent-runner-core
git commit -m "refactor: delete @ax/agent-runner-core package"
```

**Step 5.5: I29 + I30 verification**

```bash
ls packages/agent-runner-core 2>&1   # Expected: not found
rg -n "@ax/agent-runner-core" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'   # Expected: zero hits
grep -n "@ax/agent-claude-sdk-runner" packages/test-harness/package.json   # Expected: zero hits (I30 — test-harness must NOT depend on the runner)
```

**Slice 1 ships at this point** — open PR with Commit A + Commit B.

---

## Slice 2 — `@ax/tool-dispatcher` → `@ax/mcp-client` merge

### Task 6: Move `tool-dispatcher` source into `@ax/mcp-client`

**Goal:** The catalog implementation lives in mcp-client. Plugin factory exports stay the same name (`createToolDispatcherPlugin`) so consumer rename is package-path-only.

**Files:**
- Move: `packages/tool-dispatcher/src/plugin.ts` → `packages/mcp-client/src/tool-dispatcher-plugin.ts` (rename to disambiguate from `mcp-client/src/plugin.ts`)
- Move: `packages/tool-dispatcher/src/catalog.ts` → `packages/mcp-client/src/catalog.ts`
- Move: `packages/tool-dispatcher/src/scope.ts` → `packages/mcp-client/src/scope.ts`
- Move: `packages/tool-dispatcher/src/__tests__/{dispatch,list-with-agent-scope,scope}.test.ts` → `packages/mcp-client/src/__tests__/`
- Modify: `packages/mcp-client/src/index.ts` (export `createToolDispatcherPlugin`)
- Modify: `packages/mcp-client/src/plugin.ts` (no manifest change — the `tool:register` / `tool:list` registrations are in the absorbed plugin, not in mcp-client's existing plugin)

**Step 6.1: Move the source files**

```bash
git mv packages/tool-dispatcher/src/plugin.ts packages/mcp-client/src/tool-dispatcher-plugin.ts
git mv packages/tool-dispatcher/src/catalog.ts packages/mcp-client/src/catalog.ts
git mv packages/tool-dispatcher/src/scope.ts packages/mcp-client/src/scope.ts
git mv packages/tool-dispatcher/src/__tests__/dispatch.test.ts packages/mcp-client/src/__tests__/dispatch.test.ts
git mv packages/tool-dispatcher/src/__tests__/list-with-agent-scope.test.ts packages/mcp-client/src/__tests__/list-with-agent-scope.test.ts
git mv packages/tool-dispatcher/src/__tests__/scope.test.ts packages/mcp-client/src/__tests__/scope.test.ts
```

**Step 6.2: Fix internal imports in moved files**

`tool-dispatcher-plugin.ts` imports `./catalog.js` and `./scope.js` — those stay correct (sibling files moved together). `@ax/core`-typed imports stay. Verify by reading.

**Step 6.3: Export from `@ax/mcp-client`**

Append to `packages/mcp-client/src/index.ts`:

```ts
export { createToolDispatcherPlugin } from './tool-dispatcher-plugin.js';
```

(The existing `createMcpClientPlugin` export and other surface stays.)

**Step 6.4: Update mcp-client's own test imports**

`packages/mcp-client/src/__tests__/plugin.test.ts:37` and `admin-routes.test.ts:22` currently import `createToolDispatcherPlugin` from `@ax/tool-dispatcher`. Switch to a relative import:

```ts
import { createToolDispatcherPlugin } from '../tool-dispatcher-plugin.js';
```

**Step 6.5: Update mcp-client package.json**

If `@ax/tool-dispatcher` is in devDependencies, drop it. If `@ax/mcp-client` previously didn't depend on `@ax/core`-things the moved files need, add those (read the moved files' imports to compile a list).

**Step 6.6: Verify mcp-client builds + tests pass**

```bash
pnpm --filter @ax/mcp-client build
pnpm --filter @ax/mcp-client test
```

Expected: PASS. Test count rises by 34 (the moved tests).

The rest of the workspace is still red because external consumers still import `@ax/tool-dispatcher`. Resolved in Task 7.

**Step 6.7: No commit yet** — bundle with Task 7 into Slice 2 Commit A.

---

### Task 7: Update CLI, preset, and test-harness consumers

**Goal:** Every external consumer of `@ax/tool-dispatcher` now imports from `@ax/mcp-client`.

**Files:**
- Modify: `packages/cli/src/main.ts:23` (import path)
- Modify: `packages/cli/package.json` (drop `@ax/tool-dispatcher` dep, ensure `@ax/mcp-client` is a dep)
- Modify: `packages/cli/tsconfig.json` (drop `@ax/tool-dispatcher` ref)
- Modify: `presets/k8s/src/index.ts:11` (import path)
- Modify: `presets/k8s/package.json` (drop dep)
- Modify: `presets/k8s/tsconfig.json` (drop ref)
- Modify: `packages/test-harness/src/__tests__/test-host-tool.test.ts:10` (import path)
- Modify: `packages/test-harness/package.json` (drop dep if present)
- Modify: `packages/test-harness/tsconfig.json` (drop ref if present)

**Step 7.1: Bulk import-path replacement**

```bash
# In CLI:
sed -i.bak "s|from '@ax/tool-dispatcher'|from '@ax/mcp-client'|g" packages/cli/src/main.ts
rm packages/cli/src/main.ts.bak

# Same for preset and test-harness test.
```

(Or do it via Edit tool for cleaner audit trail — pick whichever the executor prefers.)

**Step 7.2: Verify build + test**

```bash
pnpm build
pnpm test
```

Expected: clean across all packages.

**Step 7.3: Update preset's plugin-load-order comment**

`presets/k8s/src/index.ts` near line 58 has a section comment listing the plugin-load order, including `tool-dispatcher → tool descriptors → mcp-client (catalog assembly)`. After the merge, that becomes `mcp-client (catalog + tool descriptors)`. Update the comment.

**Step 7.4: Commit (Slice 2 Commit A)**

```bash
git add packages/mcp-client/ packages/cli/src/main.ts packages/cli/{package.json,tsconfig.json} \
        presets/k8s/src/index.ts presets/k8s/{package.json,tsconfig.json} \
        packages/test-harness/src/__tests__/test-host-tool.test.ts packages/test-harness/{package.json,tsconfig.json} \
        packages/tool-dispatcher/
git commit -m "refactor(mcp-client): absorb @ax/tool-dispatcher catalog plugin"
```

---

### Task 8: Delete `@ax/tool-dispatcher` package

**Goal:** Drop the empty package, its package.json + tsconfig, and the root tsconfig ref. (Slice 2 Commit B.)

**Files:**
- Delete: `packages/tool-dispatcher/` (whole directory)
- Modify: `tsconfig.json` (root — drop `{ "path": "packages/tool-dispatcher" }`)
- Regenerate: `pnpm-lock.yaml` via `pnpm install`

**Step 8.1: Delete the package**

```bash
git rm -r packages/tool-dispatcher
```

**Step 8.2: Drop root tsconfig ref**

Edit `tsconfig.json` to drop the `{ "path": "packages/tool-dispatcher" }` line.

**Step 8.3: Regenerate lockfile + verify**

```bash
pnpm install
pnpm build
pnpm test
```

Expected: clean.

**Step 8.4: Commit (Slice 2 Commit B)**

```bash
git add tsconfig.json pnpm-lock.yaml
git rm -r packages/tool-dispatcher
git commit -m "refactor: delete @ax/tool-dispatcher package"
```

**Step 8.5: I33 verification**

```bash
ls packages/tool-dispatcher 2>&1   # Expected: not found
rg -n "@ax/tool-dispatcher" --no-heading -g '!node_modules' -g '!dist' -g '!docs/plans/'   # Expected: zero hits
```

**Slice 2 ships at this point** — open PR with Commit A + Commit B.

---

### Task 9: Final verification + boundary review

**Goal:** Confirm both slices' invariants hold and the workspace is fully green.

**Step 9.1: Full workspace build + test**

```bash
pnpm build
pnpm test
```

Expected: ~1610 + redistribution (no net loss, no net gain — just relocation).

**Step 9.2: Invariant audit**

```bash
# I29 + I33 — packages gone.
ls packages/agent-runner-core packages/tool-dispatcher 2>&1   # Both: not found

# I30 — test-harness must NOT depend on agent-claude-sdk-runner.
grep -n "@ax/agent-claude-sdk-runner" packages/test-harness/package.json
# Expected: zero hits.

# I32 — tool:register and tool:list still wired.
rg -n "registerService.*'tool:register'\|registerService.*'tool:list'" packages/mcp-client/src/
# Expected: hits in tool-dispatcher-plugin.ts (the absorbed plugin).
```

**Step 9.3: Boundary review block (for PR descriptions)**

Both PRs are pure structural collapse. Boundary review section per PR:

```markdown
## Boundary review — package merge (no hook surface change)

- **Alternate impl this hook could have:** N/A — no hook signature change. The merge moves source files; service registrations and IPC wire schemas are byte-identical to before.
- **Payload field names that might leak:** none. No payload edits.
- **Subscriber risk:** none.
- **Wire surface:** unchanged. `tool:register` / `tool:list` (Slice 2) and `tool.list` IPC action (Slice 1) wire schemas are unchanged.
```

**Step 9.4: No commit** — verification + PR-description prep only.

---

## Acceptance criteria (verified before merge)

| | Criterion | How verified |
|---|---|---|
| I1, I7, I9, I10, I12, I15, I17, I18 | Carry-forwards from Phases 6/7 | Workspace tests + greps as before |
| I28 | `createIpcClient` semantics unchanged | `ipc-client.test.ts` (~10 cases) passes at new location |
| I29 | `@ax/agent-runner-core` gone from disk + workspace | Task 5.5 + Task 9.2 |
| I30 | `@ax/test-harness` does NOT depend on `@ax/agent-claude-sdk-runner` | Task 9.2 grep |
| I31 | `agent-runner-core`'s 29 tests preserved across the move | `pnpm --filter @ax/ipc-protocol test` + `pnpm --filter @ax/agent-claude-sdk-runner test` sum equals pre-Slice-1 sum + 29 |
| I32 | `tool:register` / `tool:list` services preserved | mcp-client's existing plugin tests still pass; new dispatch test count matches pre-Slice-2 |
| I33 | `@ax/tool-dispatcher` gone from disk + workspace | Task 8.5 + Task 9.2 |
| I34 | Plugin load order preserved | Manual read of `presets/k8s/src/index.ts:58`-area section comment |
| I35 | `tool-dispatcher`'s 34 tests preserved across the move | `pnpm --filter @ax/mcp-client test` count rises by 34 (less the 2 already-in-mcp-client tests that just switch to relative imports) |

---

## Phase 6 / 7 lessons feeding into this plan

| Lesson | How it shapes this plan |
|---|---|
| **`feedback_check_plan_vs_reality.md`** — survey before each cut. | The user's TODO said "agent-runner-core has only the SDK runner as a consumer". Survey at HEAD found a SECOND consumer (test-harness/stub-runner). Reality-check section above documents the deviation; the split design is the resolution. |
| **`feedback_targeted_followup_commits.md`** — small follow-up commits beat amends. | Each task is its own commit step. Slice 1 ships as a 2-commit pair; Slice 2 same. Reviewer-driven fixes get their own follow-up commits, not amends. |
| **`feedback_minor_issues_non_blocking.md`** — reviewer Minor + ship = ship. | If a reviewer flags a comment-quality issue post-Slice-1, ship Slice 1 and address in Slice 2 or follow-up. |
| **`feedback_plan_revision_after_rollback.md`** — number invariants explicitly. | Both slices add invariants (I28-I31 for Slice 1, I32-I35 for Slice 2) that earn explicit acceptance-criteria slots. |
| **`feedback_half_wired_window_pattern.md`** — close windows in same PR. | Each slice's Commit A (move + redirect) and Commit B (delete package + drop refs) MUST land in the same PR. Slice 1 cannot leave `@ax/agent-runner-core` empty-but-on-disk across PR boundaries. |
| **Phase 6 PR-A reviewer feedback — explicit assertions over structural implication.** | I32's verification doesn't assume "if mcp-client builds, services are registered". It runs the existing mcp-client plugin tests that EXERCISE `tool:register` end-to-end. |
| **Phase 7 PR-26 reviewer feedback — strengthen canaries to detect regressions.** | I31 + I35 require EXACT test counts (sum-preserving), not "at least N tests pass". A move that loses 2 tests would slip past a `>= N` check. |

---

## Estimated landing

**Slice 1 — `@ax/agent-runner-core` collapse:**
- **Tasks:** 4 (Tasks 2-5, after the survey).
- **Commits:** 2 (move + redirect; delete package).
- **Files touched:** ~25 (5 source files moved, 4 test files moved, 8 SDK-runner consumers updated, 1 test-harness consumer updated, 6 package.json/tsconfig edits, 1 lockfile regen).
- **LOC delta:** approximately **+0 net** (pure relocation; package.json + tsconfig deletions roughly cancel index re-export deletions).
- **Risk:** **Low.** Pure structural move. Zero behavior change. Test counts strictly preserved; no production wiring touched.

**Slice 2 — `@ax/tool-dispatcher` → `@ax/mcp-client`:**
- **Tasks:** 3 (Tasks 6-8).
- **Commits:** 2 (move + redirect; delete package).
- **Files touched:** ~15 (3 source files moved, 3 test files moved, 2 production wiring sites updated, 5 package.json/tsconfig edits, 1 lockfile regen, 1 preset comment refresh).
- **LOC delta:** approximately **+0 net**.
- **Risk:** **Low-Medium.** Pure structural move, but touches CLI + preset plugin-load order. The single production-wiring change (import path) is verified by the existing mcp-client + cli tests.

**Predecessors:** PR #26 (Phase 7) merged. No other dependencies.

**Successors:**
- `cfg.sandbox` / `cfg.storage` single-value enum collapse — separate slice.
- README + landing-page narrative refresh — separate writing pass.
- Stale `audit-log` comment sweep — separate PR.
- channel-web sidebar-collapse `useEffect` race fix — separate PR.

---

## Out-of-scope reminder

This plan does NOT:

- Change any IPC wire schema, hook signature, or service contract.
- Add or remove any plugin from the CLI or k8s-preset load list (other than the `@ax/tool-dispatcher` → `@ax/mcp-client` source-of-the-import-path change).
- Touch `@ax/audit-log`, `@ax/credential-proxy`, OAuth lifecycle, or any other Phase-1-through-7 territory.
- Rename any plugin factory (`createToolDispatcherPlugin` keeps its name — Open question 1).
- Refactor any of the moved source files (`ipc-client.ts`, `inbox-loop.ts`, `catalog.ts`, etc.) beyond import-path edits.
- Address the channel-web CI flake from PR #26 (separate fix, separate branch).
- Sweep the stale `audit-log` comments the cross-slice reviewer found in `event-chat-end.ts`, `orchestrator.ts`, etc. (separate PR).

If during execution any of these surface as load-bearing for the merge, STOP and re-plan rather than expanding scope.
