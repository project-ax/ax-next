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
// `http://podIP:7777` and the orchestrator's contract is to treat it as
// opaque — pod-side HTTP server lands later. These tests assert on the
// pod spec content, env wiring, and lifecycle.
// ---------------------------------------------------------------------------

const FAST_POLL = { readinessPollMs: 1, readinessTimeoutMs: 2_000 };

async function makeHarness(api: MockK8sApi) {
  return createTestHarness({
    plugins: [
      createSessionInmemoryPlugin(),
      createSandboxK8sPlugin({
        api,
        namespace: 'ax-test',
        image: 'ax-next/agent:test',
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
    expect(env.AX_WORKSPACE_ROOT).toBe('/tmp/ws');
    expect(env.AX_RUNNER_BINARY).toBe('/opt/ax/runner.js');
    // requestId comes from ctx.reqId — present in test harness contexts.
    expect(env.AX_REQUEST_ID).toBeDefined();
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
    expect(body.spec.activeDeadlineSeconds).toBe(3600);
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

  it('returns runnerEndpoint = http://<podIP>:7777 once the pod reaches Ready with an IP', async () => {
    const api = makeMockK8sApi();
    // First read returns Pending without IP; second returns Ready with IP.
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
    expect(result.runnerEndpoint).toBe('http://10.42.0.5:7777');
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
});
