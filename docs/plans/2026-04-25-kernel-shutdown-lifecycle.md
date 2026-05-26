# Kernel shutdown lifecycle implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (or `superpowers:subagent-driven-development` for in-session execution) to implement this plan task-by-task.

**Goal:** Add a kernel-orchestrated shutdown lifecycle so plugins holding long-lived resources (file handles, pg pools, LISTEN clients, HTTP listeners) get a clean teardown path on SIGINT/SIGTERM and on init failure.

**Architecture:** `bootstrap()` returns a `KernelHandle` whose `shutdown()` calls each plugin's optional `Plugin.shutdown?()` in **reverse topological** load order under a per-plugin timeout (default 10 s). Failures and timeouts on one plugin are logged but don't block the others. On init failure, the kernel runs the same shutdown loop on plugins that already initialized (0..N-1) before re-throwing the original `PluginError`. The kernel never installs signal handlers — that's the host's job; the CLI and `serve` host call sites wire SIGINT/SIGTERM to `handle.shutdown()`.

**Tech Stack:** TypeScript, pnpm workspaces, vitest. Same toolchain as the rest of the monorepo.

---

## Pre-flight: handoff doc deviates from reality

The handoff (`docs/plans/2026-04-25-kernel-shutdown-handoff.md`) was written **before** PR #13 (`feat/test-harness-close`) merged on `main`. Two of its stated assumptions are now stale — read this section carefully, then proceed:

1. **`Plugin.shutdown?` already exists.** `packages/core/src/plugin.ts:36` defines `shutdown?(): Promise<void> | void` today, with a doc-comment that says the kernel "does NOT call this yet — the production SIGTERM-driven shutdown lifecycle is a separate slice (followups doc #3)." That slice **is this plan**. We do *not* need to add the slot — we need to:
   - Make the kernel actually call it.
   - Update the doc comment on the slot to drop the "kernel does NOT call this yet" qualifier.

2. **`@ax/test-harness` already drains plugins in reverse load order.** `packages/test-harness/src/harness.ts:60-126` implements a `close()` method that walks `plugins` in **reverse-input** order (not reverse-topological), calls each `shutdown?()` under a 10 s timeout, and isolates per-plugin failures. The `withTimeout` helper at `harness.ts:128-149` is the reference implementation for the kernel-side timeout — **lift its shape into `@ax/core`**, don't reinvent it. After this slice, the test-harness `close()` continues to work (its reverse-input order is "good enough for tests" by its own comment); we don't need to rewrite test-harness in this slice.

3. **A new escape-hatch interface appeared since the handoff.** `packages/ipc-http/src/plugin.ts:33-39` exposes `IpcHttpPlugin extends Plugin { closeListener(): Promise<void> }` with the same "the planned kernel-shutdown lifecycle will call this from the kernel side on SIGTERM" comment. Fold this into `Plugin.shutdown` the same way we fold the two postgres ones. The handoff-doc-listed-six → in-scope-seven count is the only delta; the work shape is identical.

The handoff's other assumptions still hold (per-plugin file:line pointers, the shape of init-failure rollback in session-postgres, the architecture decisions). Re-read the handoff once before starting.

---

## Branch setup

```bash
git checkout main
git pull --ff-only
git checkout -b feat/kernel-shutdown-lifecycle
```

All work happens on `feat/kernel-shutdown-lifecycle`. Each task ends with a focused commit. Land as one PR.

---

## Invariants this slice must preserve

These are the failure modes the handoff and the previous slices' postmortems flagged. Each task's tests close one or more of these out — number them Iₙ for the PR description:

- **I1 — Reverse-topological order.** Shutdown order is the reverse of init order. A plugin that consumed `database:get-instance` during init must shut down BEFORE the database plugin closes its pool. The test-harness's reverse-input order is *not* sufficient for the kernel; it works there only because tests usually push plugins in topological order anyway.
- **I2 — Isolated failures.** A throwing or hanging plugin's `shutdown()` must NOT prevent peer plugins' shutdowns from running. Each runs under its own try/catch + per-plugin timeout.
- **I3 — Idempotent handle.** `handle.shutdown()` called twice resolves both calls without re-running any plugin's `shutdown()`. Implementation: cache the first call's promise.
- **I4 — Init-failure rollback.** When `init()` throws on plugin index N, the kernel runs `shutdown()` on plugins 0..N-1 in reverse order under the same per-plugin timeout, logs failures, then re-throws the original `PluginError` (not a wrapped one). Plugin N's `shutdown()` is NOT called — its init didn't complete.
- **I5 — Kernel does not install signal handlers.** Hosts (CLI, `serve`) wire signals; the kernel only exposes `KernelHandle.shutdown()`. Tests must be able to drive shutdown directly without competing with `process.on('SIGINT')`.
- **I6 — Sequential, not concurrent.** Shutdown calls are sequential (`await` between each). Reverse-topological order matters precisely because dependencies do; running them in parallel defeats the ordering.
- **I7 — Strictly resource release.** `shutdown()` is for closing connections, file handles, listeners, timers. **No** final database writes, audit-log emissions, in-flight-work flushes. Those would belong on a future `Plugin.drain?()` phase. Adding any non-release work in `shutdown()` is a bug we catch in code review.
- **I8 — No new capability surface.** This slice adds no IPC actions, no new wire protocols, no new sandbox boundaries. The `security-checklist` skill does NOT need to fire.
- **I9 — All `TODO(kernel-shutdown)` comments are gone.** A grep across `packages/` returns zero matches at the end of the slice.
- **I10 — All escape-hatch interfaces are gone.** `EventbusPostgresPlugin`, `SessionPostgresPlugin`, `IpcHttpPlugin` are deleted; their factories return plain `Plugin`. Tests that cast through them switch to driving shutdown via the test-harness `close()` (which now sits on top of the kernel-side change for free, since `Plugin.shutdown` is the canonical slot).

---

## Suggested execution order

The kernel orchestration (Task 1, 2) is the prerequisite for everything else. After that, the per-plugin tasks (3–9) are independent and can dispatch in parallel. Tasks 10–11 (host call sites) come after the per-plugin sweep so the CLI/serve binaries can exercise real shutdowns. Task 12 is the final grep + green-test verification.

```
Task 1 (Plugin slot doc) ──┐
Task 2 (KernelHandle)   ───┼── Task 3..9 (per-plugin sweep) ─── Task 10..11 (host wiring) ─── Task 12 (verify)
```

---

## Task 1: Update `Plugin.shutdown` doc-comment

**Files:**
- Modify: `packages/core/src/plugin.ts:22-36`

**Step 1: Replace the doc-comment**

Replace the existing doc-comment block above `shutdown?` with one that reflects the post-kernel-shutdown reality. The slot itself stays — only the comment changes.

