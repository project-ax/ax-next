import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PluginError,
  type AgentContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi } from './k8s-api.js';
import { killPod } from './kill.js';
import { watchPodExit, waitForPodReady, type ExitInfo } from './lifecycle.js';
import { buildPodSpec } from './pod-spec.js';

// ---------------------------------------------------------------------------
// sandbox:open-session — k8s impl.
//
// Mirrors the @ax/sandbox-subprocess shape:
//   1. Validate input.
//   2. Mint pod name + per-pod child logger (reqId, podName, synthetic pid).
//   3. Call session:create to mint sessionId + token.
//   4. Build pod spec with sessionId/token/requestId/runnerBinary in env
//      plus AX_RUNNER_ENDPOINT = config.hostIpcUrl (the cluster Service
//      URL pointing at the host pod's @ax/ipc-http listener).
//   5. createNamespacedPod.
//   6. Wait for Ready (we still need the pod IP for liveness, just not
//      for runnerEndpoint construction).
//   7. Wire `exited` from a long-lived watchPodExit poll.
//   8. Cleanup-on-exit: terminate session + delete pod (idempotent).
//
// Failures roll back: any exception after step 3 calls session:terminate
// before re-throwing, so a partial init doesn't leave a token alive with
// no pod.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/sandbox-k8s';
const HOOK_NAME = 'sandbox:open-session';

// Owner triple — same shape sandbox-subprocess accepts. Forwarded to
// session:create so the v2 row is written atomically with v1.
export const AgentConfigSchema = z.object({
  systemPrompt: z.string(),
  allowedTools: z.array(z.string()),
  mcpConfigIds: z.array(z.string()),
  model: z.string(),
});

export const OpenSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  workspaceRoot: z.string().regex(/^\//, 'workspaceRoot must be absolute'),
  runnerBinary: z.string().regex(/^\//, 'runnerBinary must be absolute'),
  owner: z
    .object({
      userId: z.string().min(1),
      agentId: z.string().min(1),
      agentConfig: AgentConfigSchema,
    })
    .optional(),
});

export type OpenSessionInput = z.input<typeof OpenSessionInputSchema>;
export type OpenSessionParsed = z.infer<typeof OpenSessionInputSchema>;

export interface OpenSessionHandle {
  kill(): Promise<void>;
  exited: Promise<ExitInfo>;
}

export interface OpenSessionResult {
  /** Opaque URI: the cluster Service URL of the host's IPC listener
   *  (`config.hostIpcUrl`). The runner pod connects out to this URL. */
  runnerEndpoint: string;
  handle: OpenSessionHandle;
}

interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
  owner?: {
    userId: string;
    agentId: string;
    agentConfig: {
      systemPrompt: string;
      allowedTools: string[];
      mcpConfigIds: string[];
      model: string;
    };
  };
}
interface SessionCreateOutput {
  sessionId: string;
  token: string;
}
interface SessionTerminateInput {
  sessionId: string;
}

// Synthetic PID counter — pods don't have host-visible PIDs but the rest
// of the system (audit-log, host logger) keys on `pid` for cross-cutting
// correlation. Per-instance so two SandboxK8s plugins in the same process
// don't collide.
function makePidGenerator(): () => number {
  let next = 100_000;
  return () => next++;
}

export interface OpenSessionDeps {
  api: K8sCoreApi;
  config: ResolvedSandboxK8sConfig;
  bus: HookBus;
  /** Set by createSandboxK8sPlugin from a per-instance counter. */
  nextPid: () => number;
}

