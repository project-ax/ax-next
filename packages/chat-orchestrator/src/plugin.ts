import type { ChatOutcome, Plugin } from '@ax/core';
import {
  createOrchestrator,
  PLUGIN_NAME,
  type ChatOrchestratorConfig,
  type ChatRunInput,
} from './orchestrator.js';

// ---------------------------------------------------------------------------
// @ax/chat-orchestrator plugin
//
// Registers `chat:run` — the host-side entrypoint a CLI (or any other host)
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
      registers: ['chat:run'],
      // The orchestrator drives the per-chat lifecycle by calling these
      // peers. `session:create` is NOT listed — sandbox:open-session mints
      // the session itself; a double-create throws duplicate-session. The
      // orchestrator intentionally delegates session minting to the sandbox
      // plugin. `ipc:stop` is not called directly here — sandbox-subprocess
      // stops its own listener on child-close — but we keep it in `calls`
      // as a safety declaration in case a future shutdown path adds it.
      calls: [
        'session:queue-work',
        'session:terminate',
        'sandbox:open-session',
        'ipc:stop',
      ],
      // We listen to `chat:end` to capture the outcome emitted by the
      // runner (via the IPC server's /event.chat-end handler). The
      // subscriber is a pass-through: resolves the waiting deferred,
      // returns undefined, doesn't veto and doesn't transform.
      subscribes: ['chat:end'],
    },
    init({ bus }) {
      const orch = createOrchestrator(bus, config);

      bus.registerService<ChatRunInput, ChatOutcome>(
        'chat:run',
        PLUGIN_NAME,
        async (ctx, input) => orch.runChat(ctx, input),
      );

      bus.subscribe<{ outcome: ChatOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          orch.onChatEnd(ctx, payload);
          return undefined; // pass-through; no transform, no veto.
        },
      );
    },
  };
}
