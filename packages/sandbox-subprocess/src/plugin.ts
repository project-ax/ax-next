import type { Plugin } from '@ax/core';
import { OpenSessionResultSchema } from '@ax/sandbox-protocol';
import type {
  ReadUserFileRangeInput,
  ReadUserFileRangeOutput,
  ReadUserFilesInput,
  ReadUserFilesOutput,
  UserFilesUsageInput,
  UserFilesUsageOutput,
} from '@ax/sandbox-mount-protocol';
import type { ZodType } from 'zod';
import { openSessionImpl, type OpenSessionResult } from './open-session.js';
import {
  cleanupUserFiles,
  measureUserFiles,
  ownerFromAgentId,
  readUserFileRange,
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
      //
      // `sandbox:read-user-file-range` (TASK-1014): one byte range of one file
      // under that same hostPath, read-only, so a download can stream a file
      // of any size a range at a time. Same resolver, same confined walk.
      //
      // `sandbox:user-files-usage` (TASK-993): how much that same hostPath
      // holds, for the storage limit, via the same confined no-follow walk.
      registers: [
        'sandbox:open-session',
        'sandbox:read-user-file-range',
        'sandbox:read-user-files',
        'sandbox:user-files-usage',
      ],
      // open-session mints a session + token, starts the IPC listener, then
      // spawns the runner. Declaring these calls lets bootstrap's verifyCalls
      // catch a missing producer at boot instead of first-call time.
      calls: [
        'session:create',
        'session:terminate',
        'ipc:start',
        'ipc:stop',
      ],
      // filestore-user-files (design §4): `sandbox:resolve-mounts` is the
      // durable per-agent mount resolver (@ax/workspace-localdir, which the CLI
      // always loads). open-session calls it for every owned session and
      // realizes each `localDir` mount by `mkdir -p`. It stays an OPTIONAL call
      // because boot does not need it, but open-session REFUSES an owned
      // session that gets no `role:'user-files'` directory (TASK-992: the
      // durable /files home is required). The host-side ops below,
      // `sandbox:read-user-files`, `sandbox:read-user-file-range`,
      // `sandbox:user-files-usage` and the `agents:deleted` cleanup, call it to
      // learn WHERE an agent's files live and keep degrading gracefully when no
      // resolver is loaded (the meter by throwing, never by answering 0).
      optionalCalls: [
        {
          hook: 'sandbox:resolve-mounts',
          degradation:
            'open-session REFUSES owned sessions (no durable /files home); ' +
            'host-read (previews and download ranges) answers unavailable, ' +
            'the usage meter throws home-unavailable, and agent-delete ' +
            'cleanup is a no-op',
        },
      ],
      // filestore-user-files §11 cleanup: when an agent is deleted, reclaim its
      // durable user-files subtree (rm -rf the resolved hostPath). Fired by
      // @ax/agents AFTER the row is gone; isolated by HookBus.fire so a cleanup
      // failure never affects the delete.
      subscribes: ['agents:deleted'],
    },
    async init({ bus }) {
      // No `stallWarnMs` override, matching the k8s backend's reasoning
      // (TASK-505): the 300s timeout is a worst-case backstop, not a typical
      // duration, so a spawn still running at the bus's 15s stall threshold is
      // worth naming rather than filtering.
      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        async (ctx, raw) => openSessionImpl(ctx, raw, bus),
        { timeoutMs: 300_000, returns: OPEN_SESSION_RETURNS },
      );

      // §11 host-read. Read-only by construction (the realization never opens a
      // writable handle); caller-supplied paths are confined to the resolved
      // mount subtree. No durable resolver loaded → `{ kind: 'unavailable' }` (a
      // fact about the deployment, NOT the same answer as a path that is not
      // there — TASK-403); a read that FAILED throws rather than answering an
      // absence.
      bus.registerService<ReadUserFilesInput, ReadUserFilesOutput>(
        'sandbox:read-user-files',
        PLUGIN_NAME,
        async (ctx, input) => readUserFiles(ctx, bus, PLUGIN_NAME, input),
      );

      // TASK-1014 download read: one byte range per call, read-only and
      // confined exactly like host-read above. Why 30 s: each call is ONE
      // host-side read of one range (the download route asks for 1 MiB at a
      // time; the hook allows at most 16 MiB), which takes milliseconds on a
      // healthy disk. The bus's 120 s default would let one wedged read hold a
      // download open for two minutes per range; 30 s turns it into a
      // `timeout` that ends the download (a 503 before the first byte, an
      // aborted body after it). The default 15 s stall warning stays: a range
      // still in flight at 15 s is worth a line.
      bus.registerService<ReadUserFileRangeInput, ReadUserFileRangeOutput>(
        'sandbox:read-user-file-range',
        PLUGIN_NAME,
        async (ctx, input) => readUserFileRange(ctx, bus, PLUGIN_NAME, input),
        { timeoutMs: 30_000 },
      );

      // TASK-993 usage meter. Read-only (the walk opens nothing but folders);
      // a missing home throws rather than answering 0. The walk bounds itself
      // at 120 s; the timeout is the bus-side backstop above that.
      bus.registerService<UserFilesUsageInput, UserFilesUsageOutput>(
        'sandbox:user-files-usage',
        PLUGIN_NAME,
        async (ctx, input) => measureUserFiles(ctx, bus, PLUGIN_NAME, ctx.logger, input),
        { timeoutMs: 180_000 },
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
