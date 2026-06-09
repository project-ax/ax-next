import type { Plugin } from '@ax/core';
import { OpenSessionResultSchema } from '@ax/sandbox-protocol';
import type {
  ReadUserFilesInput,
  ReadUserFilesOutput,
} from '@ax/sandbox-mount-protocol';
import type { ZodType } from 'zod';
import { openSessionImpl, type OpenSessionResult } from './open-session.js';
import {
  cleanupUserFiles,
  ownerFromAgentId,
  readUserFiles,
} from './user-files-host-ops.js';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

// Structural twin of @ax/agents' AgentsDeletedEvent (I2 — no cross-plugin
// import; the bus is the API). A drift surfaces as a runtime shape mismatch at
// the subscriber. We read only `agentId` (the per-agent subtree key) + `ownerId`
// (forwarded as the resolver owner's userId, though the resolvers ignore it).
interface AgentsDeletedEvent {
  agentId: string;
  ownerId: string;
  ownerType: 'user' | 'team';
}

// `.passthrough()` schema infers `{ runnerEndpoint: string } & {[k]: unknown}`,
// which can't be proven assignable to `OpenSessionResult` (its `handle` is a
// typed live object). The schema deliberately doesn't model the handle — it
// only asserts `runnerEndpoint` and passes everything else through untouched —
// so we cast it to the hook's output type for `registerService`.
const OPEN_SESSION_RETURNS =
  OpenSessionResultSchema as unknown as ZodType<OpenSessionResult>;

export function createSandboxSubprocessPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // `sandbox:spawn` was deleted in Task 6 — the host no longer spawns
      // one-shot processes directly; every tool execution runs inside the
      // runner-side sandbox via `sandbox:open-session`.
      //
      // `sandbox:read-user-files` (filestore-user-files §11 host-read): the
      // host's READ-ONLY view of an agent's durable user-files mount, so the
      // web UI can serve those files without entering a live sandbox. Realized
      // by reading the resolved `localDir` hostPath read-only.
      registers: ['sandbox:open-session', 'sandbox:read-user-files'],
      // open-session mints a session + token, starts the IPC listener, then
      // spawns the runner. Declaring these calls lets bootstrap's verifyCalls
      // catch a missing producer at boot instead of first-call time.
      calls: [
        'session:create',
        'session:terminate',
        'ipc:start',
        'ipc:stop',
      ],
      // filestore-user-files (design §4): when a mount-resolver plugin
      // (@ax/workspace-localdir) is loaded, open-session calls
      // `sandbox:resolve-mounts` to learn the per-agent durable mount and
      // realizes each `localDir` by `mkdir -p`. Optional — without a resolver
      // the session gets only the default per-session tempdir tiers; no durable
      // per-agent user-files mount (AX_USERFILES_ROOT stays unset).
      // `sandbox:resolve-mounts` is the durable per-agent mount resolver. It's
      // optional for open-session (no resolver → no AX_USERFILES_ROOT) AND for
      // both §11 host-side ops below: `sandbox:read-user-files` and the
      // `agents:deleted` cleanup both call it to learn WHERE an agent's files
      // live, and degrade to a no-op when no resolver is loaded.
      optionalCalls: [
        {
          hook: 'sandbox:resolve-mounts',
          degradation:
            'no durable per-agent user-files mount; AX_USERFILES_ROOT unset; ' +
            'host-read returns absent and agent-delete cleanup is a no-op',
        },
      ],
      // filestore-user-files §11 cleanup: when an agent is deleted, reclaim its
      // durable user-files subtree (rm -rf the resolved hostPath). Fired by
      // @ax/agents AFTER the row is gone; isolated by HookBus.fire so a cleanup
      // failure never affects the delete.
      subscribes: ['agents:deleted'],
    },
    async init({ bus }) {
      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        async (ctx, raw) => openSessionImpl(ctx, raw, bus),
        { timeoutMs: 300_000, returns: OPEN_SESSION_RETURNS },
      );

      // §11 host-read. Read-only by construction (the realization never opens a
      // writable handle); caller-supplied paths are confined to the resolved
      // mount subtree. No durable resolver loaded → `{ kind: 'absent' }`.
      bus.registerService<ReadUserFilesInput, ReadUserFilesOutput>(
        'sandbox:read-user-files',
        PLUGIN_NAME,
        async (ctx, input) => readUserFiles(ctx, bus, PLUGIN_NAME, input),
      );

      // §11 cleanup-on-agent-delete. rm -rf the agent's durable user-files
      // subtree, scoped to EXACTLY this agentId (cross-tenant safety, §9).
      bus.subscribe<AgentsDeletedEvent>(
        'agents:deleted',
        PLUGIN_NAME,
        async (ctx, event) => {
          await cleanupUserFiles(
            ctx,
            bus,
            PLUGIN_NAME,
            ownerFromAgentId(event.agentId, event.ownerId),
            ctx.logger,
          );
          return undefined;
        },
      );
    },
  };
}
