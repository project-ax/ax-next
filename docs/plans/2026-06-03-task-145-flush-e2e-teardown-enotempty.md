# TASK-145 — Harden flush-workspace-host.e2e teardown vs ENOTEMPTY rmdir mirror.git/info race

## Problem

The runner e2e test
`packages/agent-claude-sdk-runner/src/__tests__/flush-workspace-host.e2e.test.ts`
intermittently fails its `afterEach` teardown with:

```
Error: ENOTEMPTY: directory not empty, rmdir '/tmp/ax-flush-e2e-XXXX/mirror.git/info'
```

Known flake (signature `ci:flush-workspace-host.e2e:ENOTEMPTY-rmdir-mirror-info`),
first seen on backstop `474b4125`, recurred on `4c20fcb4` / post-#302. Passes on PR
affected-package CI and on backstop re-run, repeatedly forcing a manual "rerun the
failed job" on the serialized merge queue. Real friction, no product impact.

## Root cause (proven harness-only)

`afterEach` removes the per-test scratch tree that contains a **real bare git mirror**
(`mirror.git`):

```js
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});
```

Each test runs ~25–30 real `git` subprocesses against that bare mirror (push / fetch /
bundle / clone). git's `gc.autoDetach` defaults to **true** (confirmed: git 2.52.0,
`gc.autoDetach` unset → true). A `push`/`fetch`/`receive-pack` can trigger
`git gc --auto`, which **detaches into a background process** that keeps writing into
`mirror.git/` — including `info/` (`git update-server-info` writes `info/refs`, gc packs
refs) — *after* the foreground `git` command the test awaited has already exited. When
`afterEach`'s `fs.rm` walks the tree and `rmdir`s `mirror.git/info` while that detached
writer is mid-write, the directory is momentarily non-empty → `ENOTEMPTY`.

Key facts:
- `fs.rm({force:true})` does **NOT** retry `ENOTEMPTY`/`EBUSY`. Only `maxRetries` +
  `retryDelay` enable Node's documented exponential-backoff retry loop. `force:true`
  only suppresses "path does not exist" errors.
- The test's *own* git ops are all `await`ed; the leftover writer is git's **detached**
  background process, which the test cannot await (git disowns it by design). So "await
  pending ops" is not the actionable lever — retry-on-rmdir is.
- **Why production is unaffected:** in production the host workspace mirror lives in a
  long-lived host pod / storage tier and is never `fs.rm`'d mid-operation. The runner's
  `commit-notify-resync.ts` paths are all fully awaited (no fire-and-forget). The race
  exists only because the *test* stands up a throwaway mirror and `fs.rm`s its parent at
  `afterEach`. No runner mirror-handling code changes.

### Repro evidence (mechanism proof)

A standalone repro (`/tmp/repro-enotempty.mjs`, not committed) that churns files into an
`info/` dir while `fs.rm` removes the tree:
- current `{recursive,force}`: **32/60** trials threw `ENOTEMPTY`/`EBUSY`.
- with `{recursive,force,maxRetries:10,retryDelay:20}`: **0/60**.

## Approach

Add `maxRetries` + `retryDelay` to the `afterEach` `fs.rm` (test teardown only). Factor
a tiny test-scoped helper `rmScratch(dir)` so the intent ("tolerate the detached-git
rmdir race") is self-documenting, and add a comment explaining why the race is
harness-only.

This is the exact remedy the card scopes: "replace the recursive `rmdir` with
`fs.rm(dir, {recursive:true, force:true, maxRetries, retryDelay})` (Node's built-in
ENOTEMPTY/EBUSY retry), scoped to this test's temp-dir teardown."

No production behaviour change. No new dependency. No hook surface touched.

## Tasks

### Task 1 — Hardened teardown + regression test (test-only)

1. **Regression test (red first).** Add a focused test in a new sibling file
   `flush-workspace-host-teardown.test.ts` (or co-located) that proves the hardened
   removal survives a concurrent writer churning an `info/` dir, while the bare
   `{recursive,force}` form throws `ENOTEMPTY`/`EBUSY` under the same load. The test
   asserts:
   - bare `fs.rm({recursive,force})` against a tree whose `info/` dir is being actively
     written throws (or *may* throw) `ENOTEMPTY`/`EBUSY` — to document the hazard, assert
     the **hardened** form never throws across many trials (the load-bearing assertion);
   - the hardened `rmScratch` helper removes the tree with zero throws across N trials.

   Make the assertion deterministic: it asserts the hardened path is throw-free across
   N trials (the property we actually need), not that the unhardened path *always*
   throws (which is timing-dependent). This is the regression guard per Bug Fix Policy —
   it would have caught a teardown that doesn't retry.

2. **Fix.** Replace the `afterEach` body with a call to the hardened `rmScratch(scratch)`
   helper:
   ```js
   const RM_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 25 } as const;
   async function rmScratch(dir: string): Promise<void> {
     // Detached `git gc --auto` / `update-server-info` can still be writing into
     // mirror.git/info after the foreground git we awaited exited (gc.autoDetach
     // defaults true). Node's maxRetries/retryDelay absorbs the transient
     // ENOTEMPTY/EBUSY rmdir race. Harness-only: production never fs.rm's a live
     // mirror. (TASK-145)
     await fs.rm(dir, RM_RETRY);
   }
   afterEach(async () => { await rmScratch(scratch); });
   ```

### Task 2 — Verify the flake is gone under stress

- Run the affected file in a tight loop (≥20×) on an idle machine → 0 failures
  (it already passes ~always there; this is the smoke check).
- Run the mechanism repro / regression test to prove the hardened removal is throw-free
  under an active `info/` writer (the deterministic proof the natural flake is fixed).

### Gate
- `pnpm --filter @ax/agent-claude-sdk-runner build && test`, plus lint on changed files.
- Whole-branch `ax-code-reviewer`.

## YAGNI pass
- Task 1: load-bearing (the fix + its regression guard). Keep.
- Task 2: verification, not code. Keep (required by the flaky-fix mandate).
- Disabling `gc.autoDetach` in the mirror config: rejected — `maxRetries` is the robust
  catch-all (covers `update-server-info` and any other in-flight write, not just gc),
  and it's the card's named remedy. Adding it would be belt-and-suspenders dead-ish
  config. Cut.
