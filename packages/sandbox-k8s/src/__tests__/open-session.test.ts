import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createSessionInmemoryPlugin } from '@ax/session-inmemory';
import { createSandboxK8sPlugin } from '../plugin.js';
import type { OpenSessionResult } from '../open-session.js';
import { makeMockK8sApi, type MockK8sApi } from './mock-k8s.js';

// ---------------------------------------------------------------------------
// sandbox:open-session — k8s impl
//
// Tests run against a hand-rolled K8sCoreApi mock (see mock-k8s.ts). The
// hook bus is the real one via createTestHarness, with @ax/session-inmemory
// providing session:create / session:terminate so token minting happens
// for real.
//
// We do NOT exercise actual IPC. The runnerEndpoint comes back as
// `config.hostIpcUrl` (the host's @ax/ipc-http listener URL); pod IP is
// still resolved for the readiness signal but does not determine the
// endpoint. These tests assert on the pod spec content, env wiring,
// and lifecycle.
// ---------------------------------------------------------------------------

const FAST_POLL = { readinessPollMs: 1, readinessTimeoutMs: 2_000 };
const TEST_HOST_IPC_URL = 'http://test-host:8080';
// TASK-151 — a digest-pinned (I8) service image the OpenSessionInputSchema's
// re-validation at the open-session boundary accepts.
const PINNED_SVC_IMAGE = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

async function makeHarness(api: MockK8sApi) {
  return createTestHarness({
    plugins: [
      createSessionInmemoryPlugin(),
      createSandboxK8sPlugin({
        api,
        namespace: 'ax-test',
        image: 'ax-next/agent:test',
        hostIpcUrl: TEST_HOST_IPC_URL,
        ...FAST_POLL,
      }),
    ],
  });
}

