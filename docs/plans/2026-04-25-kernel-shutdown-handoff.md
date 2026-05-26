# Kernel shutdown lifecycle handoff

**For:** session picking up follow-up #3 from `docs/plans/2026-04-25-week-7-9-followups.md`. Smallest of the three substantial follow-ups; a self-contained sweep.

**Previous slices:** Weeks 1–9 (PR #9 merged). The kernel has an `init` lifecycle (`bootstrap()` runs `init()` in topological order); it has no `shutdown` lifecycle. Process exit handles teardown today, which works for one-shot CLI runs but leaks file handles + connections in any long-lived host process.

**Assumes the following are in place:**
- The `Plugin` interface in `packages/core/src/plugin.ts:19` has `manifest` + `init` only — no `shutdown`. Adding it as `shutdown?(): Promise<void>` is the central change.
- `bootstrap()` in `packages/core/src/bootstrap.ts:11` runs `init()` in topological order computed by `topologicalOrder()` at line 137. The same order, reversed, is the shutdown order. Today `bootstrap()` returns `void` — it'll need to return a handle that exposes `shutdown()`.
- Several plugins already paper around the missing lifecycle:
  - `packages/database-postgres/src/plugin.ts:60` — `// TODO(kernel-shutdown):` comment, `pg.Pool` not drained on exit.
  - `packages/storage-sqlite/src/plugin.ts:22` — `// TODO(kernel-shutdown):` comment, `better-sqlite3` file handle leaks.
  - `packages/eventbus-postgres/src/plugin.ts:60-68` — exports `EventbusPostgresPlugin extends Plugin { shutdown(): Promise<void> }` as a test-only escape hatch with the comment "when the kernel gains a shutdown lifecycle, it'll move there."
  - `packages/session-postgres/src/plugin.ts:92-100` — same `SessionPostgresPlugin extends Plugin { shutdown(): Promise<void> }` shape; the `shutdown()` impl already exists in full at lines 384-400 (drains inbox, ends listen client, destroys Kysely). Just needs to be promoted from a public field to the optional `Plugin.shutdown` slot.
  - `packages/session-postgres/src/plugin.ts:257-279` — has a hand-rolled init-failure rollback (`try { migrate; connect } catch { close listenClient; destroy kysely }`) with the comment "The kernel doesn't yet call shutdown() on init failure (TODO: kernel-shutdown), so init owns the cleanup itself."
  - `packages/sandbox-k8s/src/plugin.ts:20` — k8s API client created via `createDefaultK8sApi()`; followups doc flags this as needing an `agent.destroy()` on the keep-alive HTTP agent. Verify when picking up — if `@kubernetes/client-node` already cleans up via its own teardown, this can be dropped from scope.
- No production process today does anything on SIGINT/SIGTERM. The default Node behavior — synchronous exit — is what we have.

If any of the above shifted (particularly if a plugin landed its own ad-hoc shutdown story since this handoff), reconcile before writing the plan.

---

## Goal

Add an optional shutdown lifecycle to the kernel. Plugins that hold resources (file handles, connection pools, listen clients, HTTP agents) get a clean teardown path on SIGINT/SIGTERM — and during init failure, plugins that already initialized get their `shutdown()` called too.

After this lands, every `TODO(kernel-shutdown):` comment is gone, the `EventbusPostgresPlugin` / `SessionPostgresPlugin` interfaces drop their public `shutdown()` field (back to plain `Plugin`), and `session-postgres`'s hand-rolled init-failure cleanup at `plugin.ts:257-279` becomes a few lines instead of a paragraph.

## Architecture decisions baked in

After reading `bootstrap.ts`, the existing `shutdown()` in `session-postgres`, and the init-failure pattern in `session-postgres/plugin.ts:257-279`:

### 1. The kernel orchestrates; the host wires signal handlers

`bootstrap()` returns a handle with `shutdown(): Promise<void>`. The kernel doesn't install `process.on('SIGINT')` itself — that's the host's job (cli, serve binary, tests). Reasons:

- Tests need to call `shutdown()` directly without competing signal handlers.
- Embedded uses (kernels inside other processes) want their parent process to own signal lifecycle.
- The kernel doesn't know whether SIGTERM means "exit" or "reload" — that's a host policy decision.

The cli + the `serve` binary are the two host call sites that need to install handlers. Each does the obvious thing: register `SIGINT` and `SIGTERM`, call `handle.shutdown()`, then `process.exit(0)`. If a second signal arrives mid-shutdown, force-exit with code 130 (SIGINT) / 143 (SIGTERM).

### 2. Reverse topological order

The kernel calls `shutdown()` in the reverse of the order `init()` ran. `topologicalOrder()` at `bootstrap.ts:137` already computes the dependency-respecting load order — reverse the resulting array. Why reverse: a plugin that consumed `database:get-instance` during init may need to flush queries before the database plugin closes the pool.

### 3. Per-plugin timeout, isolated failures

Each plugin's `shutdown()` runs under a 10-second timeout. Configurable via `BootstrapOptions.shutdownTimeoutMs` (default 10_000). A plugin that throws or times out gets its failure logged but does NOT block other plugins from shutting down — the next reverse-order plugin still runs. This is intentional: a misbehaving plugin can't hold the process hostage.

The 10s ceiling matches `IPC_TIMEOUTS_MS` defaults and gives slow drains (in-flight queries, LISTEN client end, k8s informer cleanup) enough breathing room without unbounded waits.

### 4. Init-failure rollback uses the same lifecycle

When `bootstrap()`'s init loop throws on plugin N, the kernel runs `shutdown()` on plugins 0..N-1 in reverse order before re-throwing. This lets `session-postgres/plugin.ts:257-279` collapse to nothing — its `shutdown()` already does the right thing, the kernel just needs to call it.

This composes cleanly with the existing PluginError-wrapping at `bootstrap.ts:33-41`: rollback shutdown errors are logged (same per-plugin timeout + isolation as normal shutdown), the original init failure is the one that propagates.

### 5. The `Plugin.shutdown` slot is optional

`Plugin.shutdown?(): Promise<void>`. Plugins without resources to clean up don't have to implement it. The kernel just `if (p.shutdown) await p.shutdown()` per plugin in the reverse loop. This is invariant 1-friendly: the lifecycle interface stays minimal, plugins opt in only when they need to.

## Deliverables

- **Kernel changes (`packages/core/src/`):**
  - Add `shutdown?(): Promise<void>` to `Plugin` in `plugin.ts:19`.
  - Change `bootstrap()` in `bootstrap.ts:11` to return `Promise<KernelHandle>` instead of `Promise<void>`. `KernelHandle` exposes `shutdown(): Promise<void>` and stores the init-order array internally.
  - Add `shutdownTimeoutMs?: number` to `BootstrapOptions` (default 10_000).
  - Add init-failure rollback: when `init()` throws, run `shutdown()` on plugins 0..N-1 in reverse order under the same per-plugin timeout, log failures, then re-throw the original `PluginError`.
  - Export `KernelHandle` from `index.ts`.
- **Per-plugin `shutdown()` impls.** Six plugins to audit. Concrete to-do list:
  - **`@ax/storage-sqlite`** (`packages/storage-sqlite/src/plugin.ts`): close the Kysely instance (`db.destroy()` calls into `better-sqlite3`'s `Database#close`, which flushes WAL and releases the file handle). Drop the TODO comment at line 22.
  - **`@ax/database-postgres`** (`packages/database-postgres/src/plugin.ts`): `await kysely.destroy()` — `PostgresDialect` closes the underlying `pg.Pool` as part of `destroy()`, so no separate `pool.end()` call. Drop the TODO at line 60.
  - **`@ax/eventbus-postgres`** (`packages/eventbus-postgres/src/plugin.ts`): the `Listener` already has a `shutdown()` method (`packages/eventbus-postgres/src/listener.ts`). Move from the `EventbusPostgresPlugin` interface field to the `Plugin.shutdown` slot. Drop the `EventbusPostgresPlugin` interface at lines 60-68 and `extends Plugin` declaration at line 72 — the return type becomes `Plugin`. Update tests that called the old escape-hatch `shutdown()` to drive it through the kernel handle instead.
  - **`@ax/session-postgres`** (`packages/session-postgres/src/plugin.ts`): the `shutdown()` impl at lines 384-400 already exists and does the right thing (drain inbox, end listen client, destroy Kysely). Same change as `eventbus-postgres`: drop the `SessionPostgresPlugin` interface at lines 92-100 and the `extends Plugin` at line 200; the return type becomes `Plugin`. Then collapse the init-failure rollback at lines 257-279 — the kernel handles it now. Update tests.
  - **`@ax/sandbox-k8s`** (`packages/sandbox-k8s/src/plugin.ts`): verify whether `@kubernetes/client-node`'s API client retains a Node `http.Agent` that needs explicit `agent.destroy()`. The followups doc flagged this as needed; it may not be (the library may handle teardown internally). If yes, add `shutdown()` that destroys the agent. If no, document the verification in the plan and skip.
  - **`@ax/agent-runner-core` / `@ax/ipc-server`** are explicitly out of scope today (sandbox-side, not kernel-orchestrated). If a host-side plugin in either of these grows resources later, add `shutdown()` then.
- **Host call sites.** Two:
  - `packages/cli/src/main.ts` (or wherever the cli's `bootstrap()` call lives): capture the returned `KernelHandle`. On `SIGINT` / `SIGTERM`, call `handle.shutdown()`, then `process.exit(0)`. Second-signal force-exit with the conventional 130/143 codes.
  - The `serve` binary entrypoint: same pattern. Verify whether there's a separate `serve` binary or whether it's the same `cli` entrypoint with a `serve` subcommand — `packages/cli/` has the answer.
- **Test cleanup.** Tests that today call `(plugin as EventbusPostgresPlugin).shutdown()` or `(plugin as SessionPostgresPlugin).shutdown()` switch to driving the kernel handle. The escape-hatch interfaces disappear.
- **TODOs deleted.** Two `TODO(kernel-shutdown):` comments and two "when the kernel gains a shutdown lifecycle" comments. After this slice, none of those phrases exist anywhere in `packages/`.

## Scope decisions to make while writing the plan

1. **Should `KernelHandle.shutdown()` be idempotent?** Yes — calling it twice should be a no-op (returns the same resolved promise from the first call). Real-world reason: a SIGINT-then-SIGTERM sequence is common during deploys; the second call shouldn't crash. Implementation: cache the first call's promise; subsequent calls return the cached one.

2. **What does `shutdown()` do during init failure if the failing plugin's own `shutdown()` would help?** Don't call shutdown on the failing plugin — its init didn't complete, so the resources it would clean up may not exist. Roll back only plugins 0..N-1 (the ones that fully initialized). Match the pattern in `session-postgres`'s existing init try/catch at lines 257-279.

3. **Concurrent shutdown vs. sequential.** Sequential. The reverse-topological order matters precisely because dependencies do — running them in parallel would defeat the ordering. Per-plugin timeout still applies, so a slow plugin doesn't hold up the process indefinitely.

4. **Logging.** Where do shutdown errors land? The kernel's `bootstrap()` doesn't have a logger today — plugins create their own. For shutdown, the simplest answer is: take a `logger?: Logger` in `BootstrapOptions`. Default to a stdout JSON logger tagged `reqId=kernel-shutdown` (same pattern as `database-postgres-bg` etc.). Each plugin's shutdown failure logs as `kernel_shutdown_failed` with `{ plugin, err, durationMs }`.

5. **What about `@ax/eventbus-inprocess`** (assuming it exists by the time this lands)? It probably has nothing to clean up, so no `shutdown()` needed. Verify when picking up; if it does hold a timer or interval, add one.

6. **Workspace plugins?** `@ax/workspace-git` (and the future `@ax/workspace-git-http` from follow-up #2) — git is filesystem-only, no long-lived resources to clean. Skip unless something changed. The HTTP variant's pod-side server is a separate process with its own SIGTERM story; the host plugin is just an HTTP client and likely has nothing to shut down beyond a possible keep-alive agent.

## Security note

N/A — this is an internal lifecycle concern. No new capability surface, no new wire protocol, no new attack vector. The `security-checklist` skill does not need to fire for this slice.

That said: **don't** let `shutdown()` become a place where plugins do anything other than release resources. No final database writes, no flushing user data to disk, no audit-log emissions. Those belong on a separate "graceful drain" pre-shutdown phase if we ever need it. Keeping `shutdown()` strictly about resource release means it's safe to call from a SIGINT handler without worrying about partial state. (If a future slice does need a drain phase, that's a separate hook — `Plugin.drain?(): Promise<void>` — that runs *before* shutdown and gives plugins a chance to finish in-flight work.)

## Acceptance criteria

**Automated:**
- New test in `@ax/core`: `bootstrap()` with three plugins (A, B, C with C calling B and B calling A → init order A, B, C). Trigger shutdown. Assert `shutdown()` calls happen in order C, B, A.
- New test in `@ax/core`: a plugin whose `shutdown()` throws does not prevent the next plugin's `shutdown()` from running; the throw is logged and the kernel handle's `shutdown()` resolves.
- New test in `@ax/core`: a plugin whose `shutdown()` hangs past the timeout does not block other plugins' shutdowns; the timeout is logged.
- New test in `@ax/core`: when init fails on plugin N, `shutdown()` runs on plugins 0..N-1 in reverse order; the original init error propagates.
- New test in `@ax/core`: calling `handle.shutdown()` twice resolves both calls without re-running plugin shutdowns.
- Tests in `@ax/eventbus-postgres` and `@ax/session-postgres` switch to driving shutdown through the kernel handle instead of casting to the escape-hatch interface. Existing assertions stay green.
- A grep for `TODO(kernel-shutdown)` returns zero matches across `packages/`.
- A grep for `EventbusPostgresPlugin\|SessionPostgresPlugin` returns zero matches outside the `git log` (the interfaces are gone).
- `pnpm test` stays green.

**Manual:**
- On a kind cluster (or any process with the postgres trio loaded), send `SIGTERM` and verify with `lsof` (or `ps -p PID -o rss,sz` over time) that no postgres connections / sqlite file handles linger past process exit. The followups doc explicitly calls this out as the smoke test.

**Estimated size:** small-medium. ~250–400 LOC of impl + tests + per-plugin updates. ~1 focused day. The kernel orchestration is straightforward; most of the time goes into the per-plugin sweep. Two of the six plugins (`session-postgres`, `eventbus-postgres`) already have working `shutdown()` impls that just need to be moved into the right slot.

## Dependencies on other follow-ups

- **None.** This slice is independent of #1 and #2. It can land before, after, or in parallel.
- **Composition note:** if #2 (`@ax/workspace-git-http`) lands first, the new `git-server` pod-side process inherits this lifecycle for free — its SIGTERM handler hooks into `KernelHandle.shutdown()`.

## Kickoff prompt for next session

After `/clear`:

```
Write an implementation plan for the kernel shutdown lifecycle (follow-up
#3 from docs/plans/2026-04-25-week-7-9-followups.md). Read
docs/plans/2026-04-25-kernel-shutdown-handoff.md first — it has the
architecture decisions (kernel orchestrates, host wires signals; reverse
topological order; per-plugin 10s timeout with isolated failures;
init-failure rollback uses the same lifecycle), the per-plugin checklist
with file:line pointers, and the test list. The two postgres plugins
already have working shutdown() impls that just need to be moved into the
right slot — most of the work is the kernel-side orchestration plus a
sweep through six plugins. No security-checklist needed (internal
lifecycle, no new capability surface). Branch off main. The plan should
be executable via subagent-driven-development.
```
