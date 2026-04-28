import type { AgentOutcome, Plugin } from '@ax/core';
import {
  createOrchestrator,
  PLUGIN_NAME,
  type ChatOrchestratorConfig,
  type ChatRunInput,
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
      registers: ['agent:invoke'],
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
      subscribes: ['chat:end', 'chat:turn-end'],
    },
    init({ bus }) {
      const orch = createOrchestrator(bus, config);

      bus.registerService<ChatRunInput, AgentOutcome>(
        'agent:invoke',
        PLUGIN_NAME,
        async (ctx, input) => orch.runChat(ctx, input),
      );

      bus.subscribe<{ outcome: AgentOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          orch.onChatEnd(ctx, payload);
          return undefined; // pass-through; no transform, no veto.
        },
      );

      bus.subscribe<{ reason?: string }>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx) => {
          orch.onTurnEnd(ctx);
          return undefined;
        },
      );
    },
  };
}
