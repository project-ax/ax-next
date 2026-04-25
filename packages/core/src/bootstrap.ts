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

  // verifyCalls runs AFTER every plugin has initialized, so a missing-service
  // failure here would otherwise leak the same resources the in-loop rollback
  // protects (pg pools, LISTEN clients, HTTP listeners). Roll back through
  // the kernel's own shutdown path so the symmetry holds.
  try {
    verifyCalls(plugins, bus);
  } catch (err) {
    await runShutdownLoop(initialized, shutdownTimeoutMs, onShutdownError);
    throw err;
  }

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
      // Guard the sink itself: a structured logger that asserts on schema, a
      // metric library that throws on bad labels, or any other host-supplied
      // sink that misbehaves must NOT abort the loop. Per-plugin failures
      // never block peer plugins (I2) — that includes failures inside the
      // failure-reporting path.
      try {
        onError(p.manifest.name, err);
      } catch {
        // Sink itself failed; swallow so peer plugins still shut down.
      }
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

// Runs the three graph-level validations a plugin set must pass before init:
//   1. no two plugins register the same service hook (duplicate-producer),
//   2. every declared `calls` entry that a peer produces is wired into the graph,
//   3. the resulting inter-plugin call graph is acyclic.
// Returns the graph so `topologicalOrder` can consume it without rebuilding.
// Missing-service checks happen AFTER init (see `verifyCalls`) because a plugin
// may register at init-time; they are not part of the manifest-only graph.
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

// Returns plugins in init order: a plugin's declared producers (the plugins
// that register hooks it `calls`) come before it. Assumes validateDependencyGraph
// has already passed, so a DFS post-order is a valid topological order. Original
// array order is preserved among plugins that don't depend on each other.
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
