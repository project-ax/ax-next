# TASK-137 — De-flake flush-workspace-host.e2e BUG-W2 resync assertion

## Problem statement

`packages/agent-claude-sdk-runner/src/__tests__/flush-workspace-host.e2e.test.ts >
flushWorkspaceBeforeCall host tool (BUG-W2 real path) > "host-side delete after the
flush sticks and the next runner commit resyncs cleanly"` intermittently reddens the
push-to-main full suite. It is an **assertion** flake (file ~607ms), NOT a timeout —
TASK-123 (#280) already gave the suite a 30s budget, which does not address this.

## Root cause (proven by fault injection)

The test's `makeHostClient` mock runs **real, fallible `git` subprocesses inside its
IPC handlers**:
- `workspace.commit-notify` → `mirrorMain` (`git rev-parse --verify`) + `fetchBundleAdvance` (`git fetch`)
- `workspace.export-baseline-bundle` → `bundleMirrorMainToFile` (`git bundle create`)

Plus the test-body assertions run git (`cat-file -e`).

Under CI's severe multi-package + Docker-testcontainer starvation, a SINGLE transient
git subprocess hiccup (spawn `EAGAIN` / a starved non-zero exit) anywhere in the
flush→retire→commit→resync sequence is **correctly** mapped by production
`commitNotifyWithResync` to a degraded outcome:
- a thrown `workspace.commit-notify` call → caught → `outcome: 'kept'`
- a transient `rev-parse` returning null → mock omits `actualParent` → rollback path → `outcome: 'rolled-back'`

The test then asserts `res.outcome === 'accepted'` → `expected 'kept' to be 'accepted'`.

Proven: injecting a transient throw on the resync-retry commit-notify deterministically
yields `resyncOutcome=kept`. The git LOGIC is deterministic (200× clean standalone
sequence; clean even with a dirty-tree `--autostash`); only subprocess *scheduling under
starvation* is non-deterministic. The "ordering luck" the card names = the implicit bet
that all ~6 fallible git forks in the mock succeed on the FIRST try under load.

Production code is correct (the degradation IS the right production behavior). The bug is
in the TEST.

## Fix approach

Add a bounded **transient-failure retry seam** to the test's `git()` helper so a
starvation-induced spawn-`EAGAIN` / transient git failure is retried-to-completion
("settle") rather than treated as authoritative and mistranslated into a degraded
outcome. The mock's git calls and the assertion git calls all route through `git()`, so
one seam covers every surface.

CRITICAL: retry ONLY genuine transient *infrastructure* failures — NEVER a legitimate
non-zero exit that callers interpret via `.code` (e.g. `cat-file -e` returning 1 for
"file absent", `diff --cached --quiet` returning 1 for "dirty"). The retry fires on:
- a spawn `'error'` event (fork failed, EAGAIN), and
- a non-zero exit whose stderr matches a known-transient pattern (`fork`,
  `Resource temporarily unavailable`, `Unable to create '.*index.lock'`, `cannot
  lock ref`).

A legitimate non-zero exit with no transient stderr returns normally (the caller decides).

## Tasks

### Task 1 — Add the retry seam to the test `git()` helper + a fault-injection regression test
**File:** `packages/agent-claude-sdk-runner/src/__tests__/flush-workspace-host.e2e.test.ts`
(test-only; no production source changes)

1. Wrap the existing `spawn`-based `git()` into a bounded retry: on a spawn `'error'`
   (EAGAIN) or a transient-stderr non-zero exit, retry up to N (e.g. 5) times with a tiny
   backoff. A clean exit (code 0) or a non-transient non-zero exit returns immediately.
   Keep the existing `{code, stdout, stderr}` contract so `mirrorMain`, `expectOk`, and
   the assertions are unchanged.
2. Add a regression test in the SAME file (`describe('BUG-W2 resync transient-git
   resilience')`): a `makeHostClient`-style mock whose `workspace.commit-notify` throws a
   transient `EAGAIN`-class error on its first resync-retry call, then succeeds. Assert
   the resync still lands `outcome: 'accepted'` BECAUSE the retry seam drove the transient
   failure to completion. This test FAILS against the old non-retrying helper (it would
   surface `kept`) and PASSES with the seam — i.e. it would have caught the flake.
3. Verify: 20 consecutive full-package `vitest run` passes under CPU + fork load
   (acceptance bullet 3).

YAGNI: load-bearing — this IS the fix. No dead code.

## Boundary review
No hook-surface change. No production source change. Test-only. No new dependency.
Not a sandbox/IPC/plugin-loading/untrusted-content change → security-checklist N/A.

## Invariants honored
- No cross-plugin import (test stays in-package).
- One source of truth (production degradation logic untouched).
- Bug Fix Policy: regression test added that would have caught the flake.
