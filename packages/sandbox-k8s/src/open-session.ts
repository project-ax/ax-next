import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PluginError,
  type ChatContext,
  type HookBus,
  type Logger,
} from '@ax/core';
import type { ResolvedSandboxK8sConfig } from './config.js';
import type { K8sCoreApi } from './k8s-api.js';
import { killPod } from './kill.js';
import { watchPodExit, waitForPodReady, type ExitInfo } from './lifecycle.js';
import { buildPodSpec, RUNNER_PORT } from './pod-spec.js';

// ---------------------------------------------------------------------------
// sandbox:open-session — k8s impl.
//
// Mirrors the @ax/sandbox-subprocess shape:
//   1. Validate input.
//   2. Mint pod name + per-pod child logger (reqId, podName, synthetic pid).
//   3. Call session:create to mint sessionId + token.
//   4. Build pod spec with sessionId/token/requestId/runnerBinary in env.
//   5. createNamespacedPod.
//   6. Wait for Ready → resolve podIP.
//   7. Construct runnerEndpoint = `http://<podIP>:7777`.
//   8. Wire `exited` from a long-lived watchPodExit poll.
//   9. Cleanup-on-exit: terminate session + delete pod (idempotent).
//
// Failures roll back: any exception after step 3 calls session:terminate
// before re-throwing, so a partial init doesn't leave a token alive with
// no pod.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/sandbox-k8s';
const HOOK_NAME = 'sandbox:open-session';

export const OpenSessionInputSchema = z.object({
  sessionId: z.string().min(1),
  workspaceRoot: z.string().regex(/^\//, 'workspaceRoot must be absolute'),
  runnerBinary: z.string().regex(/^\//, 'runnerBinary must be absolute'),
});

export type OpenSessionInput = z.input<typeof OpenSessionInputSchema>;
export type OpenSessionParsed = z.infer<typeof OpenSessionInputSchema>;

export interface OpenSessionHandle {
  kill(): Promise<void>;
  exited: Promise<ExitInfo>;
}

export interface OpenSessionResult {
  /** Opaque URI: `http://<podIP>:${RUNNER_PORT}`. */
  runnerEndpoint: string;
  handle: OpenSessionHandle;
}

interface SessionCreateInput {
  sessionId: string;
  workspaceRoot: string;
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
    ctx: ChatContext,
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
    //    up — there's no pod yet.
    let created: SessionCreateOutput;
    try {
      created = await deps.bus.call<SessionCreateInput, SessionCreateOutput>(
        'session:create',
        ctx,
        { sessionId: input.sessionId, workspaceRoot: input.workspaceRoot },
      );
    } catch (err) {
      podLog.warn('session_create_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 3. Build pod spec. The runnerEndpoint env value is a placeholder —
    //    we resolve the real value after pod IP comes back, then mutate
    //    the env entry in-place before createNamespacedPod fires.
    //
    //    Why this is safe: nothing else holds the spec yet. The mutation
    //    happens between buildPodSpec and the k8s API call, in the same
    //    function, in the same tick.
    //
    //    Why we don't wait-then-patch: the runner reads env at startup;
    //    a kubectl-style patch would race the runner. Putting the value
    //    in the spec at create time avoids that race entirely.
    //
    //    The flow:
    //      a. buildPodSpec emits AX_RUNNER_ENDPOINT='pending://await-pod-ready'
    //      b. createNamespacedPod fires.
    //      c. waitForPodReady returns the pod IP.
    //      d. We can't actually rewrite spec post-create (k8s rejects).
    //         So instead we issue a strategic merge patch that only
    //         updates the env array. Or — simpler — we set
    //         AX_RUNNER_ENDPOINT BEFORE create, but at create-time we
    //         don't know the IP. Resolution: pod self-discovers via the
    //         downward API.
    //
    //    Actually: k8s exposes `status.podIP` to the container via the
    //    downward API. We add a fieldRef-sourced env var POD_IP, and the
    //    runner builds AX_RUNNER_ENDPOINT itself from POD_IP + the
    //    well-known port. That sidesteps the patch race entirely.
    //
    //    For NOW: the runner-side code does NOT yet read POD_IP — Task
    //    14b shipped the URI-rename without an http:// transport. The
    //    pod env we set still says 'pending://await-pod-ready'; the
    //    runnerEndpoint we RETURN to the orchestrator IS http://podIP:
    //    7777. Tests assert on the returned value (the orchestrator's
    //    contract). End-to-end http:// transport lands in a follow-up
    //    when the pod-side HTTP server exists.
    const podSpec = buildPodSpec(podName, {
      sessionId: created.sessionId,
      workspaceRoot: input.workspaceRoot,
      runnerBinary: input.runnerBinary,
      authToken: created.token,
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
    //    state where IPC could connect; roll back.
    let podIP: string;
    try {
      const ready = await waitForPodReady({
        api: deps.api,
        podName,
        namespace: deps.config.namespace,
        pollIntervalMs: deps.config.readinessPollMs,
        timeoutMs: deps.config.readinessTimeoutMs,
        podLog,
      });
      podIP = ready.podIP;
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

    const runnerEndpoint = `http://${podIP}:${RUNNER_PORT}`;

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
