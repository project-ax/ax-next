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
    // Present in both transport consumers (CLI loads @ax/workspace-git; the
    // k8s preset loads a workspace backend) — every IPC deployment has a
    // workspace, so required is safe here.
    'workspace:read',
  ],
  optionalCalls: [
    {
      // NOT required: the dispatcher calls this unconditionally on the
      // /conversation.store-runner-session route, but the route is only
      // exercised by conversation-scoped deployments. The local CLI is
      // single-session, never loads @ax/conversations, and never calls this
      // route — making it required would fail the CLI's bootstrap verifyCalls.
      hook: 'conversations:store-runner-session',
      degradation:
        'POST /conversation.store-runner-session returns 500 (the runner SDK session id is not persisted); the route is unreachable in single-session deployments that never call it.',
    },
    {
      hook: 'conversations:get-metadata',
      degradation:
        'session.get-config skips the runnerSessionId round-trip for conversation-scoped sessions; runnerSessionId is returned as null (the runner starts a fresh SDK session).',
    },
    {
      // TASK-66 (out-of-git Part B / B1): event.turn-end persists the turn's
      // display frame into the display event log (the redisplay SoT) before
      // acking the runner (persist-before-ack). Guarded by
      // bus.hasService(...) — single-session deployments (the local CLI) that
      // never load @ax/conversations skip the persist and redisplay falls back
      // to the runner-native jsonl.
      hook: 'conversations:append-event',
      degradation:
        'event.turn-end skips persisting the turn into the display event log; redisplay falls back to parsing the runner-native jsonl (no host-only UI events on reload). Unreachable in single-session deployments that never load @ax/conversations.',
    },
    {
      hook: 'workspace:export-baseline-bundle',
      degradation:
        'workspace.materialize / workspace.commit-notify treat the backend as non-bundle: materialize reconstructs the baseline from workspace:list + workspace:read, and commit-notify rejects bundle-wire writes (read-only / probe path). workspace.export-baseline-bundle (the commit-notify re-sync fetch) returns 500 — unreachable when the backend never enters the bundle re-sync path.',
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
    {
      // TASK-68 (out-of-git Part C): the runner-side blob store callers. Reached
      // unconditionally on the /blob.put and /blob.get routes, but those routes
      // only fire in a deployment that loaded a blob backend (the k8s preset
      // registers @ax/blob-store-fs). The single-session CLI never publishes an
      // artifact or materializes uploads from the store, so making these
      // required would fail the CLI's bootstrap verifyCalls.
      hook: 'blob:put',
      degradation:
        'POST /blob.put returns 500 — the runner cannot store an artifact/upload blob; unreachable in deployments with no blob backend.',
    },
    {
      hook: 'blob:get',
      degradation:
        'POST /blob.get returns 500 — the runner cannot materialize /ephemeral/uploads or stream a stored blob; unreachable in deployments with no blob backend.',
    },
    {
      hook: 'artifacts:publish-blob',
      degradation:
        'POST /artifact.publish returns 500 — a published artifact is not recorded in the metadata store; unreachable in deployments that never publish artifacts.',
    },
    {
      hook: 'attachments:list-for-conversation',
      degradation:
        'POST /attachments.list returns 500 — the runner cannot enumerate a conversation\'s uploads to materialize /ephemeral/uploads; unreachable in single-session deployments.',
    },
    {
      // TASK-74 (out-of-git Part D): the skill authoring chokepoint. Reached on
      // the /skill.propose route, but only in a deployment that loaded @ax/skills
      // (which registers skills:propose). The single-session CLI has no skills
      // store and never reaches it, so making it required would fail the CLI's
      // bootstrap verifyCalls.
      hook: 'skills:propose',
      degradation:
        'POST /skill.propose returns 500 — the runner cannot propose an authored skill; unreachable in deployments without a skills store.',
    },
    {
      // Agent-visible egress-block note. Reached on /proxy.drain-egress-blocks,
      // but only when @ax/credential-proxy is loaded (the k8s preset). The
      // single-session CLI has no egress proxy / allowlist gate, so the handler
      // short-circuits to `{ hosts: [] }` via hasService rather than calling
      // this hook — making it required would fail the CLI's bootstrap
      // verifyCalls.
      hook: 'proxy:drain-session-egress-blocks',
      degradation:
        'POST /proxy.drain-egress-blocks returns { hosts: [] } without calling the hook — no egress proxy means no allowlist blocks to surface; the agent simply gets no egress-block note.',
    },
    {
      // TASK-67 (out-of-git Part B / B2): the runner-side resume-transcript
      // callers. Reached on the /session.append-transcript /
      // .replace-transcript / .get-transcript routes, but only in a
      // conversation-scoped deployment that loaded @ax/conversations (which
      // registers these). The single-session CLI is never conversation-scoped
      // and never reaches them, so making them required would fail the CLI's
      // bootstrap verifyCalls.
      hook: 'conversations:append-transcript',
      degradation:
        'POST /session.append-transcript returns 500 — the runner cannot ship the per-turn resume delta; unreachable in single-session deployments that never load @ax/conversations.',
    },
    {
      hook: 'conversations:replace-transcript',
      degradation:
        'POST /session.replace-transcript returns 500 — the runner cannot re-ship the whole resume transcript on the resync path; unreachable in single-session deployments.',
    },
    {
      hook: 'conversations:get-transcript',
      degradation:
        'POST /session.get-transcript returns 500 — the runner cannot rebuild the resume jsonl from the store; unreachable in single-session deployments.',
    },
  ],
  dynamicCallPatterns: [
    // tool.execute-host — `tool:execute:${call.name}`, probed via
    // bus.hasService() at dispatch time (404 when no host tool matches).
    'tool:execute:',
  ],
};
