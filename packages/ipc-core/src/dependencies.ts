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
// they declared only the obvious session/tool calls and silently omitted
// other services the handlers reach).
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
//     hooks must be — every required producer below ships wherever a
//     transport loads (the k8s preset and the CLI: a session backend for the
//     `session:*` hooks, mcp-client's tool dispatcher for `tool:list`).
//     TASK-995 dropped `workspace:read` from this list along with the git
//     workspace tier.
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
      // TASK-68 (out-of-git Part C): the runner-side blob store callers. Reached
      // unconditionally on the /blob.put and /blob.get routes, but those routes
      // only fire in a deployment that loaded a blob backend (the k8s preset
      // registers @ax/blob-store-fs). The single-session CLI never publishes an
      // artifact or copies uploads from the store, so making these required
      // would fail the CLI's bootstrap verifyCalls.
      hook: 'blob:put',
      degradation:
        'POST /blob.put returns 500 — the runner cannot store an artifact/upload blob; unreachable in deployments with no blob backend.',
    },
    {
      hook: 'blob:get',
      degradation:
        'POST /blob.get returns 500 — the runner cannot copy uploads into the scratch uploads directory or stream a stored blob; unreachable in deployments with no blob backend.',
    },
    {
      hook: 'artifacts:publish-blob',
      degradation:
        'POST /artifact.publish returns 500 — a published artifact is not recorded in the metadata store; unreachable in deployments that never publish artifacts.',
    },
    {
      hook: 'attachments:list-for-conversation',
      degradation:
        'POST /attachments.list returns 500 — the runner cannot enumerate a conversation\'s uploads to copy into the scratch uploads directory; unreachable in single-session deployments.',
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
    {
      // Cross-runner history reconstruction. Same conversation-scoped-only
      // reasoning as the transcript hooks above.
      hook: 'conversations:get',
      degradation:
        'POST /session.get-display-history returns 500 — a runner handed another runner\'s transcript cannot rebuild the conversational thread and starts blank instead (the behaviour that predates the action). Unreachable in single-session deployments that never load @ax/conversations.',
    },
  ],
  dynamicCallPatterns: [
    // tool.execute-host — `tool:execute:${call.name}`, probed via
    // bus.hasService() at dispatch time (404 when no host tool matches).
    'tool:execute:',
  ],
};