```ts
  /**
   * Optional cleanup hook. The kernel calls this in reverse load order
   * (the reverse of `init()`'s topological order) when `KernelHandle.
   * shutdown()` is invoked, and on init failure for plugins that
   * already initialized. Each plugin's `shutdown()` runs under a
   * configurable per-plugin timeout (default 10 s); failures and
   * timeouts are logged but never block peer plugins from shutting
   * down.
   *
   * Plugins without long-lived resources (file handles, connection
   * pools, HTTP listeners, timers) don't need to implement this.
   *
   * Contract:
   * - **Idempotent.** May be called twice in pathological races; the
   *   second call must be a no-op or a safe re-close. The kernel's
   *   handle is itself idempotent (see `KernelHandle.shutdown`), so
   *   this matters mainly for plugins called directly by tests.
   * - **Resource release only.** No final writes, no flushes of
   *   in-flight work, no audit emissions. A future `drain?()` phase
   *   will own that if we ever need it. Keeping `shutdown()` strictly
   *   about resources makes it safe to call from a SIGINT handler.
   * - **Bounded in time.** A 10 s per-plugin ceiling is enforced by
   *   the kernel; plan accordingly.
   */
```

**Step 2: Run the existing core tests**

```bash
pnpm test --filter @ax/core
```

Expected: PASS — no behavioral change yet.

**Step 3: Commit**

```bash
git add packages/core/src/plugin.ts
git commit -m "docs(core): update Plugin.shutdown doc for kernel-driven lifecycle"
```

---

## Task 2: Add `KernelHandle` + kernel-side shutdown to `bootstrap()`

This is the central change. We change `bootstrap()`'s return type from `Promise<void>` to `Promise<KernelHandle>`, add per-plugin shutdown orchestration with a timeout, add init-failure rollback, and export the new types.

**Files:**
- Modify: `packages/core/src/bootstrap.ts` (entire file)
- Modify: `packages/core/src/index.ts` (export new types)
- Test: `packages/core/src/__tests__/bootstrap.test.ts` (extend with new shutdown tests)

**Step 1: Write the failing tests first (TDD)**

Append the following test cases to `packages/core/src/__tests__/bootstrap.test.ts`. The existing tests at lines 20-80 stay; add a new `describe('bootstrap shutdown', ...)` block at the end of the file.

```ts
describe('bootstrap shutdown', () => {
  it('returns a KernelHandle whose shutdown calls plugins in reverse topological order', async () => {
    const order: string[] = [];
    const a = makePlugin(
      { name: 'a', registers: ['a:do'] },
      ({ bus }) => { bus.registerService('a:do', 'a', async () => 0); },
    );
    (a as Plugin).shutdown = () => { order.push('a'); };

    const b = makePlugin(
      { name: 'b', registers: ['b:do'], calls: ['a:do'] },
      ({ bus }) => { bus.registerService('b:do', 'b', async () => 0); },
    );
    (b as Plugin).shutdown = () => { order.push('b'); };

    const c = makePlugin(
      { name: 'c', calls: ['b:do'] },
    );
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
    });
    await handle.shutdown();
    // Init order: a, b, c (topological). Reverse: c, b, a.
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('skips plugins without a shutdown method', async () => {
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { order.push('b'); };
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b],
      config: {},
    });
    await handle.shutdown();
    expect(order).toEqual(['b']);
  });

  it('a throwing shutdown does not block peer plugins; failure is reported', async () => {
    const order: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = async () => { throw new Error('boom'); };
    const c = makePlugin({ name: 'c' });
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
      onShutdownError: (plugin, err) => errors.push({ plugin, err }),
    });
    await handle.shutdown();
    // Reverse order: c (ok), b (throws), a (ok). All three slots run.
    expect(order).toEqual(['c', 'a']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.plugin).toBe('b');
    expect((errors[0]!.err as Error).message).toBe('boom');
  });

  it('a hanging shutdown is timed out; peer plugins still run', async () => {
    const order: string[] = [];
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => new Promise<void>(() => {}); // never resolves
    const c = makePlugin({ name: 'c' });
    (c as Plugin).shutdown = () => { order.push('c'); };

    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a, b, c],
      config: {},
      shutdownTimeoutMs: 50,
      onShutdownError: (plugin, err) => errors.push({ plugin, err }),
    });
    await handle.shutdown();
    expect(order).toEqual(['c', 'a']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.plugin).toBe('b');
    expect(String(errors[0]!.err)).toMatch(/exceeded 50ms/);
  });

  it('handle.shutdown is idempotent — second call resolves without re-running plugins', async () => {
    let count = 0;
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { count++; };
    const handle = await bootstrap({
      bus: new HookBus(),
      plugins: [a],
      config: {},
    });
    await handle.shutdown();
    await handle.shutdown();
    await handle.shutdown();
    expect(count).toBe(1);
  });

  it('init failure runs shutdown on plugins 0..N-1 in reverse order before re-throwing', async () => {
    const order: string[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { order.push('a-down'); };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { order.push('b-down'); };
    const c = makePlugin({ name: 'c' }, () => { throw new Error('c-init-failed'); });
    (c as Plugin).shutdown = () => { order.push('c-down'); };
    const d = makePlugin({ name: 'd' });
    (d as Plugin).shutdown = () => { order.push('d-down'); };

    await expect(
      bootstrap({ bus: new HookBus(), plugins: [a, b, c, d], config: {} }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'init-failed', plugin: 'c' });
    // Plugins a, b initialized; c failed (its shutdown is NOT called); d never
    // initialized. Rollback runs b then a.
    expect(order).toEqual(['b-down', 'a-down']);
  });

  it('init-failure rollback isolates throwing/timing-out shutdowns', async () => {
    const errors: { plugin: string; err: unknown }[] = [];
    const a = makePlugin({ name: 'a' });
    (a as Plugin).shutdown = () => { /* ok */ };
    const b = makePlugin({ name: 'b' });
    (b as Plugin).shutdown = () => { throw new Error('b-down-failed'); };
    const c = makePlugin({ name: 'c' }, () => { throw new Error('c-init-failed'); });

    await expect(
      bootstrap({
        bus: new HookBus(),
        plugins: [a, b, c],
        config: {},
        onShutdownError: (plugin, err) => errors.push({ plugin, err }),
      }),
    ).rejects.toMatchObject({ code: 'init-failed', plugin: 'c' });
    // Both rollback shutdowns ran; b's failure went to onShutdownError.
    expect(errors.map((e) => e.plugin)).toEqual(['b']);
  });
});
```

**Step 2: Run the new tests to verify they fail**

```bash
pnpm test --filter @ax/core -- bootstrap.test.ts
```

