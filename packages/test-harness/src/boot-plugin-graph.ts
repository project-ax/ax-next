import { HookBus, bootstrap, type Plugin } from '@ax/core';

/**
 * Boots a preset's REAL plugin manifests through the REAL kernel `bootstrap()`
 * — but with every `init()` replaced by a stub that just registers the
 * plugin's declared `registers` hooks as no-ops.
 *
 * Why: the kernel's boot-time graph checks (duplicate producers, call cycles,
 * missing required services) depend only on manifests, yet the only lanes that
 * boot a full production preset need Postgres + Docker and drop or swap
 * plugins. A call cycle that only forms in the deployed configuration (e.g. the
 * memory preset WITH its export volume, which is what adds
 * `sandbox:memory-mounts`) crash-looped the host on boot with CI green
 * (TASK-759). This runs in milliseconds, needs no Docker, and throws the same
 * `PluginError` the host would.
 *
 * It deliberately does NOT run any real `init()`: what it proves is that the
 * kernel accepts the assembly's dependency graph, nothing more.
 */
export async function bootPluginGraph(plugins: readonly Plugin[]): Promise<void> {
  const stubs: Plugin[] = plugins.map((p) => ({
    manifest: p.manifest,
    init({ bus }) {
      for (const hook of p.manifest.registers) {
        bus.registerService(hook, p.manifest.name, async () => undefined);
      }
    },
  }));
  const handle = await bootstrap({ bus: new HookBus(), plugins: stubs, config: {} });
  await handle.shutdown();
}
