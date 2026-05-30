# TASK-73 Deflake bundle-hooks round-trip Implementation Plan

> **For agentic workers:** Single-file bugfix. Execute inline (executing-plans), TDD per step.

**Goal:** Eliminate the intermittent `TypeError: Cannot read properties of null (reading 'slice')` that reds the workspace-git bundle round-trip test (and the auto-ship main-CI backstop) by removing the last isomorphic-git object-read calls from the `@ax/workspace-git-core` hot read path.

**Architecture:** isomorphic-git 1.37.5's `FileSystem.read()` adapter swallows *any* read error (ENOENT, EAGAIN, EMFILE, partial read) to `null`. Under CI load (≈59 packages' suites in parallel → fd/CPU starvation) a transient `.idx` read returns null; `loadPackIndex` → `GitPackIndex.fromIdx({idx:null})` → `new BufferCursor(null).slice(4)` throws. The codebase already worked around this for `readSnapshotAt` by shelling out to real `git` (impl.ts:552-562). Three object-read call sites still use iso-git and remain vulnerable: `readBlobBytes` (delta content), `workspace:read` (`git.readBlob`), `workspace:list` (`git.listFiles`). Route all three through real `git` plumbing, matching the established pattern. Refs/writes (`resolveRef`, `writeBlob`, `writeTree`, `commit`, `init`) do NOT touch `objects/pack/*.idx` and stay on iso-git.

**Tech Stack:** TypeScript, vitest, isomorphic-git, real `git` binary via existing `runGit`/`runGitBinary` helpers.

---

### Task 1: Deterministic regression test for the null-slice race

The existing flaky test only fails under real OS load, so it is not a reliable guard.
Add a deterministic test that injects the transient null read (the exact condition the
iso-git adapter swallows) and asserts the read path survives it.

**Files:**
- Test: `packages/workspace-git-core/src/__tests__/null-slice-race.test.ts` (create)

- [ ] **Step 1: Write the failing test** — build a bare repo whose objects live in a
  packfile (seed loose + bundle-fetch pack, as apply-bundle does), wrap the injected
  `fs` so the first `.idx` read throws `EAGAIN`, then call the registered
  `workspace:read` / `workspace:list` and assert they return the bytes/paths (not throw).
  Before the fix this throws the null-slice TypeError; after, it passes.

- [ ] **Step 2: Run, verify it fails** with the null-slice TypeError.

### Task 2: Route the three object reads through real git

**Files:**
- Modify: `packages/workspace-git-core/src/impl.ts`
  - `readBlobBytes` (≈731): replace `git.readBlob` with `runGitBinary(['cat-file','blob', `${commitOid}:${path}`])`.
  - `workspace:read` (≈871): replace `git.readBlob` with `runGitBinary(['cat-file','blob', `${commitOid}:${input.path}`])`; map a missing path (nonzero exit / "does not exist") to `{found:false}`, mirroring the old `isNotFoundError` swallow.
  - `workspace:list` (≈897): replace `git.listFiles` with `runGit(['ls-tree','-r','-z','--name-only', commitOid])` (reuse the `readSnapshotAt` shape); empty/unknown → `{paths:[]}`.

- [ ] **Step 1: Implement** the three replacements; keep the `copyBytes` defensive copy, the glob filter, and the discriminated `found`/`paths` outputs identical.
- [ ] **Step 2: Run Task 1 test, verify it passes.**
- [ ] **Step 3: Run the full `@ax/workspace-git` + `@ax/workspace-git-core` suites.**

### Task 3: Prove determinism + gate

- [ ] **Step 1:** 20× consecutive `pnpm -F @ax/workspace-git test` all green.
- [ ] **Step 2:** `pnpm build` (tsc) + lint clean.
- [ ] **Step 3:** Commit.
