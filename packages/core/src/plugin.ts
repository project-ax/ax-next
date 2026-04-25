import { z } from 'zod';
import type { HookBus } from './hook-bus.js';

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  registers: z.array(z.string()).default([]),
  calls: z.array(z.string()).default([]),
  subscribes: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PluginInitContext {
  bus: HookBus;
  config: unknown;
}

export interface Plugin {
  manifest: PluginManifest;
  init(ctx: PluginInitContext): Promise<void> | void;
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
  shutdown?(): Promise<void> | void;
}
