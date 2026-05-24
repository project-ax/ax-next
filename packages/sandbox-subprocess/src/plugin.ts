import type { Plugin } from '@ax/core';
import { OpenSessionResultSchema } from '@ax/sandbox-protocol';
import type { ZodType } from 'zod';
import { openSessionImpl, type OpenSessionResult } from './open-session.js';

const PLUGIN_NAME = '@ax/sandbox-subprocess';

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
      registers: ['sandbox:open-session'],
      // open-session mints a session + token, starts the IPC listener, then
      // spawns the runner. Declaring these calls lets bootstrap's verifyCalls
      // catch a missing producer at boot instead of first-call time.
      calls: [
        'session:create',
        'session:terminate',
        'ipc:start',
        'ipc:stop',
      ],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService<unknown, OpenSessionResult>(
        'sandbox:open-session',
        PLUGIN_NAME,
        async (ctx, raw) => openSessionImpl(ctx, raw, bus),
        { timeoutMs: 300_000, returns: OPEN_SESSION_RETURNS },
      );
    },
  };
}
