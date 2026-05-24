import { PluginError } from './errors.js';
import type { HookBus } from './hook-bus.js';
import { filterToPolicy } from './workspace-policy.js';
import { WorkspaceApplyOutputSchema } from './workspace.js';
import type {
  FileChange,
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceDelta,
  WorkspaceVersion,
} from './workspace.js';

// ---------------------------------------------------------------------------
// `workspace:apply` policy-hook facade (Finding 3)
//
// Problem this closes: `workspace:apply` used to be a raw backend service
// hook. The policy chokepoint — `workspace:pre-apply` (veto) and
// `workspace:applied` (notify) — fired only inside the host's IPC commit
// path (`@ax/ipc-core`'s `workspace-commit-notify.ts`). Any in-process
// `bus.call('workspace:apply', …)` (e.g. `@ax/conversations` drop-turn,
// `@ax/attachments` commit) landed changes WITHOUT firing either hook, so
// the chokepoint was bypassable.
//
// The fix is a backend-agnostic facade. Every workspace backend renames its
// raw implementation to the INTERNAL service hook `workspace:apply-internal`
// and calls `registerWorkspaceApplyFacade(bus, PLUGIN_NAME)`, which registers
// the PUBLIC `workspace:apply` service. Callers don't change — they keep
// calling `workspace:apply`, which now always:
//
//   1. fires `workspace:pre-apply` with `filterToPolicy(input.changes)`
//      (subscribers see only the policy-visible `.ax/**` + `.claude/**`
//      subset). A veto throws `PluginError{ code: 'rejected' }`.
//   2. calls `workspace:apply-internal` with the FULL change set (pre-apply
//      is veto-only — transformed payloads are ignored, exactly like the
//      commit-notify path).
//   3. fires `workspace:applied` with the backend's returned delta. This is
//      observe-only: a post-fact rejection is LOGGED, never thrown (the apply
//      already landed; throwing here would lie to the caller).
//
// `ctx` is passed straight through to all three steps. The facade never
// constructs or rewrites it — `workspace:apply` routes by the caller's
// userId/agentId, so transparency is correct.
//
// Lives in `@ax/core` (not a workspace backend) so a future GCS backend
// reuses the identical pre/post-fire logic — one source of truth for the
// policy wrapping (Invariant 4).
// ---------------------------------------------------------------------------

/** Veto-only payload for `workspace:pre-apply`. Mirrors commit-notify. */
interface WorkspacePreApplyPayload {
  changes: FileChange[];
  parent: WorkspaceVersion | null;
  reason?: string;
}

/**
 * Registers the public `workspace:apply` service hook as a facade over the
 * backend's `workspace:apply-internal` hook. Call this from a backend
 * plugin's `init()` alongside `registerService('workspace:apply-internal', …)`.
 *
 * @param bus    the kernel hook bus
 * @param plugin the registering backend's name (used as the facade's plugin
 *               identity and on the `rejected` PluginError)
 */
export function registerWorkspaceApplyFacade(
  bus: HookBus,
  plugin: string,
): void {
  bus.registerService<WorkspaceApplyInput, WorkspaceApplyOutput>(
    'workspace:apply',
    plugin,
    async (ctx, input) => {
      // 1. pre-apply (veto-only). Subscribers see only policy-visible paths;
      //    a transformed payload is ignored — we apply the FULL set below.
      const preApplyPayload: WorkspacePreApplyPayload = {
        changes: filterToPolicy(input.changes),
        parent: input.parent,
      };
      if (input.reason !== undefined) preApplyPayload.reason = input.reason;

      const pre = await bus.fire<WorkspacePreApplyPayload>(
        'workspace:pre-apply',
        ctx,
        preApplyPayload,
      );
      if (pre.rejected) {
        throw new PluginError({
          code: 'rejected',
          plugin,
          hookName: 'workspace:apply',
          message: pre.reason,
        });
      }

      // 2. apply via the backend's internal hook with the FULL change set.
      //    Errors (e.g. parent-mismatch) propagate UNCHANGED so callers like
      //    @ax/attachments can key off `code: 'parent-mismatch'` + the
      //    error's `cause.actualParent` and retry.
      const applied = await bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply-internal',
        ctx,
        input,
      );

      // ARCH-12: validate the write-path output HERE, before the observe-only
      // `workspace:applied` notify — not via the service-hook `returns` option.
      // The `returns` option is enforced by HookBus only AFTER this handler
      // returns, but the handler fires `workspace:applied` with `applied.delta`
      // first; a malformed backend delta would otherwise reach observers (e.g.
      // @ax/routines sync) before `invalid-return` is raised. Validating up
      // front makes the facade the unbypassable chokepoint for both the
      // subscriber boundary AND the caller. The schema `.passthrough()`es the
      // delta's change objects, so the lazy `contentBefore`/`contentAfter` fns
      // survive; we fire/return the ORIGINAL `applied` (not the reparsed
      // value) so subscribers and callers keep the backend's exact object
      // references — the validation is a gate, not a transform.
      const check = WorkspaceApplyOutputSchema.safeParse(applied);
      if (!check.success) {
        throw new PluginError({
          code: 'invalid-return',
          plugin,
          hookName: 'workspace:apply',
          message: `workspace:apply returned an invalid shape: ${check.error.message}`,
        });
      }

      // 3. applied (observe-only). A post-fact rejection means a subscriber
      //    tried to veto something already landed — log it, never throw.
      const post = await bus.fire<WorkspaceDelta>(
        'workspace:applied',
        ctx,
        applied.delta,
      );
      if (post.rejected) {
        ctx.logger.error('workspace_applied_rejected_post_fact', {
          hook: 'workspace:applied',
          // The apply already landed; the rejection is ignored. Logged so an
          // operator can spot a misconfigured observe-only subscriber.
          reason: post.reason,
          source: post.source,
        });
      }

      return applied;
    },
  );
}
