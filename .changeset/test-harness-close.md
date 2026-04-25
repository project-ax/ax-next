---
'@ax/core': minor
'@ax/test-harness': minor
'@ax/workspace-git-http': patch
---

Add `Plugin.shutdown?()` + `TestHarness.close()` so test suites can drain
plugin resources between cases.

Closes the gap a coderabbit review on PR #11 flagged: a multi-replica test
that booted three host harnesses (each with an HTTP-client plugin) had no
way to clean them up. `vitest` watch mode + parallel-test runs accumulated
those resources across cases.

- `@ax/core` adds an optional `shutdown?(): Promise<void> | void` to the
  `Plugin` interface. Plugins that hold no long-lived resources don't need
  to implement it. The kernel does NOT call it yet — production
  SIGTERM-driven shutdown is followups doc #3, a separate slice.
- `@ax/test-harness` adds `close(opts?)` to `TestHarness`. Walks plugins
  in reverse load order, calls `shutdown()` on each that implements it,
  with per-plugin timeout (default 10 s) + try/catch (one plugin's
  failure doesn't block the others). Idempotent.
- `@ax/workspace-git-http`'s multi-replica test now calls
  `harness.close()` on all three harnesses in `afterEach`, exercising the
  new path end-to-end. The host plugin doesn't currently implement
  `shutdown` (no resources to drain) so it's a no-op today, but the
  pattern is correct for when a future plugin does.
