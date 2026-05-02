import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { buildPodSpec } from '../pod-spec.js';

const baseInput = {
  sessionId: 'sess',
  workspaceRoot: '/tmp/ws',
  runnerBinary: '/opt/runner.js',
  authToken: 'tok',
  runnerEndpoint: 'http://ax-next-host.ax-next.svc.cluster.local:80',
};

const baseResolved = () =>
  resolveConfig({
    hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
  });

describe('buildPodSpec', () => {
  it('emits the locked-down securityContext defaults', () => {
    const spec = buildPodSpec('pod-x', baseInput, baseResolved());
    const sc = (
      spec.spec as { containers: Array<{ securityContext: Record<string, unknown> }> }
    ).containers[0]!.securityContext;
    expect(sc).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
  });

  it('does not declare a containerPort (runner is purely an IPC client)', () => {
    const spec = buildPodSpec('pod-x', baseInput, baseResolved());
    const container = (
      spec.spec as {
        containers: Array<{ ports?: Array<{ containerPort: number }> }>;
      }
    ).containers[0]!;
    expect(container.ports).toBeUndefined();
  });

  it('stamps AX_RUNNER_ENDPOINT directly from input.runnerEndpoint', () => {
    const spec = buildPodSpec(
      'pod-x',
      {
        ...baseInput,
        runnerEndpoint: 'http://example-host.example.svc.cluster.local:8080',
      },
      baseResolved(),
    );
    const env = Object.fromEntries(
      (
        spec.spec as {
          containers: Array<{ env: Array<{ name: string; value: string }> }>;
        }
      ).containers[0]!.env.map((e) => [e.name, e.value]),
    );
    expect(env.AX_RUNNER_ENDPOINT).toBe(
      'http://example-host.example.svc.cluster.local:8080',
    );
  });

  it('respects activeDeadlineSeconds config (default 3600, override 600)', () => {
    const dflt = buildPodSpec('a', baseInput, baseResolved());
    expect((dflt.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds).toBe(
      3600,
    );
    const custom = buildPodSpec(
      'b',
      baseInput,
      resolveConfig({
        hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
        activeDeadlineSeconds: 600,
      }),
    );
    expect(
      (custom.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds,
    ).toBe(600);
  });

  it('omits runtimeClassName when configured to empty string (gVisor opt-out)', () => {
    const spec = buildPodSpec(
      'c',
      baseInput,
      resolveConfig({
        hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
        runtimeClassName: '',
      }),
    );
    expect(
      (spec.spec as { runtimeClassName?: string }).runtimeClassName,
    ).toBeUndefined();
  });

  it('threads imagePullSecrets through when provided', () => {
    const spec = buildPodSpec(
      'd',
      baseInput,
      resolveConfig({
        hostIpcUrl: 'http://ax-next-host.ax-next.svc.cluster.local:80',
        imagePullSecrets: ['regcred-1', 'regcred-2'],
      }),
    );
    expect(
      (spec.spec as { imagePullSecrets?: Array<{ name: string }> }).imagePullSecrets,
    ).toEqual([{ name: 'regcred-1' }, { name: 'regcred-2' }]);
  });

  it('omits imagePullSecrets when not configured', () => {
    const spec = buildPodSpec('e', baseInput, baseResolved());
    expect(
      (spec.spec as { imagePullSecrets?: unknown }).imagePullSecrets,
    ).toBeUndefined();
  });

  it('labels the pod with sessionId for kubectl filtering', () => {
    const spec = buildPodSpec('f', baseInput, baseResolved());
    expect(spec.metadata.labels['ax.io/session-id']).toBe('sess');
    expect(spec.metadata.labels['app.kubernetes.io/component']).toBe(
      'ax-next-runner',
    );
    // ax.io/plane: execution is the selector both NetworkPolicies key
    // off (host ingress allow + runner egress restrict). Without it the
    // entire k8s network perimeter is a no-op for runner pods.
    expect(spec.metadata.labels['ax.io/plane']).toBe('execution');
  });

  it('carries paranoid git env on the runner container', () => {
    // Phase 3: the sandbox materializes /permanent from a host-streamed
    // baseline bundle and ships per-turn diffs as `git bundle`. To do that
    // it spawns the in-image `git` binary. These env vars are the locked-
    // down rails per design doc Phase 3 / SECURITY.md — they prevent
    // git-init from reading user-global config, refuse remote helpers,
    // and pin commit author/committer to `ax-runner` so the host bundler
    // can verify provenance before applying.
    const spec = buildPodSpec('g', baseInput, baseResolved());
    const env = (
      spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
    ).containers[0]!.env;
    const byName = (n: string) => env.find((e) => e.name === n)?.value;

    expect(byName('GIT_CONFIG_NOSYSTEM')).toBe('1');
    expect(byName('GIT_CONFIG_GLOBAL')).toBe('/dev/null');
    expect(byName('GIT_TERMINAL_PROMPT')).toBe('0');
    expect(byName('HOME')).toBe('/nonexistent');
    expect(byName('GIT_AUTHOR_NAME')).toBe('ax-runner');
    expect(byName('GIT_AUTHOR_EMAIL')).toBe('ax-runner@example.com');
    expect(byName('GIT_COMMITTER_NAME')).toBe('ax-runner');
    expect(byName('GIT_COMMITTER_EMAIL')).toBe('ax-runner@example.com');
  });
});