Expected: tests in the new `bootstrap shutdown` block FAIL — `bootstrap()` currently returns `void`, has no `KernelHandle`, no `shutdownTimeoutMs`, no `onShutdownError`, no init-failure rollback.

**Step 3: Update `bootstrap.ts` to pass the tests**

Replace the entire contents of `packages/core/src/bootstrap.ts` with:

```ts
import type { HookBus } from './hook-bus.js';
import { PluginError } from './errors.js';
import { PluginManifestSchema, type Plugin } from './plugin.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface BootstrapOptions {
  bus: HookBus;
  plugins: Plugin[];
  config: Record<string, unknown>;
  /**
   * Per-plugin shutdown timeout in milliseconds. Defaults to 10_000 to
   * match `IPC_TIMEOUTS_MS` and give slow drains (in-flight queries,
   * LISTEN client end, k8s informer cleanup) breathing room without
   * unbounded waits. A misbehaving plugin can't hold the process
   * hostage past this ceiling.
   */
  shutdownTimeoutMs?: number;
  /**
   * Sink for shutdown errors. Invoked once per plugin whose
   * `shutdown()` throws or times out. The kernel always logs to
   * `process.stderr` if no sink is provided. Hosts that want
   * structured logs (e.g., the `serve` binary feeding a JSON logger)
   * pass an explicit sink.
   *
   * Init-failure rollback uses the same sink — that path also calls
   * `shutdown()` on already-initialized plugins, and their failures
   * deserve the same routing as a normal-shutdown failure.
   */
  onShutdownError?: (pluginName: string, err: unknown) => void;
}

/**
 * Returned by `bootstrap()`. The host calls `shutdown()` on SIGTERM /
 * SIGINT (or whenever the process needs a clean teardown). Idempotent:
 * the first call kicks off the shutdown sequence and caches its
 * promise; subsequent calls return the cached promise without
 * re-running any plugin's `shutdown()`.
 *
 * The kernel intentionally does NOT install signal handlers — that's
 * the host's job. Tests drive `shutdown()` directly; embedded uses
 * keep their parent process in charge of signal lifecycle.
 */
export interface KernelHandle {
  shutdown(): Promise<void>;
}

export async function bootstrap(opts: BootstrapOptions): Promise<KernelHandle> {
  const { bus, plugins, config } = opts;
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onShutdownError =
    opts.onShutdownError ??
    ((name: string, err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kernel: plugin '${name}' shutdown failed: ${msg}\n`);
    });

  for (const p of plugins) {
    const parsed = PluginManifestSchema.safeParse(p.manifest);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-manifest',
        plugin: p.manifest?.name ?? 'unknown',
        message: `invalid plugin manifest: ${parsed.error.message}`,
        cause: parsed.error,
      });
    }
  }

  checkDuplicatePluginNames(plugins);
  const graph = validateDependencyGraph(plugins);
  const order = topologicalOrder(plugins, graph);

  // Track which plugins have completed init so a mid-init failure can roll
  // back only the prefix that succeeded (I4). The failing plugin itself is
  // NOT included — its init didn't complete, so its resources may not
  // exist, and calling its shutdown could race or NPE on partial state.
  const initialized: Plugin[] = [];
  for (const p of order) {
    try {
      await p.init({ bus, config: config[p.manifest.name] });
      initialized.push(p);
    } catch (err) {
      // Roll back already-initialized plugins under the same per-plugin
      // timeout + isolation as normal shutdown.
      await runShutdownLoop(initialized, shutdownTimeoutMs, onShutdownError);
      if (err instanceof PluginError) throw err;
      throw new PluginError({
        code: 'init-failed',
        plugin: p.manifest.name,
        message: `plugin '${p.manifest.name}' init failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  verifyCalls(plugins, bus);

  // Idempotent handle: cache the first shutdown's promise so SIGINT-then-
  // SIGTERM (common during deploys) doesn't re-run plugin shutdowns.
  let shutdownPromise: Promise<void> | undefined;
  return {
    shutdown(): Promise<void> {
      if (shutdownPromise === undefined) {
        shutdownPromise = runShutdownLoop(
          initialized,
          shutdownTimeoutMs,
          onShutdownError,
        );
      }
      return shutdownPromise;
    },
  };
}

// Walks `plugins` in REVERSE order, calling each plugin's optional
// `shutdown()` under a per-plugin timeout. Per-plugin failures are reported
// to `onError` but never rejected — the next plugin's shutdown still runs
// (I2). The reverse of init-time topological order is shutdown order (I1):
// a plugin that consumed another's services during init must close before
// the producer does.
async function runShutdownLoop(
  plugins: Plugin[],
  timeoutMs: number,
  onError: (pluginName: string, err: unknown) => void,
): Promise<void> {
  for (let i = plugins.length - 1; i >= 0; i--) {
    const p = plugins[i]!;
    if (typeof p.shutdown !== 'function') continue;
    try {
      await withTimeout(
        Promise.resolve(p.shutdown()),
        timeoutMs,
        `plugin '${p.manifest.name}' shutdown exceeded ${timeoutMs}ms`,
      );
    } catch (err) {
      onError(p.manifest.name, err);
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // Don't keep the event loop alive on the timer alone. Mirrors the
    // test-harness `withTimeout` (harness.ts:128-149): a Node process
    // otherwise idle should still be allowed to exit.
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// (Existing helpers — keep verbatim from the current file.)
function validateDependencyGraph(plugins: Plugin[]): Map<string, string[]> {
  const producers = checkDuplicateRegisters(plugins);
  const graph = buildCallGraph(plugins, producers);
  assertAcyclic(graph);
  return graph;
}

function checkDuplicatePluginNames(plugins: Plugin[]): void {
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.manifest.name)) {
      throw new PluginError({
        code: 'duplicate-plugin',
        plugin: p.manifest.name,
        message: `plugin name '${p.manifest.name}' appears more than once in the plugin list`,
      });
    }
    seen.add(p.manifest.name);
  }
}

function checkDuplicateRegisters(plugins: Plugin[]): Map<string, string> {
  const producers = new Map<string, string>();
  for (const p of plugins) {
    for (const r of p.manifest.registers) {
      const existing = producers.get(r);
      if (existing !== undefined && existing !== p.manifest.name) {
        throw new PluginError({
          code: 'duplicate-service',
          plugin: p.manifest.name,
          hookName: r,
          message: `service hook '${r}' registered by both '${existing}' and '${p.manifest.name}'`,
        });
      }
      producers.set(r, p.manifest.name);
    }
  }
  return producers;
}

function buildCallGraph(plugins: Plugin[], producers: Map<string, string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const p of plugins) {
    const out: string[] = [];
    for (const c of p.manifest.calls) {
      const prod = producers.get(c);
      if (prod !== undefined && prod !== p.manifest.name) out.push(prod);
    }
    graph.set(p.manifest.name, out);
  }
  return graph;
}

function assertAcyclic(graph: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (node: string, stack: string[]): void => {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      const cycle = stack.slice(cycleStart).concat(node).join(' → ');
      throw new PluginError({
        code: 'cycle',
        plugin: node,
        message: `plugin call cycle detected: ${cycle}`,
      });
    }
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      visit(next, [...stack, node]);
    }
    visiting.delete(node);
    done.add(node);
  };

  for (const name of graph.keys()) visit(name, []);
}

function topologicalOrder(plugins: Plugin[], graph: Map<string, string[]>): Plugin[] {
  const byName = new Map(plugins.map((p) => [p.manifest.name, p] as const));
  const visited = new Set<string>();
  const order: Plugin[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of graph.get(name) ?? []) visit(dep);
    const plugin = byName.get(name);
    if (plugin !== undefined) order.push(plugin);
  };

  for (const p of plugins) visit(p.manifest.name);
  return order;
}

function verifyCalls(plugins: Plugin[], bus: HookBus): void {
  for (const p of plugins) {
    for (const hook of p.manifest.calls) {
      if (!bus.hasService(hook)) {
        throw new PluginError({
          code: 'missing-service',
          plugin: p.manifest.name,
          hookName: hook,
          message: `plugin '${p.manifest.name}' declares calls:['${hook}'] but no plugin registers it`,
        });
      }
    }
  }
}
```

**Step 4: Export `KernelHandle` from `@ax/core`**

`packages/core/src/index.ts` already does `export * from './bootstrap.js';` — `KernelHandle` will be exported automatically. Verify:

```bash
grep -n "KernelHandle\|bootstrap" packages/core/src/index.ts
```

Expected: `export * from './bootstrap.js';` is present. No edit needed.

**Step 5: Update existing call sites whose old return type was `Promise<void>`**

The signature change is technically backwards-compatible — `Promise<KernelHandle>` is assignable where `Promise<void>` was used (callers that ignore the return value still work). But: TypeScript with `noUnusedLocals`/`noUnusedParameters` won't catch a discarded handle. Verify all call sites compile cleanly:

```bash
pnpm build --filter @ax/core --filter @ax/cli --filter @ax/test-harness
```

Expected: BUILD passes. No call site changes needed in this task — Tasks 10/11 will update host call sites to actually capture and use the handle.

**Step 6: Run tests**

```bash
pnpm test --filter @ax/core
```

Expected: all tests PASS, including the seven new shutdown tests.

**Step 7: Commit**

```bash
git add packages/core/src/bootstrap.ts packages/core/src/__tests__/bootstrap.test.ts
git commit -m "feat(core): KernelHandle.shutdown lifecycle with reverse-topological order, per-plugin timeout, init-failure rollback"
```

---

## Task 3: Add `shutdown()` to `@ax/database-postgres`

**Files:**
- Modify: `packages/database-postgres/src/plugin.ts:60-90`

**Step 1: Look at how session-postgres already does it**

Read `packages/session-postgres/src/plugin.ts:384-400` for the pattern. Note: `await kysely.destroy()` closes the underlying `pg.Pool` via PostgresDialect — no separate `pool.end()` needed.

**Step 2: Add shutdown to `database-postgres`**

In `packages/database-postgres/src/plugin.ts`, change the plugin to capture the kysely instance for shutdown and add the `shutdown` slot:

```ts
export function createDatabasePostgresPlugin(config: DatabasePostgresConfig): Plugin {
  let kysely: Kysely<unknown> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['database:get-instance'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      validateConnectionString(config.connectionString);
      const bgLogger =
        config.logger ?? createLogger({ reqId: 'database-postgres-bg' });

      const pool = new pg.Pool({
        connectionString: config.connectionString,
        max: config.poolMax ?? 10,
      });
      pool.on('error', (err) => {
        bgLogger.error('database_postgres_pool_error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      });
      kysely = new Kysely<unknown>({
        dialect: new PostgresDialect({ pool }),
      });

      bus.registerService<unknown, DatabaseGetInstanceOutput>(
        'database:get-instance',
        PLUGIN_NAME,
        async () => ({ db: kysely! }),
      );
    },
    async shutdown() {
      if (kysely !== undefined) {
        await kysely.destroy().catch(() => {
          // best-effort; PostgresDialect closes pg.Pool internally.
        });
        kysely = undefined;
      }
    },
  };
}
```

Specifically: delete the `// TODO(kernel-shutdown):` comment block at lines 60-62, and add the `async shutdown()` method.

**Step 3: Run tests**

```bash
pnpm test --filter @ax/database-postgres
```

Expected: PASS (existing tests should be unaffected; this plugin's tests don't currently exercise shutdown).

**Step 4: Verify the TODO is gone**

```bash
grep -n "TODO(kernel-shutdown)" packages/database-postgres/src/plugin.ts
```

Expected: zero matches.

**Step 5: Commit**

```bash
git add packages/database-postgres/src/plugin.ts
git commit -m "feat(database-postgres): shutdown closes Kysely + pg.Pool"
```

---

## Task 4: Add `shutdown()` to `@ax/storage-sqlite`

**Files:**
- Modify: `packages/storage-sqlite/src/plugin.ts:14-61`

**Step 1: Add shutdown**

`db.destroy()` on a `Kysely<Database>` calls `better-sqlite3`'s `Database#close`, which flushes the WAL and releases the file handle. Replace the entire `createStorageSqlitePlugin` function with:

```ts
export function createStorageSqlitePlugin(config: StorageSqliteConfig): Plugin {
  let db: Kysely<Database> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      db = openDatabase(config.databasePath);

      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        PLUGIN_NAME,
        async (_ctx, { key }) => {
          const row = await db!
            .selectFrom('kv')
            .select('value')
            .where('key', '=', key)
            .executeTakeFirst();
          if (row === undefined) return { value: undefined };
          return { value: new Uint8Array(row.value) };
        },
      );

      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, { key, value }) => {
          await db!
            .insertInto('kv')
            .values({ key, value: Buffer.from(value) })
            .onConflict((oc) =>
              oc.column('key').doUpdateSet({
                value: Buffer.from(value),
                updated_at: new Date().toISOString(),
              }),
            )
            .execute();
        },
      );
    },
    async shutdown() {
      if (db !== undefined) {
        await db.destroy().catch(() => {
          // best-effort; better-sqlite3's close is sync but Kysely wraps it.
        });
        db = undefined;
      }
    },
  };
}
```

Specifically: delete the `// TODO(kernel-shutdown):` comment block at lines 22-25, add the `async shutdown()` method.

**Step 2: Run tests**

```bash
pnpm test --filter @ax/storage-sqlite
```

Expected: PASS.

**Step 3: Verify the TODO is gone**

```bash
grep -n "TODO(kernel-shutdown)" packages/storage-sqlite/src/plugin.ts
```

Expected: zero matches.

**Step 4: Commit**

```bash
git add packages/storage-sqlite/src/plugin.ts
git commit -m "feat(storage-sqlite): shutdown closes Kysely (flushes WAL, releases file handle)"
```

---

## Task 5: Drop `EventbusPostgresPlugin` interface; return plain `Plugin`

The `shutdown()` impl already exists at `packages/eventbus-postgres/src/plugin.ts:174-181`. Today it sits on a public `EventbusPostgresPlugin extends Plugin { shutdown(): Promise<void> }` escape-hatch interface that tests cast through. Now that the kernel calls `Plugin.shutdown` natively, the interface goes away.

**Files:**
- Modify: `packages/eventbus-postgres/src/plugin.ts:60-72`
- Modify: `packages/eventbus-postgres/src/index.ts` (drop the `EventbusPostgresPlugin` re-export)
- Modify: `packages/eventbus-postgres/src/__tests__/plugin.test.ts` (switch to driving shutdown via `h.close()`)

**Step 1: Remove the escape-hatch interface**

In `packages/eventbus-postgres/src/plugin.ts`:

- Delete the entire `/** Same shape as a Plugin... */` doc block + `export interface EventbusPostgresPlugin extends Plugin { shutdown(): Promise<void>; }` (lines 60-68).
- Change `createEventbusPostgresPlugin`'s return type from `EventbusPostgresPlugin` to `Plugin` (lines 70-72).

The `async shutdown()` body stays — it's now just the optional `Plugin.shutdown` slot.

**Step 2: Drop the re-export**

In `packages/eventbus-postgres/src/index.ts`, find and delete the `type EventbusPostgresPlugin,` line.

```bash
grep -n "EventbusPostgresPlugin" packages/eventbus-postgres/src/index.ts
```

Expected: zero matches after edit.

**Step 3: Update tests to drive shutdown via the kernel handle**

In `packages/eventbus-postgres/src/__tests__/plugin.test.ts`:

- Drop the `type EventbusPostgresPlugin,` import.
- Replace the `const opened: EventbusPostgresPlugin[] = [];` with whatever the test currently uses to track the **harness** (since it already uses `createTestHarness`, the simplest fix is to track harnesses and call `.close()`):

```ts
// before
const opened: EventbusPostgresPlugin[] = [];
// after
const harnesses: Awaited<ReturnType<typeof createTestHarness>>[] = [];
```

In `makeHarness()`, push the harness instead of the plugin:

```ts
async function makeHarness() {
  const plugin = createEventbusPostgresPlugin({ connectionString });
  const h = await createTestHarness({ plugins: [plugin] });
  harnesses.push(h);
  return h;
}
```

In `afterEach`:

```ts
afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    await h.close({ onError: () => {} });
  }
  // ... rest of cleanup unchanged
});
```

Also delete the obsolete comment block at lines 33-34 of the test file ("There's no kernel shutdown lifecycle yet (TODO: kernel-shutdown), so the factory exposes shutdown() directly.").

**Step 4: Run tests**

```bash
pnpm test --filter @ax/eventbus-postgres
```

Expected: PASS.

**Step 5: Verify**

```bash
grep -rn "EventbusPostgresPlugin" packages/eventbus-postgres/
```

Expected: zero matches in `src/`.

**Step 6: Commit**

```bash
git add packages/eventbus-postgres/
git commit -m "refactor(eventbus-postgres): drop EventbusPostgresPlugin escape-hatch; kernel calls Plugin.shutdown"
```

---

## Task 6: Drop `SessionPostgresPlugin` interface; collapse hand-rolled init-failure rollback

The same shape change as Task 5, plus we get to delete the hand-rolled init-failure rollback at `packages/session-postgres/src/plugin.ts:257-279` because the kernel now does it.

**Files:**
- Modify: `packages/session-postgres/src/plugin.ts` (drop interface, collapse rollback)
- Modify: `packages/session-postgres/src/index.ts` (drop re-export)
- Modify: `packages/session-postgres/src/__tests__/plugin.test.ts` (switch to harness)
- Modify: `packages/session-postgres/src/__tests__/error-handlers.test.ts` (switch to harness)

**Step 1: Remove the escape-hatch interface**

In `packages/session-postgres/src/plugin.ts`:

- Delete the `/** Same shape as a Plugin... */` doc block + `export interface SessionPostgresPlugin extends Plugin { shutdown(): Promise<void>; }` (lines 92-100).
- Change `createSessionPostgresPlugin`'s return type from `SessionPostgresPlugin` to `Plugin` (lines 198-200).

**Step 2: Collapse the hand-rolled init-failure cleanup**

The current init body at `packages/session-postgres/src/plugin.ts:227-282` has a try/catch that closes the listenClient + destroys kysely on failure. With kernel-driven init-failure rollback, the kernel calls `shutdown()` on plugins 0..N-1 — but **it does NOT call shutdown on the failing plugin itself** (I4). So we have a choice:

- **Option A:** Keep the try/catch. The kernel won't call `shutdown` on the failing plugin, so without the try/catch the migration/connect failure leaks the partial kysely+listenClient.
- **Option B:** Remove the try/catch and rely on… nothing — the resources leak.

**Pick Option A.** The kernel rollback does NOT call the failing plugin's shutdown by design — its init didn't complete, partial state may not be safe to call `shutdown()` against. So this plugin still needs to clean up its own partials on its own throw. **But** — we can simplify the body now that the only thing it has to clean up is the partial init, not "everything in case the kernel ever shuts us down."

Update lines 257-279 to:

```ts
      try {
        await runSessionMigration(kysely);
        await listenClient.connect();
      } catch (err) {
        // Mid-init failure: the kernel will NOT call our shutdown (its init
        // didn't complete). Close the partial allocations so we don't leak a
        // pool / socket. Once both connect + migrate succeed, the kernel's
        // rollback owns subsequent cleanup if a LATER plugin's init fails.
        try {
          await listenClient.end();
        } catch {
          // best-effort
        }
        try {
          await kysely.destroy();
        } catch {
          // best-effort
        }
        listenClient = undefined;
        kysely = undefined;
        pool = undefined;
        throw err;
      }
```

The change is purely the comment update — drop the "TODO: kernel-shutdown" reference. The try/catch stays.

**Step 3: Drop the re-export**

In `packages/session-postgres/src/index.ts`, find and delete the `type SessionPostgresPlugin,` line.

```bash
grep -n "SessionPostgresPlugin" packages/session-postgres/src/index.ts
```

Expected: zero matches after edit.

**Step 4: Update tests**

`packages/session-postgres/src/__tests__/plugin.test.ts`:

- Drop the `type SessionPostgresPlugin,` import (line 11).
- Convert `const opened: SessionPostgresPlugin[] = []` (line 22) and the `afterEach` shutdown loop (lines 36-43) to track harnesses instead of plugins, identical pattern to Task 5.

`packages/session-postgres/src/__tests__/error-handlers.test.ts`:

- Same pattern. Drop `type SessionPostgresPlugin,` import (line 7), convert `opened` (line 27) and the shutdown call (line 37) to harness-driven.

**Step 5: Run tests**

```bash
pnpm test --filter @ax/session-postgres
```

Expected: PASS.

**Step 6: Verify**

```bash
grep -rn "SessionPostgresPlugin" packages/session-postgres/
```

Expected: zero matches in `src/`.

**Step 7: Commit**

```bash
git add packages/session-postgres/
git commit -m "refactor(session-postgres): drop SessionPostgresPlugin escape-hatch; kernel calls Plugin.shutdown"
```

---

## Task 7: Verify `@ax/sandbox-k8s` resource-cleanup needs

The handoff flagged this as "verify whether `@kubernetes/client-node`'s API client retains a Node `http.Agent` that needs explicit `agent.destroy()`."

**Files:**
- Inspect: `packages/sandbox-k8s/src/k8s-api.ts:71-86`
- Inspect: `packages/sandbox-k8s/SECURITY.md:110-114` (notes the HTTP client is `node-fetch`)
- Possibly modify: `packages/sandbox-k8s/src/plugin.ts` (add `shutdown` if needed)

**Step 1: Investigate**

Run:

```bash
grep -rn "Agent\|agent" node_modules/@kubernetes/client-node/dist/ 2>/dev/null | grep -i "http" | head -20
node -e "const k = require('@kubernetes/client-node'); const kc = new k.KubeConfig(); console.log(typeof k.CoreV1Api)" 2>&1 | head -5
```

The 1.x line of `@kubernetes/client-node` migrated off axios to `node-fetch` (per the SECURITY.md note). `node-fetch` uses Node's default global agent unless an explicit one is configured; that global agent is shared with the rest of the Node process and **does not need `agent.destroy()`** at plugin teardown — destroying it would harm any peer code using it.

**Step 2: Decision tree**

- If the inspection above confirms there's no per-client `http.Agent` retained → document the finding in a code comment in `plugin.ts` and skip adding `shutdown()` to `sandbox-k8s`. Acceptable outcome.
- If the inspection shows the client retains a per-instance `http.Agent` (we own its lifecycle) → add a `shutdown()` that calls `agent.destroy()`.

In practice **expect the first outcome.** The handoff already hedged on this ("verify when picking up — if `@kubernetes/client-node` already cleans up via its own teardown, this can be dropped from scope").

**Step 3: Document the verification in code**

If skipping: add a short comment in `packages/sandbox-k8s/src/plugin.ts` near the `createDefaultK8sApi()` call (around line 39) noting the verification result. Example:

```ts
      // Verified during the kernel-shutdown slice: @kubernetes/client-node@1.x
      // uses node-fetch with the global http.Agent. We don't own a per-client
      // agent that needs `.destroy()`. No `shutdown()` slot needed for this
      // plugin until that changes (e.g., if the library moves back to axios
      // with an explicit agent).
      const api = apiOverride ?? (await createDefaultK8sApi());
```

If adding shutdown: implement it the same shape as the others (capture the api or its agent in a closure, call `agent.destroy()` in `shutdown()`).

**Step 4: Run tests**

```bash
pnpm test --filter @ax/sandbox-k8s
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/sandbox-k8s/src/plugin.ts
git commit -m "chore(sandbox-k8s): document HTTP agent cleanup verification (no shutdown needed)"
# OR if a shutdown was added:
git commit -m "feat(sandbox-k8s): shutdown destroys HTTP agent"
```

---

## Task 8: Drop `IpcHttpPlugin` interface; fold `closeListener` into `shutdown`

`packages/ipc-http/src/plugin.ts:33-39` exposes the same kind of escape-hatch interface as the postgres ones. Today the `serve` binary holds a closeListener reference and calls it directly. With kernel-driven shutdown, the `IpcHttpPlugin` interface goes away and the close logic moves into `Plugin.shutdown`.

**Files:**
- Modify: `packages/ipc-http/src/plugin.ts:33-80`
- Modify: `packages/ipc-http/src/index.ts` (drop the `IpcHttpPlugin` re-export if any)
- Update: `packages/ipc-http/src/__tests__/*.test.ts` (anything that casts to `IpcHttpPlugin` switches to harness-driven)

**Step 1: Inspect current usage**

```bash
grep -rn "IpcHttpPlugin\|closeListener" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/
```

This will show the interface, its consumers, and any place that calls `closeListener` directly.

**Step 2: Convert plugin.ts**

In `packages/ipc-http/src/plugin.ts`:

- Delete the `export interface IpcHttpPlugin extends Plugin { closeListener(): Promise<void>; }` block (lines 33-39).
- Change `createIpcHttpPlugin`'s return type to `Plugin`.
- Move the `closeListener` body into a `shutdown()` slot. It already does the right thing (close the http listener if non-null), just move + rename:

```ts
export function createIpcHttpPlugin(opts: CreateIpcHttpPluginOptions): Plugin {
  let listener: HttpListener | null = null;

  return {
    manifest: { /* unchanged */ },
    async init({ bus }) {
      listener = await createHttpListener({ host: opts.host, port: opts.port, bus });
      process.stderr.write(
        `[ax/ipc-http] listening on http://${listener.host}:${listener.port}\n`,
      );
    },
    async shutdown() {
      if (listener !== null) {
        const l = listener;
        listener = null;
        await l.close();
      }
    },
  };
}
```

**Step 3: Drop the re-export**

```bash
grep -n "IpcHttpPlugin" packages/ipc-http/src/index.ts
```

If present, delete it.

**Step 4: Update tests + Task 11 dependency**

The `serve` command's tests and the `@ax/preset-k8s` tests may rely on `closeListener` directly. Audit those call sites:

```bash
grep -rn "closeListener" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/
```

For each match, switch to driving shutdown via the test's `createTestHarness({ plugins }).close()`. The serve binary's signal-handler path will be addressed in Task 11.

**Step 5: Run tests**

```bash
pnpm test --filter @ax/ipc-http
```

Expected: PASS.

**Step 6: Verify**

```bash
grep -rn "IpcHttpPlugin\b" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/
```

Expected: zero matches in `src/`.

**Step 7: Commit**

```bash
git add packages/ipc-http/ packages/preset-k8s/ 2>/dev/null || git add packages/ipc-http/
git commit -m "refactor(ipc-http): drop IpcHttpPlugin escape-hatch; fold closeListener into Plugin.shutdown"
```

---

## Task 9: Verify `@ax/eventbus-inprocess` and `@ax/workspace-git` need no shutdown

The handoff explicitly flagged these as "verify when picking up; if it does hold a timer or interval, add one." Most likely outcome: nothing to clean up. This task is a quick audit + a small comment, not real implementation work.

**Step 1: Audit eventbus-inprocess**

```bash
grep -nE "setInterval|setTimeout|new (Map|Set)|listener|server" packages/eventbus-inprocess/src/plugin.ts
```

The plugin is a pure in-memory map + bus registrations. **No shutdown needed.** No code change.

**Step 2: Audit workspace-git**

```bash
grep -nE "setInterval|setTimeout|listener|server|fs\.open|FSWatcher" packages/workspace-git/src/plugin.ts packages/workspace-git-core/src/*.ts
```

The plugin uses `isomorphic-git` against the local filesystem. No long-lived handles between calls. **No shutdown needed.**

**Step 3: Audit workspace-git-http (host plugin only)**

```bash
grep -nE "setInterval|setTimeout|listener|http\.Agent|http\.Server" packages/workspace-git-http/src/plugin.ts packages/workspace-git-http/src/client.ts
```

The host-side plugin is an HTTP client. If `client.ts` constructs a per-client `http.Agent` with keep-alive, add a `shutdown()` that destroys it. If it uses Node's global agent (most likely), no shutdown needed — same logic as Task 7.

**Step 4: Document the verification**

If all three plugins came up clean, add a one-liner to whichever of those plugin files the next reader will look at first. Example, in `packages/eventbus-inprocess/src/plugin.ts` near the top of the returned plugin object:

```ts
    // No shutdown slot: the in-memory channel map is GC'd with the plugin
    // closure. Verified during the kernel-shutdown slice.
```

(Optional. If you don't want a comment-rot trap, just skip the comment.)

**Step 5: Commit (if anything changed)**

```bash
git add packages/eventbus-inprocess/ packages/workspace-git/ packages/workspace-git-http/
git commit -m "chore(workspace,eventbus-inprocess): verified no shutdown work needed"
```

If nothing changed, skip the commit.

---

## Task 10: Wire CLI `main()` to capture and call `KernelHandle.shutdown()`

The CLI runs one chat turn and exits. Today it builds the bus, calls `bootstrap()`, runs the chat, and `process.exit()`s. The sqlite WAL flush + DB close that storage-sqlite's new `shutdown()` performs needs to happen between "chat completes" and "process exits."

**Files:**
- Modify: `packages/cli/src/main.ts:115-245`

**Step 1: Capture the handle**

Change line 225 from:

```ts
  await bootstrap({ bus, plugins, config: {} });
```

to:

```ts
  const handle = await bootstrap({ bus, plugins, config: {} });
```

**Step 2: Call `handle.shutdown()` after the chat completes**

The current main body returns `0` on the success path (line 242) and `1` on chat failure (line 244). Wrap the chat call in try/finally so shutdown runs in both cases:

```ts
  try {
    const outcome: ChatOutcome = await bus.call('chat:run', ctx, {
      message: { role: 'user', content: opts.message },
    });

    if (outcome.kind === 'complete') {
      const last = outcome.messages[outcome.messages.length - 1];
      out(last?.content ?? '');
      return 0;
    }
    err(`chat terminated: ${outcome.reason}`);
    return 1;
  } finally {
    await handle.shutdown();
  }
```

**Step 3: Add SIGINT/SIGTERM handler in the binary entrypoint**

The `if (process.argv[1] && import.meta.url === pathToFileURL(...))` block at lines 247-300 is where `main()` is invoked from the binary. Add signal handling there for the chat path so a Ctrl-C mid-chat triggers a clean shutdown.

The chat-path branch is currently:

```ts
  } else {
    const message = argv.join(' ') || 'hi';
    main({ message, sqlitePath })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  }
```

The CLI doesn't have an obvious place to install signal handlers because `main()` returns a final exit code. But: the chat is already async, and a SIGINT-during-chat today just exits the process abruptly (orphaning the runner subprocess + leaking the sqlite WAL).

For this slice, the **minimum** is the try/finally above (Step 2) — that handles the normal "chat completes" path. SIGINT-during-chat handling is a deeper question (cancelling the in-flight chat) and is **out of scope for this slice**. Document that limitation in the binary entrypoint:

```ts
  } else {
    const message = argv.join(' ') || 'hi';
    // Note: SIGINT/SIGTERM during chat:run is NOT gracefully handled here.
    // The CLI is one-shot — for a clean shutdown we'd need to thread cancel
    // signals into the chat:run hook, which is its own slice. The try/finally
    // around chat:run inside main() handles the normal completion path.
    main({ message, sqlitePath })
      .then((code) => process.exit(code))
      .catch((e) => {
        process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
      });
  }
```

**Step 4: Repeat the try/finally pattern in `credentials.ts` and `mcp.ts`**

Both `packages/cli/src/commands/credentials.ts:59` and `packages/cli/src/commands/mcp.ts:67` call `bootstrap()`. Apply the same change: capture the handle, wrap their work in try/finally, call `handle.shutdown()` in the `finally`.

**Step 5: Run CLI tests**

```bash
pnpm test --filter @ax/cli
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/commands/credentials.ts packages/cli/src/commands/mcp.ts
git commit -m "feat(cli): call KernelHandle.shutdown after chat/credentials/mcp commands complete"
```

---

## Task 11: Wire `serve` command to use `KernelHandle.shutdown()` from its signal handlers

The `serve` command at `packages/cli/src/commands/serve.ts` already installs SIGINT/SIGTERM handlers (lines 154-176), but they only close the HTTP listener — they don't call kernel shutdown.

**Files:**
- Modify: `packages/cli/src/commands/serve.ts:121-246`

**Step 1: Capture the handle from `bootstrap()`**

Change line 195 from:

```ts
  await bootstrap({ bus, plugins, config: {} });
```

to:

```ts
  const handle = await bootstrap({ bus, plugins, config: {} });
```

**Step 2: Refactor the signal handler to call `handle.shutdown()`**

The current `shutdown` function (lines 158-173) closes the HTTP listener and exits. Update it to also drain plugins via the kernel handle. Order matters: close the HTTP listener first (stop accepting new requests), then call `handle.shutdown()` (drain plugins), then `process.exit()`.

```ts
  let closeListener: (() => Promise<void>) | null = null;
  const isTest = opts.onListening !== undefined;
  if (!isTest) {
    let shuttingDown = false;
    const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) {
        // Second signal mid-shutdown: force-exit with the conventional
        // SIGINT=130 / SIGTERM=143 codes. A misbehaving plugin shouldn't
        // hold the process hostage past the operator's second Ctrl-C.
        process.exit(sig === 'SIGINT' ? 130 : 143);
      }
      shuttingDown = true;
      err(`[ax/serve] ${sig} — closing listener`);
      try {
        if (closeListener !== null) await closeListener();
        await handle.shutdown();
        process.exit(0);
      } catch (e) {
        err(`[ax/serve] shutdown error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
```

Note: the signal handlers must be installed *before* `await bootstrap(...)` (matches the existing rationale in lines 146-153 about SIGTERM-during-boot). But `handle` doesn't exist yet at that point. The fix is to capture `handle` into a closure variable that the signal handler reads at signal-time, not handler-installation-time:

```ts
  let closeListener: (() => Promise<void>) | null = null;
  let handle: KernelHandle | null = null;
  const isTest = opts.onListening !== undefined;
  if (!isTest) {
    let shuttingDown = false;
    const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) {
        process.exit(sig === 'SIGINT' ? 130 : 143);
      }
      shuttingDown = true;
      err(`[ax/serve] ${sig} — closing listener`);
      try {
        if (closeListener !== null) await closeListener();
        if (handle !== null) await handle.shutdown();
        process.exit(0);
      } catch (e) {
        err(`[ax/serve] shutdown error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
```

Then later:

```ts
  const bus = new HookBus();
  handle = await bootstrap({ bus, plugins, config: {} });
```

You'll need to import `KernelHandle` from `@ax/core` at the top of the file.

**Step 3: Run serve tests**

```bash
pnpm test --filter @ax/cli -- serve
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/cli/src/commands/serve.ts
git commit -m "feat(cli/serve): SIGINT/SIGTERM call KernelHandle.shutdown; second signal force-exits 130/143"
```

---

## Task 12: Final sweep — verify all TODOs / interfaces are gone, run the full suite

**Files:** none (verification only).

**Step 1: Grep for the TODO marker across `packages/`**

```bash
grep -rn "TODO(kernel-shutdown)" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/
```

Expected: zero matches.

**Step 2: Grep for the deleted escape-hatch interfaces**

```bash
grep -rn "EventbusPostgresPlugin\|SessionPostgresPlugin\|IpcHttpPlugin\b" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/
```

Expected: zero matches in `src/`. (Matches in `dist/` are stale build output and will be cleared on next build.)

**Step 3: Grep for the obsolete "kernel gains a shutdown lifecycle" wording**

```bash
grep -rn "kernel.*shutdown lifecycle\|kernel-shutdown\b" packages/ 2>/dev/null | grep -v dist/ | grep -v node_modules/ | grep -v "feat/kernel-shutdown"
```

Expected: zero meaningful matches. (The `Plugin.shutdown` doc-comment now refers to "the kernel calls this" affirmatively, not in the future.)

**Step 4: Build + test the whole monorepo**

```bash
pnpm build
pnpm test
```

Expected: BUILD passes, all tests PASS.

**Step 5: Manual smoke test (optional but recommended)**

If a postgres testcontainer is available locally:

```bash
# Spin up a local postgres
docker run --rm -d --name ax-shutdown-smoke -e POSTGRES_PASSWORD=p -p 15432:5432 postgres:16-alpine

# Boot serve against it (replace placeholders with real values)
DATABASE_URL=postgres://postgres:p@localhost:15432/postgres \
  AX_K8S_HOST_IPC_URL=http://localhost:7777 \
  AX_WORKSPACE_BACKEND=local \
  AX_WORKSPACE_ROOT=/tmp/ax-smoke \
  ANTHROPIC_API_KEY=dummy \
  AX_CREDENTIALS_KEY=$(openssl rand -hex 32) \
  node packages/cli/dist/index.js serve --port 8081 &
SERVE_PID=$!

# Verify it boots cleanly
sleep 2
curl -fsS http://localhost:8081/health

# Send SIGTERM and verify it exits 0 within ~10s
kill -TERM $SERVE_PID
wait $SERVE_PID
echo "exit code: $?"

# Confirm postgres has no lingering connections from us
docker exec ax-shutdown-smoke psql -U postgres -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='node';"
# Expected: 0

# Cleanup
docker stop ax-shutdown-smoke
```

**Step 6: Final commit (only if anything was missed in earlier verification)**

If grep turns up a missed spot (a stale comment, an unused import), fix it as a cleanup commit:

```bash
git add -A
git commit -m "chore(kernel-shutdown): post-sweep cleanup"
```

---

## Acceptance criteria recap (PR description checklist)

- [ ] **I1** — bootstrap test "shutdown calls plugins in reverse topological order" PASSES.
- [ ] **I2** — bootstrap tests "throwing/hanging shutdown does not block peers" PASS.
- [ ] **I3** — bootstrap test "handle.shutdown is idempotent" PASSES.
- [ ] **I4** — bootstrap tests "init failure runs reverse-order rollback" + "rollback isolates failures" PASS.
- [ ] **I5** — `bootstrap()` does not call `process.on(...)`. `KernelHandle` exposes `shutdown()`; hosts wire signals.
- [ ] **I6** — shutdown loop is sequential (`for ... await`).
- [ ] **I7** — every new `shutdown()` impl is resource-release-only. PR reviewer confirms by spot-check.
- [ ] **I8** — no security-checklist needed; no new IPC actions or wire schemas.
- [ ] **I9** — `grep -rn "TODO(kernel-shutdown)" packages/` returns zero matches in `src/`.
- [ ] **I10** — `grep -rn "EventbusPostgresPlugin\|SessionPostgresPlugin\|IpcHttpPlugin\b" packages/` returns zero matches in `src/`.
- [ ] `pnpm test` green across the monorepo.
- [ ] (Manual, optional) serve binary handles SIGTERM cleanly with no lingering postgres connections.

---

## Dependencies / parallelism notes

- Tasks 1, 2 are sequential prerequisites for everything else.
- Tasks 3, 4, 5, 6, 7, 8, 9 are independent of each other — dispatch in parallel via `superpowers:subagent-driven-development` if running in-session.
- Tasks 10, 11 depend on Task 2 (need `KernelHandle` exported) and benefit from Tasks 3–8 being in (so the smoke tests actually exercise real shutdowns), but can land any time after Task 2.
- Task 12 is final.

## Out of scope (do not expand this PR)

- Cancellation of in-flight chats during CLI SIGINT (mentioned as a CLI limitation in Task 10 — defer to its own slice).
- A `Plugin.drain?()` phase for "finish in-flight work before closing resources." Reserved for a future slice if real demand appears.
- Multi-replica or graceful rolling-deploy logic beyond "exit 0 within timeout."
- `@ax/agent-runner-core` / `@ax/ipc-server` (sandbox-side, not kernel-orchestrated). Left for a future slice if those packages grow host-side resources.
