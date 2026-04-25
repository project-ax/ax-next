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
   * Optional cleanup hook. The kernel does NOT call this yet — the
   * production SIGTERM-driven shutdown lifecycle is a separate slice
   * (followups doc #3). For now `shutdown` is consumed by
   * `@ax/test-harness`'s `close()` so test suites can drain plugin
   * resources between cases (postgres pools, HTTP listeners, timers).
   *
   * Plugins that hold no long-lived resources don't need to implement
   * this. When they do, they should be idempotent (close() may be
   * called from a SIGTERM handler that races a kernel-initiated
   * shutdown) and bounded in time (the test harness applies a per-
   * plugin timeout to keep one misbehaving plugin from hanging the
   * whole teardown).
   */
  shutdown?(): Promise<void> | void;
}
