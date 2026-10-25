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
   * Optional. Begin admitting outside work, such as a public listener. The
   * kernel calls it once, in init order, after every plugin's `init()` has
   * resolved and every declared call is wired. It is awaited: `bootstrap()`
   * resolves only after every `startAdmission()` has. A throw fails the boot,
   * and the kernel then shuts down every initialized plugin, this one included.
   */
  startAdmission?(): Promise<void> | void;
  /**
   * Optional. Stop admitting outside work. The kernel calls it once, in
   * reverse init order, when `KernelHandle.shutdown()` begins, before any
   * plugin's `shutdown()`, and on a failed boot for plugins admitted before a
   * later `startAdmission()` threw. It runs under the per-plugin shutdown
   * timeout, and a throw or timeout is reported, never fatal. It must not
   * wait for work already admitted; `shutdown()` does that. It closes the door
   * to new outside work and must never cut a channel that admitted work still
   * needs.
   *
   * `startAdmission` runs in init order and `stopAdmission` in reverse, so a
   * plugin opens after, and closes before, the plugins it calls. A plugin whose handlers another plugin
   * admits work into (a route registered with `@ax/http-server`) is opened
   * after and closed before it, so those handlers must work from the end of
   * their own `init()` until their `shutdown()`.
   */
  stopAdmission?(): Promise<void> | void;
  /** Default bounded shutdown continues after its deadline. Joined shutdown reports
   * the deadline but waits for actual settlement before tearing down dependencies.
   * It must stop admission and join only work already owned by this plugin.
   */
  shutdownMode?: 'bounded' | 'joined';
  /**
   * Optional cleanup hook. The kernel calls this in reverse load order
   * (the reverse of `init()`'s topological order) when `KernelHandle.
   * shutdown()` is invoked, after every plugin's `stopAdmission()` has run,
   * and on a failed boot for plugins that already initialized. It can run
   * without a `stopAdmission()` first (a failed boot's rollback, a test
   * harness), so it must stop admission on its own too. Each plugin's
   * `shutdown()` runs under a configurable per-plugin timeout (default
   * 10 s); failures and timeouts are logged. Bounded mode proceeds after
   * the deadline; joined mode waits for settlement before closing
   * dependencies.
   *
   * Plugins without long-lived resources (file handles, connection
   * pools, HTTP listeners, timers) don't need to implement this.
   *
   * Contract:
   * - **Idempotent.** May be called twice in pathological races; the
   *   second call must be a no-op or a safe re-close. The kernel's
   *   handle is itself idempotent (see `KernelHandle.shutdown`), so
   *   this matters mainly for plugins called directly by tests.
   * - **Stop admission first.** Joined mode may settle previously accepted work,
   *   including its terminal writes, before releasing resources. It starts no new work.
   *   Bounded mode remains resource-release only.
   * - **No implied cancellation.** Joined mode has no hard duration ceiling:
   *   a noncancellable provider may delay shutdown beyond the reported deadline.
   */
  shutdown?(): Promise<void> | void;
}
