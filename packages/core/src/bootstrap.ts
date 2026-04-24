import type { HookBus } from './hook-bus.js';
import { PluginError } from './errors.js';
import { PluginManifestSchema, type Plugin } from './plugin.js';

export interface BootstrapOptions {
  bus: HookBus;
  plugins: Plugin[];
  config: Record<string, unknown>;
}

export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  const { bus, plugins, config } = opts;

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

  for (const p of order) {
    try {
      await p.init({ bus, config: config[p.manifest.name] });
    } catch (err) {
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
