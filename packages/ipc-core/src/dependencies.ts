import type { OptionalCall } from '@ax/core';

// ---------------------------------------------------------------------------
// DISPATCHER_DEPENDENCIES — the service hooks the @ax/ipc-core dispatcher
// transitively invokes through its handlers.
//
// This is the SINGLE SOURCE OF TRUTH for the dispatcher's dependency surface.
// Both transports that wrap the dispatcher (@ax/ipc-http over TCP,
// @ax/ipc-server over a unix socket) spread it into their plugin manifest:
//
//     calls: [...DISPATCHER_DEPENDENCIES.requiredCalls],
//     optionalCalls: [...DISPATCHER_DEPENDENCIES.optionalCalls],
//
// rather than each hand-maintaining its own list (which is how they drifted:
// they declared only the obvious session/tool calls and silently omitted the
// workspace, conversation, and session-config services the handlers reach).
//
// `dependency-sync.test.ts` keeps this honest against the handler source — a
// new handler that grows a `bus.call(...)` the metadata doesn't cover fails
// that test, so this const can't silently fall behind the dispatcher again.
//
// ---- required vs. optional vs. dynamic ----
//
// `verifyCalls` (in @ax/core bootstrap) FAILS the boot if a hook in `calls`
// (required) has no registered producer; `optionalCalls` NEVER fail the boot
// (the consumer is expected to probe `bus.hasService(hook)` and degrade). So
// the split is governed by two questions:
//
//   - Does the dispatcher reach the hook unconditionally (no `hasService`
//     guard, no conditional branch)? If yes → required.
//   - Is the producer guaranteed present wherever a transport loads? Required
//     hooks must be — every required producer below ships in the k8s preset
//     (session-postgres, mcp-client, conversations, the workspace backend).
//
// Anything guarded or branch-conditional is optional, with a `degradation`
// note describing what the dispatcher gives up when the producer is absent.
//
// `tool:execute:<name>` host-tool routes are resolved DYNAMICALLY via
// `bus.hasService()` at dispatch time and can't be enumerated at manifest
// time, so they live in `dynamicCallPatterns` (prefix strings) and are
// deliberately NOT added to `calls` — `verifyCalls` only enforces named hooks.
// This mirrors the per-tool exception the tool-dispatcher plugin documents.
// ---------------------------------------------------------------------------

export interface DispatcherDependencies {
  /**
   * Service hooks the dispatcher invokes unconditionally on some request path
   * (no `hasService` guard, no conditional branch). A transport stamps these
   * into `manifest.calls`; an absent producer fails the boot via `verifyCalls`.
   */
  readonly requiredCalls: readonly string[];
  /**
   * Service hooks the dispatcher calls only behind a `hasService` guard or a
   * conditional branch, and degrades without. A transport stamps these into
   * `manifest.optionalCalls`; an absent producer does NOT fail the boot.
   */
  readonly optionalCalls: readonly OptionalCall[];
  /**
   * Hook-name PREFIXES for service hooks resolved dynamically at dispatch time
   * (the full hook name isn't known until a request names the tool). Matched
   * with `startsWith`. Not stamped into any manifest field — `verifyCalls`
   * only enforces named hooks.
   */
  readonly dynamicCallPatterns: readonly string[];
}

export const DISPATCHER_DEPENDENCIES: DispatcherDependencies = {
  requiredCalls: [
    // auth.ts — every authenticated request resolves its bearer token.
    'session:resolve-token',
    // session.next-message — claims the next queued work item for the session.
    'session:claim-work',
    // tool.list — returns the host-side tool catalog for the runner.
    'tool:list',
    // session.get-config — returns the runner's agent config for boot.
    'session:get-config',
    // workspace.read — reads a single workspace path (no guard, no fallback).
    'workspace:read',
    // conversation.store-runner-session — persists the SDK session id.
    'conversations:store-runner-session',
  ],
  optionalCalls: [
    {
      hook: 'conversations:get-metadata',
      degradation:
        'session.get-config skips the runnerSessionId round-trip for conversation-scoped sessions; runnerSessionId is returned as null (the runner starts a fresh SDK session).',
    },
    {
      hook: 'workspace:export-baseline-bundle',
      degradation:
        'workspace.materialize / workspace.commit-notify treat the backend as non-bundle: materialize reconstructs the baseline from workspace:list + workspace:read, and commit-notify rejects bundle-wire writes (read-only / probe path).',
    },
    {
      hook: 'workspace:apply-bundle',
      degradation:
        'workspace.commit-notify cannot apply a runner bundle-wire write to the storage tier; only reached on the bundle path when export-baseline-bundle is present.',
    },
    {
      hook: 'workspace:list',
      degradation:
        'workspace.materialize cannot reconstruct a baseline bundle on a non-bundle backend (the list+read fallback); only reached when workspace:export-baseline-bundle is absent.',
    },
  ],
  dynamicCallPatterns: [
    // tool.execute-host — `tool:execute:${call.name}`, probed via
    // bus.hasService() at dispatch time (404 when no host tool matches).
    'tool:execute:',
  ],
};
