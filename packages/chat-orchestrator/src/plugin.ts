import type { AgentOutcome, Plugin } from '@ax/core';
import {
  createOrchestrator,
  PLUGIN_NAME,
  type ChatOrchestratorConfig,
  type AgentInvokeInput,
  type ApplyCapabilityGrantInput,
  type ApplyCapabilityGrantOutput,
} from './orchestrator.js';

// ---------------------------------------------------------------------------
// @ax/chat-orchestrator plugin
//
// Registers `agent:invoke` — the host-side entrypoint a CLI (or any other host)
// uses to drive a single user→agent turn-sequence. Subscribes to `chat:end`
// so the orchestrator can capture the outcome the runner emits via its
// /event.chat-end IPC POST.
//
// Everything spicy happens inside `createOrchestrator`; this file is just
// the manifest + hook registration.
// ---------------------------------------------------------------------------

export function createChatOrchestratorPlugin(
  config: ChatOrchestratorConfig,
): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['agent:invoke', 'agent:apply-capability-grant'],
      // The orchestrator drives the per-chat lifecycle by calling these
      // peers. `session:create` is NOT listed — sandbox:open-session mints
      // the session itself; a double-create throws duplicate-session. The
      // orchestrator intentionally delegates session minting to the sandbox
      // plugin. `ipc:stop` is NOT listed either: sandbox-subprocess stops
      // its own per-session listener on child-close (no host-side caller
      // needed), and the k8s preset uses @ax/ipc-http which has a
      // process-scoped listener with no per-session start/stop hooks.
      //
      // `agents:resolve` is a HARD dep as of Week 9.5 — every chat goes
      // through the ACL gate before the sandbox is spawned. This forces
      // any preset that wires the orchestrator to also wire @ax/agents,
      // which is the intended coupling.
      calls: [
        'session:queue-work',
        'session:terminate',
        'sandbox:open-session',
        'agents:resolve',
      ],
      // ----- conditionally-called peers (NOT in `calls`) -----
      //
      // Week 10–12 Task 16 (J6) introduces `conversations:get`,
      // `conversations:bind-session`, and `session:is-alive`. The
      // orchestrator dispatches these ONLY when `ctx.conversationId` is
      // set — i.e. on the channel-web path that ALSO loads
      // @ax/conversations + a session backend with the new hook. Plugins
      // outside that path (CLI canary, mcp-client e2e harness) drive the
      // orchestrator without a conversation context, so they don't need
      // the peers loaded.
      //
      // Phase 2B adds `system-prompt:augment` to this same category. The
      // hook is registered by @ax/memory-strata (auto-inject path) and any
      // future personalization / tenant-policy provider. Listing it in
      // `calls` would force every preset wiring the orchestrator to also
      // wire a provider — but the CLI canary, the single-tenant preset,
      // and any deploy that doesn't load memory-strata MUST stay functional
      // without one. The orchestrator gates with `bus.hasService(...)` and
      // no-ops when absent.
      //
      // We gate each call with `bus.hasService(...)` at runtime to keep
      // the orchestrator usable in those non-channel-web presets. Failing
      // closed (no routing, no bind) is the correct degraded behavior —
      // a missing conversations plugin can't keep state about active
      // sessions anyway.
      //
      // Same pattern as the existing `ipc:stop` non-declaration: when a
      // hook is conditionally consumed, we don't declare it.
      // We listen to `chat:end` to capture the outcome emitted by the
      // runner (via the IPC server's /event.chat-end handler). The
      // subscriber is a pass-through: resolves the waiting deferred,
      // returns undefined, doesn't veto and doesn't transform.
      //
      // We also listen to `chat:turn-end` so that in one-shot mode
      // (the default for 6.5a) we queue a `cancel` into the runner's
      // inbox after the first user message completes — the runner is
      // persistent by design, so without this signal it would block
      // forever on inbox.next() and the agent:invoke would time out.
      //
      // We listen to `session:terminate` (Fault A) so a sandbox that dies
      // mid-turn on the routed/warm path — which doesn't watch handle.exited
      // — surfaces a turn-error on the SSE promptly instead of hanging until
      // chatTimeoutMs. (session:terminate is ALSO in `calls` — the
      // orchestrator both requests teardown and observes the broadcast the
      // session store re-fires; the bus keeps the service + subscriber lanes
      // separate.)
      // We listen to `event.http-egress` (TASK-37, reactive egress wall) so an
      // allowlist-MISS 403 the credential proxy fires — now attributed to its
      // session by TASK-52's per-session token — becomes an in-chat host-grant
      // permission card. Observation-only: it resolves the block's session to
      // the in-flight turn and fires `chat:permission-request`; it never vetoes
      // the egress audit (the proxy already returned 403) and never affects the
      // allow/deny decision.
      //
      // We listen to `workspace:applied` (Phase 3 / B3) so a turn that committed
      // a change under the agent's `.ax/draft-skills/` MARKS the committing
      // session dirty; the next turn's routing declines warm-reuse and
      // re-spawns so the skill projection re-derives. Mark-only here (the event
      // fires mid-commit, before chat:turn-end) — the terminate happens at the
      // next turn's routing, safely between turns. In-memory + single-replica,
      // matching @ax/routines' existing workspace:applied posture.
      subscribes: [
        'chat:end',
        'chat:turn-end',
        'session:terminate',
        'event.http-egress',
        'workspace:applied',
      ],
    },
    init({ bus }) {
      const orch = createOrchestrator(bus, config);

      bus.registerService<AgentInvokeInput, AgentOutcome>(
        'agent:invoke',
        PLUGIN_NAME,
        async (ctx, input) => orch.runAgentInvoke(ctx, input),
      );

      // JIT (design §7/§11.5) — apply a user-approved capability grant: attach
      // the catalog skill for the user (TASK-33) + retire the conversation's
      // warm session so the next turn re-spawns and resumes. Host-side only
      // (channel-web → orchestrator); NOT an IPC action (the agent/runner can't
      // reach it). Its `skills:resolve` / `skills:attach-for-user` peers are
      // bus.hasService-gated (present only where @ax/skills is wired — the k8s
      // preset), same convention as the conversations:* peers above, so they
      // stay OUT of `calls`.
      bus.registerService<ApplyCapabilityGrantInput, ApplyCapabilityGrantOutput>(
        'agent:apply-capability-grant',
        PLUGIN_NAME,
        async (ctx, input) => orch.applyCapabilityGrant(ctx, input),
      );

      bus.subscribe<{ outcome: AgentOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await orch.onChatEnd(ctx, payload);
          return undefined; // pass-through; no transform, no veto.
        },
      );

      bus.subscribe<{ reason?: string; reqId?: string }>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          orch.onTurnEnd(ctx, payload);
          return undefined;
        },
      );

      bus.subscribe<{ sessionId?: string }>(
        'session:terminate',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await orch.onSessionTerminate(ctx, payload);
          return undefined; // observation-only; never vetoes teardown.
        },
      );

      bus.subscribe<{
        sessionId: string;
        userId: string;
        host: string;
        blockedReason?: string;
      }>(
        'event.http-egress',
        PLUGIN_NAME,
        async (ctx, payload) => {
          await orch.onHttpEgress(ctx, payload as never);
          return undefined; // observation-only; never vetoes the egress audit.
        },
      );

      bus.subscribe<{
        author?: { sessionId?: string };
        changes: Array<{ path: string }>;
      }>(
        'workspace:applied',
        PLUGIN_NAME,
        async (ctx, delta) => {
          await orch.onWorkspaceApplied(ctx, delta);
          return undefined; // mark-only; never vetoes/transforms the commit.
        },
      );
    },
  };
}