export function createOpenSession(deps: OpenSessionDeps) {
  return async function openSessionImpl(
    ctx: AgentContext,
    rawInput: unknown,
  ): Promise<OpenSessionResult> {
    const parsed = OpenSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new PluginError({
        code: 'invalid-payload',
        plugin: PLUGIN_NAME,
        hookName: HOOK_NAME,
        message: `invalid input: ${parsed.error.message}`,
        cause: parsed.error,
      });
    }
    const input: OpenSessionParsed = parsed.data;

    // 1. Pod name + per-pod child logger BEFORE we make any k8s call so
    //    pod_create_failed log lines carry the same bindings as the rest
    //    of the lifecycle. We bind reqId from ctx (already present) and
    //    a synthetic pid from the per-instance counter.
    const podName = `ax-sandbox-${randomUUID().slice(0, 8)}`;
    const pid = deps.nextPid();
    const podLog: Logger = ctx.logger.child({ podName, pid });

    // 2. Mint session + token. Failures here don't leave anything to clean
    //    up — there's no pod yet. The owner triple (Week 9.5) is forwarded
    //    so the v2 row is written atomically with v1.
    let created: SessionCreateOutput;
    try {
      const sessionCreateInput: SessionCreateInput = {
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
      };
      if (input.owner !== undefined) {
        sessionCreateInput.owner = input.owner;
      }
      created = await deps.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        ctx,
        sessionCreateInput,
      );
    } catch (err) {
      podLog.warn('session_create_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 3. Build pod spec. runnerEndpoint is fixed at preset-config time
    //    (config.hostIpcUrl) and stamped onto AX_RUNNER_ENDPOINT — the
    //    runner reads it at startup and connects out to the host's
    //    @ax/ipc-http listener.
    const podSpec = buildPodSpec(podName, {
      sessionId: created.sessionId,
      workspaceRoot: input.workspaceRoot,
      runnerBinary: input.runnerBinary,
      authToken: created.token,
      runnerEndpoint: deps.config.hostIpcUrl,
      // ctx.requestId may be undefined in synthetic tests; pass through.
      requestId: ctx.reqId,
    }, deps.config);

    podLog.info('creating_pod', {
      namespace: deps.config.namespace,
      image: deps.config.image,
    });

    try {
      await deps.api.createNamespacedPod({
        namespace: deps.config.namespace,
        body: podSpec,
      });
    } catch (err) {
      podLog.error('pod_create_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Roll back the session so we don't leave a live token with no pod.
      await deps.bus
        .call<SessionTerminateInput, Record<string, never>>(
          'session:terminate',
          ctx,
          { sessionId: created.sessionId },
        )
        .catch(() => undefined);
      throw new PluginError({
        code: 'pod-create-failed',
        plugin: PLUGIN_NAME,
        hookName: HOOK_NAME,
        message: `failed to create pod ${podName}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Wait for Ready. A failure here means the pod never reached a
    //    state where IPC could connect; roll back. We still resolve the
    //    pod IP here for the readiness signal (the API mock returns it),
    //    but it does NOT determine runnerEndpoint anymore — that's the
    //    host's @ax/ipc-http URL, fixed at preset-config time.
    try {
      await waitForPodReady({
        api: deps.api,
        podName,
        namespace: deps.config.namespace,
        pollIntervalMs: deps.config.readinessPollMs,
        timeoutMs: deps.config.readinessTimeoutMs,
        podLog,
      });
    } catch (err) {
      // Cleanup: kill the pod (idempotent — it may already be Failed)
      // and tear down the session.
      await killPod({
        api: deps.api,
        podName,
        namespace: deps.config.namespace,
        podLog,
      }).catch(() => undefined);
      await deps.bus
        .call<SessionTerminateInput, Record<string, never>>(
          'session:terminate',
          ctx,
          { sessionId: created.sessionId },
        )
        .catch(() => undefined);
      throw err;
    }

    const runnerEndpoint = deps.config.hostIpcUrl;

    // 5. exited promise — long-lived poll until the pod reaches a
    //    terminal phase. We do NOT await; the caller listens.
    const exited = watchPodExit({
      api: deps.api,
      podName,
      namespace: deps.config.namespace,
      pollIntervalMs: deps.config.readinessPollMs,
      podLog,
    });

    // 6. Cleanup-on-exit. Mirrors sandbox-subprocess's child-close handler.
    //    session:terminate is best-effort + deduped: handle.kill() also
    //    attempts cleanup, and either path is idempotent.
    void exited
      .then(async () => {
        await deps.bus
          .call<SessionTerminateInput, Record<string, never>>(
            'session:terminate',
            ctx,
            { sessionId: created.sessionId },
          )
          .catch((err) => {
            podLog.warn('session_terminate_failed', {
              sessionId: created.sessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        // Delete the pod after exit — keeps Failed/Succeeded pods from
        // accumulating in the namespace. 404 here means GC already ran.
        await killPod({
          api: deps.api,
          podName,
          namespace: deps.config.namespace,
          podLog,
        }).catch(() => undefined);
      })
      .catch(() => undefined);

    const kill = async (): Promise<void> => {
      // Idempotent. The cleanup-on-exit handler will also try to delete;
      // either is fine because killPod swallows 404.
      await killPod({
        api: deps.api,
        podName,
        namespace: deps.config.namespace,
        podLog,
      }).catch(() => undefined);
      // We DON'T await `exited` here — that's the caller's job. The
      // sandbox-subprocess sibling does await; for k8s the pod takes
      // grace_period_seconds (5s) to actually go away which is too long
      // for the orchestrator's tight teardown. Returning fast and letting
      // the orchestrator decide whether to await `exited` is cleaner.
    };

    podLog.info('pod_created', { runnerEndpoint });
    return { runnerEndpoint, handle: { kill, exited } };
  };
}

export { makePidGenerator };