function readyPod(podIP = '10.42.0.5') {
  return {
    status: {
      phase: 'Running',
      podIP,
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
}

describe('sandbox:open-session (k8s)', () => {
  it('createNamespacedPod is called with a spec carrying AX_SESSION_ID, AX_AUTH_TOKEN, AX_RUNNER_BINARY env entries', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sess-1',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      },
    );

    expect(api.creates).toHaveLength(1);
    const created = api.creates[0]!;
    expect(created.namespace).toBe('ax-test');
    const body = created.body as {
      spec: {
        containers: Array<{ env: Array<{ name: string; value: string }> }>;
      };
    };
    const env = Object.fromEntries(
      body.spec.containers[0]!.env.map((e) => [e.name, e.value]),
    );
    expect(env.AX_SESSION_ID).toBe('sess-1');
    expect(typeof env.AX_AUTH_TOKEN).toBe('string');
    expect(env.AX_AUTH_TOKEN!.length).toBeGreaterThan(0);
    // pod-spec hardcodes /permanent — the runner pod's writable mount
    // for the workspace working tree. The caller's `workspaceRoot` is
    // host-side (process.cwd / `/opt/ax-next/host`) and would point at
    // a read-only path inside the runner pod's filesystem namespace;
    // hardcoding here keeps the runner from ever seeing the host path.
    expect(env.AX_WORKSPACE_ROOT).toBe('/permanent');
    expect(env.AX_RUNNER_BINARY).toBe('/opt/ax/runner.js');
    // AX_RUNNER_ENDPOINT is the host's @ax/ipc-http URL (config.hostIpcUrl),
    // stamped at spec-build time — no pod-IP-derived placeholder.
    expect(env.AX_RUNNER_ENDPOINT).toBe(TEST_HOST_IPC_URL);
    // requestId comes from ctx.reqId — present in test harness contexts.
    expect(env.AX_REQUEST_ID).toBeDefined();
  });

  it('threads proxyConfig.proxyAuthToken into the runner pod env as AX_PROXY_TOKEN (TASK-52)', async () => {
    // Regression: open-session.ts maps proxyConfig field-by-field into the
    // pod-spec PodProxyConfig; a forgotten field is silently dropped at this
    // boundary. This proves the token survives the mapping end-to-end (not
    // just that buildPodSpec stamps it).
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', ctx, {
      sessionId: 'sess-proxy-token',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      proxyConfig: {
        unixSocketPath: '/var/run/ax/proxy.sock',
        caCertPem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
        envMap: {},
        proxyAuthToken: 'c'.repeat(32),
      },
    });
    const body = api.creates[0]!.body as {
      spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    };
    const env = Object.fromEntries(
      body.spec.containers[0]!.env.map((e) => [e.name, e.value]),
    );
    expect(env.AX_PROXY_TOKEN).toBe('c'.repeat(32));
  });

  it('forwards AX_COMMIT_TRACE into the runner pod env only when set on the host', async () => {
    // The opt-in per-turn commit/resync trace (commit-trace.ts) is gated on
    // AX_COMMIT_TRACE in the RUNNER process; the runner pod env only carries it
    // if the host sets it. This makes the trace reachable in k8s (the TASK-11
    // diagnosis blocker) without forwarding any other host env to the sandbox.
    const prior = process.env.AX_COMMIT_TRACE;
    const envFor = async (): Promise<Record<string, string>> => {
      const api = makeMockK8sApi();
      api.setReadResponses(readyPod());
      const h = await makeHarness(api);
      await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
        sessionId: 'sess-1',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      });
      const body = api.creates[0]!.body as {
        spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
      };
      return Object.fromEntries(
        body.spec.containers[0]!.env.map((e) => [e.name, e.value]),
      );
    };
    try {
      process.env.AX_COMMIT_TRACE = '1';
      expect((await envFor()).AX_COMMIT_TRACE).toBe('1');

      delete process.env.AX_COMMIT_TRACE;
      expect((await envFor()).AX_COMMIT_TRACE).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.AX_COMMIT_TRACE;
      else process.env.AX_COMMIT_TRACE = prior;
    }
  });

  it('per-pod child logger is constructed with podName + pid bindings before createNamespacedPod fires', async () => {
    // We assert the binding shape by tapping ctx.logger.child via a
    // wrapping logger that records calls. The mock api throws on create,
    // and we verify the logged podName + pid both came through BEFORE
    // create — i.e. on the same logger that owned the failed-create log.
    const api = makeMockK8sApi();
    api.setCreateError(new Error('sim-create-fail'));
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);

    // Capture child() calls on the logger.
    const childCalls: Array<Record<string, unknown>> = [];
    const origCtx = h.ctx();
    const wrappedLogger = {
      ...origCtx.logger,
      child: (extra: Record<string, unknown>) => {
        childCalls.push(extra);
        return origCtx.logger.child(extra);
      },
    } as typeof origCtx.logger;
    const ctx = { ...origCtx, logger: wrappedLogger };

    await expect(
      h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'sess-2',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      }),
    ).rejects.toBeDefined();

    expect(childCalls.length).toBeGreaterThan(0);
    const binding = childCalls[0]!;
    expect(binding.podName).toMatch(/^ax-sandbox-/);
    expect(typeof binding.pid).toBe('number');
    expect(binding.pid).toBeGreaterThanOrEqual(100_000);
  });

  it('pod spec sets gVisor, runAsNonRoot, allowPrivilegeEscalation:false, automountServiceAccountToken:false, resource limits', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await h.bus.call('sandbox:open-session', ctx, {
      sessionId: 'sess-3',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    });

    const body = api.creates[0]!.body as {
      spec: {
        runtimeClassName?: string;
        automountServiceAccountToken?: boolean;
        activeDeadlineSeconds?: number;
        containers: Array<{
          securityContext?: Record<string, unknown>;
          resources?: { limits?: Record<string, string> };
        }>;
      };
    };
    expect(body.spec.runtimeClassName).toBe('gvisor');
    expect(body.spec.automountServiceAccountToken).toBe(false);
    expect(body.spec.activeDeadlineSeconds).toBe(21600);
    const sc = body.spec.containers[0]!.securityContext!;
    expect(sc.runAsNonRoot).toBe(true);
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.capabilities).toEqual({ drop: ['ALL'] });
    expect(body.spec.containers[0]!.resources?.limits?.cpu).toBe('1');
    expect(body.spec.containers[0]!.resources?.limits?.memory).toBe('1Gi');
  });

  it('image config flows through — custom image lands in pod spec', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          image: 'foo/bar:v2',
          hostIpcUrl: TEST_HOST_IPC_URL,
          ...FAST_POLL,
        }),
      ],
    });
    const ctx = h.ctx();
    await h.bus.call('sandbox:open-session', ctx, {
      sessionId: 'sess-4',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
    });
    const body = api.creates[0]!.body as {
      spec: { containers: Array<{ image: string }> };
    };
    expect(body.spec.containers[0]!.image).toBe('foo/bar:v2');
  });

  it('returns runnerEndpoint = config.hostIpcUrl once the pod reaches Ready', async () => {
    const api = makeMockK8sApi();
    // First read returns Pending without IP; second returns Ready with IP.
    // The pod IP is still resolved for the readiness signal — but the
    // returned runnerEndpoint is the host's @ax/ipc-http URL, not pod IP.
    api.setReadResponses(
      { status: { phase: 'Pending' } },
      readyPod('10.42.0.5'),
    );
    const h = await makeHarness(api);
    const ctx = h.ctx();
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sess-5',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      },
    );
    expect(result.runnerEndpoint).toBe(TEST_HOST_IPC_URL);
  });

  it('rejects relative runnerBinary with PluginError(invalid-payload)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await expect(
      h.bus.call('sandbox:open-session', ctx, {
        sessionId: 'sess-6',
        workspaceRoot: '/tmp/ws',
        runnerBinary: './relative.js',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(api.creates).toHaveLength(0);
  });

  it('owner.conversationId round-trips through session:create → session:get-config', async () => {
    // Bug 1 regression net: prior to this fix, OpenSessionInputSchema
    // stripped `owner.conversationId` (it wasn't declared on the Zod
    // schema) so session:create wrote the v2 row with conversation_id =
    // NULL even when the orchestrator had set ctx.conversationId. The
    // runner's bind-skip branch (agent-claude-sdk-runner/src/main.ts:
    // 415-418) then fired and resume-on-second-turn never landed —
    // surfaced as runner-owned-sessions-k8s-gap.test.ts:137.
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await h.bus.call(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sess-conv',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
        owner: {
          userId: 'u-1',
          agentId: 'agt-1',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: 'be helpful',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
          conversationId: 'conv-42',
        },
      },
    );

    // session:get-config keys off ctx.sessionId (no input field — see
    // session-inmemory/plugin.ts:296). Build a fresh ctx pinned to the
    // session we just opened.
    const cfg = await h.bus.call<unknown, { conversationId: string | null }>(
      'session:get-config',
      h.ctx({ sessionId: 'sess-conv' }),
      {},
    );
    expect(cfg.conversationId).toBe('conv-42');
  });

  it('omits conversationId when owner has no conversationId (back-compat with non-orchestrator callers)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const ctx = h.ctx();
    await h.bus.call(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sess-noconv',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
        owner: {
          userId: 'u-1',
          agentId: 'agt-1',
          agentConfig: {
            displayName: 'Test Agent',
            systemPromptAugment: 'be helpful',
            allowedTools: [],
            mcpConfigIds: [],
            model: 'claude-sonnet-4-7',
          },
        },
      },
    );
    const cfg = await h.bus.call<unknown, { conversationId: string | null }>(
      'session:get-config',
      h.ctx({ sessionId: 'sess-noconv' }),
      {},
    );
    // session-inmemory normalizes "absent" to null on the read side.
    expect(cfg.conversationId).toBeNull();
  });

  // -----------------------------------------------------------------------
  // chat:phase producer — sandbox-k8s announces sandbox-starting BEFORE
  // calling createNamespacedPod so the UI can show "Starting sandbox…"
  // while the pod is being provisioned (which is the slowest step).
  // -----------------------------------------------------------------------

  it('fires chat:phase { reqId, phase: "sandbox-starting" } BEFORE createNamespacedPod', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);

    // Subscribe to chat:phase and record the order against pod-create.
    const events: Array<{ at: 'phase' | 'create'; payload?: unknown }> = [];
    h.bus.subscribe(
      'chat:phase',
      'test-phase-recorder',
      async (_ctx, payload) => {
        events.push({ at: 'phase', payload });
        return undefined;
      },
    );
    // Wrap api.createNamespacedPod to record when it ran.
    const origCreate = api.createNamespacedPod.bind(api);
    api.createNamespacedPod = async (args) => {
      events.push({ at: 'create' });
      return origCreate(args);
    };

    const ctx = h.ctx();
    await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      ctx,
      {
        sessionId: 'sess-phase-1',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      },
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.at).toBe('phase');
    expect(events[0]!.payload).toEqual({
      reqId: ctx.reqId,
      phase: 'sandbox-starting',
    });
    expect(events[1]!.at).toBe('create');
  });

  it('still completes openSession when chat:phase has no subscribers', async () => {
    // Defensive: phase is fire-and-forget. With no subscribers attached,
    // the bus's fire returns { rejected: false, payload } and pod create
    // proceeds normally.
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    const result = await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      h.ctx(),
      {
        sessionId: 'sess-phase-2',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      },
    );
    expect(result.runnerEndpoint).toBe(TEST_HOST_IPC_URL);
    expect(api.creates).toHaveLength(1);
  });

  it('still creates the pod when a chat:phase subscriber rejects', async () => {
    // Phase is informational, never veto-capable for our purposes. A
    // misbehaving subscriber that rejects must not block sandbox start.
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    h.bus.subscribe('chat:phase', 'test-phase-rejector', async () => ({
      rejected: true,
      reason: 'nope',
    }));
    await h.bus.call<unknown, OpenSessionResult>(
      'sandbox:open-session',
      h.ctx(),
      {
        sessionId: 'sess-phase-3',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      },
    );
    expect(api.creates).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // TASK-151 — dev service sidecars + readiness budget threading.
  // -----------------------------------------------------------------------

  it('renders declared services[] as native sidecars in the created pod spec', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses(readyPod());
    const h = await makeHarness(api);
    await h.bus.call<unknown, OpenSessionResult>('sandbox:open-session', h.ctx(), {
      sessionId: 'sess-svc',
      workspaceRoot: '/tmp/ws',
      runnerBinary: '/opt/ax/runner.js',
      services: [
        {
          name: 'postgres',
          image: PINNED_SVC_IMAGE,
          ports: [5432],
          env: { POSTGRES_PASSWORD: 'x' },
          healthcheck: { kind: 'tcp', port: 5432 },
          writablePaths: ['/var/lib/postgresql/data'],
        },
      ],
    });
    const body = api.creates[0]!.body as {
      spec: {
        securityContext?: { fsGroup?: number };
        containers: Array<{ name: string }>;
        initContainers: Array<{ name: string; restartPolicy?: string }>;
      };
    };
    // Runner stays the sole containers[] entry (I1 — services never leak there).
    expect(body.spec.containers).toHaveLength(1);
    expect(body.spec.containers[0]!.name).toBe('runner');
    const sidecar = body.spec.initContainers.find((c) => c.name === 'svc-postgres');
    expect(sidecar).toBeDefined();
    expect(sidecar!.restartPolicy).toBe('Always');
    expect(body.spec.securityContext?.fsGroup).toBe(1000);
  });

  it('scales the readiness budget by service count (I6) — timeout error reflects base + N*coldStart', async () => {
    // The pod never reaches Ready, so waitForPodReady times out. The error
    // message embeds the timeoutMs it was given, which proves the scaled
    // budget (base + serviceCount * perServiceColdStartMs) reached
    // waitForPodReady — not the flat readinessTimeoutMs. We use tiny config
    // values so the timeout fires fast.
    const api = makeMockK8sApi();
    api.setReadResponses({ status: { phase: 'Pending' } }); // never Ready
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          image: 'ax-next/agent:test',
          hostIpcUrl: TEST_HOST_IPC_URL,
          readinessPollMs: 1,
          readinessTimeoutMs: 10,
          perServiceColdStartMs: 25,
        }),
      ],
    });
    await expect(
      h.bus.call('sandbox:open-session', h.ctx(), {
        sessionId: 'sess-svc-timeout',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
        services: [
          {
            name: 'a',
            image: PINNED_SVC_IMAGE,
            ports: [5432],
            env: {},
            writablePaths: [],
          },
          {
            name: 'b',
            image: PINNED_SVC_IMAGE,
            ports: [5433],
            env: {},
            writablePaths: [],
          },
        ],
      }),
      // base 10 + 2 services * 25 = 60ms.
    ).rejects.toMatchObject({ message: expect.stringContaining('within 60ms') });
  });

  it('keeps the flat readiness budget for a service-less session (60ms base, no scaling)', async () => {
    const api = makeMockK8sApi();
    api.setReadResponses({ status: { phase: 'Pending' } }); // never Ready
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          image: 'ax-next/agent:test',
          hostIpcUrl: TEST_HOST_IPC_URL,
          readinessPollMs: 1,
          readinessTimeoutMs: 60,
          perServiceColdStartMs: 25,
        }),
      ],
    });
    await expect(
      h.bus.call('sandbox:open-session', h.ctx(), {
        sessionId: 'sess-noservices-timeout',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
      }),
      // no services → flat 60ms, NOT scaled.
    ).rejects.toMatchObject({ message: expect.stringContaining('within 60ms') });
  });

  // TASK-160 — when a declared service sidecar crashes on startup the readiness
  // wait times out; before rolling back, the impl self-diagnoses the failure
  // and throws an enriched PluginError carrying a neutral `diagnosis`.
  it('surfaces a service-sidecar startup failure with the service + offending path (EROFS)', async () => {
    const api = makeMockK8sApi();
    // The pod is stuck Pending because the kafka sidecar crashlooped.
    api.setReadResponses({
      status: {
        phase: 'Pending',
        initContainerStatuses: [
          { name: 'sdk-scaffold', state: { terminated: { exitCode: 0 } } },
          { name: 'svc-kafka', state: { waiting: { reason: 'CrashLoopBackOff' } } },
        ],
      },
    });
    api.setLogResponse(
      'svc-kafka',
      'starting kafka...\nmkdir: cannot create directory /opt/kafka/data: Read-only file system',
    );
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          image: 'ax-next/agent:test',
          hostIpcUrl: TEST_HOST_IPC_URL,
          readinessPollMs: 1,
          readinessTimeoutMs: 5,
          perServiceColdStartMs: 5,
        }),
      ],
    });
    const err = await h.bus
      .call('sandbox:open-session', h.ctx(), {
        sessionId: 'sess-kafka-erofs',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
        services: [
          {
            name: 'kafka',
            image: PINNED_SVC_IMAGE,
            ports: [9092],
            env: {},
            writablePaths: [],
          },
        ],
      })
      .then(
        () => {
          throw new Error('expected open-session to reject');
        },
        (e: unknown) => e,
      );
    expect(err).toMatchObject({
      code: 'service-sidecar-failed',
      diagnosis: {
        service: 'kafka',
        path: '/opt/kafka/data',
        reason: 'read-only filesystem',
      },
    });
    // Rollback still happened — the pod was deleted.
    expect(api.deletes.length).toBeGreaterThan(0);
  });

  it('keeps the generic timeout error (no diagnosis) when no sidecar is failing', async () => {
    const api = makeMockK8sApi();
    // Pod never Ready, but the sidecar is merely still initializing — not a
    // crash. No diagnosis should be produced.
    api.setReadResponses({
      status: {
        phase: 'Pending',
        initContainerStatuses: [
          { name: 'svc-kafka', state: { waiting: { reason: 'PodInitializing' } } },
        ],
      },
    });
    const h = await createTestHarness({
      plugins: [
        createSessionInmemoryPlugin(),
        createSandboxK8sPlugin({
          api,
          namespace: 'ax-test',
          image: 'ax-next/agent:test',
          hostIpcUrl: TEST_HOST_IPC_URL,
          readinessPollMs: 1,
          readinessTimeoutMs: 5,
          perServiceColdStartMs: 5,
        }),
      ],
    });
    const err = await h.bus
      .call('sandbox:open-session', h.ctx(), {
        sessionId: 'sess-init',
        workspaceRoot: '/tmp/ws',
        runnerBinary: '/opt/ax/runner.js',
        services: [
          {
            name: 'kafka',
            image: PINNED_SVC_IMAGE,
            ports: [9092],
            env: {},
            writablePaths: [],
          },
        ],
      })
      .then(
        () => {
          throw new Error('expected open-session to reject');
        },
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: 'pod-readiness-timeout' });
    expect((err as { diagnosis?: unknown }).diagnosis).toBeUndefined();
  });
});
