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

  detectCycles(plugins);

  for (const p of plugins) {
    try {
      await p.init({ bus, config: (config as Record<string, unknown>)[p.manifest.name] });
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

function detectCycles(plugins: Plugin[]): void {
  const producers = new Map<string, string>();
  for (const p of plugins) {
    for (const r of p.manifest.registers) {
      const existing = producers.get(r);
      if (existing !== undefined && existing !== p.manifest.name) {
        throw new PluginError({
          code: 'duplicate-service',
          plugin: p.manifest.name,
          message: `service hook '${r}' registered by both '${existing}' and '${p.manifest.name}'`,
        });
      }
      producers.set(r, p.manifest.name);
    }
  }

  const graph = new Map<string, string[]>();
  for (const p of plugins) {
    const out: string[] = [];
    for (const c of p.manifest.calls) {
      const prod = producers.get(c);
      if (prod !== undefined && prod !== p.manifest.name) out.push(prod);
    }
    graph.set(p.manifest.name, out);
  }

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

function verifyCalls(plugins: Plugin[], bus: HookBus): void {
  for (const p of plugins) {
    for (const hook of p.manifest.calls) {
      if (!bus.hasService(hook)) {
        throw new PluginError({
          code: 'missing-service',
          plugin: p.manifest.name,
          message: `plugin '${p.manifest.name}' declares calls:['${hook}'] but no plugin registers it`,
        });
      }
    }
  }
}
