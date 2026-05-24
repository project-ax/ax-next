import { z } from 'zod';
import type { HookBus } from './hook-bus.js';

/**
 * One optional service-hook dependency. Unlike `calls`, an `optionalCalls`
 * entry whose producer is absent does NOT fail the boot — the plugin is
 * expected to detect the gap (`bus.hasService(hook)`) and degrade.
 *
 * `degradation` is a required, human-readable note describing what the
 * plugin gives up when the hook is unavailable (what breaks / what the
 * fallback is). It exists so the gap is documented at the manifest level,
 * not buried in a code comment — and so a future compatibility matrix can
 * surface it.
 */
export const OptionalCallSchema = z.object({
  hook: z.string().min(1),
  degradation: z.string().min(1),
});

export type OptionalCall = z.infer<typeof OptionalCallSchema>;

export const PluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    registers: z.array(z.string()).default([]),
    calls: z.array(z.string()).default([]),
    /**
     * Service hooks this plugin can call but degrades gracefully without.
     * Non-fatal at boot when the producer is absent; still a real call-graph
     * edge (cycle detection + init ordering) when a producer IS present.
     * See `OptionalCallSchema`.
     *
     * Optional at the type level (additive field — existing manifests need no
     * change). Bootstrap treats an absent `optionalCalls` as the empty list.
     */
    optionalCalls: z.array(OptionalCallSchema).optional(),
    subscribes: z.array(z.string()).default([]),
  })
  .superRefine((m, ctx) => {
    // A hook can't be both required and optional — that's a contradiction,
    // and silently picking one would mask an author mistake. Name the
    // offending hook so it's findable.
    const calls = new Set(m.calls);
    (m.optionalCalls ?? []).forEach((oc, i) => {
      if (calls.has(oc.hook)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['optionalCalls', i, 'hook'],
          message: `hook '${oc.hook}' is listed in both calls (required) and optionalCalls (optional); a hook can be one or the other, not both`,
        });
      }
    });
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
