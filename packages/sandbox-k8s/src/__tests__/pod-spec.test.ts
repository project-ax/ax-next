import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import { buildPodSpec, RUNNER_PORT } from '../pod-spec.js';

const baseInput = {
  sessionId: 'sess',
  workspaceRoot: '/tmp/ws',
  runnerBinary: '/opt/runner.js',
  authToken: 'tok',
};

describe('buildPodSpec', () => {
  it('emits the locked-down securityContext defaults', () => {
    const spec = buildPodSpec('pod-x', baseInput, resolveConfig());
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

  it('exposes containerPort=7777 named "ipc"', () => {
    const spec = buildPodSpec('pod-x', baseInput, resolveConfig());
    const ports = (
      spec.spec as {
        containers: Array<{ ports: Array<{ containerPort: number; name: string }> }>;
      }
    ).containers[0]!.ports;
    expect(ports).toEqual([{ containerPort: RUNNER_PORT, name: 'ipc' }]);
  });

  it('respects activeDeadlineSeconds config (default 3600, override 600)', () => {
    const dflt = buildPodSpec('a', baseInput, resolveConfig());
    expect((dflt.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds).toBe(
      3600,
    );
    const custom = buildPodSpec(
      'b',
      baseInput,
      resolveConfig({ activeDeadlineSeconds: 600 }),
    );
    expect(
      (custom.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds,
    ).toBe(600);
  });

  it('omits runtimeClassName when configured to empty string (gVisor opt-out)', () => {
    const spec = buildPodSpec(
      'c',
      baseInput,
      resolveConfig({ runtimeClassName: '' }),
    );
    expect(
      (spec.spec as { runtimeClassName?: string }).runtimeClassName,
    ).toBeUndefined();
  });

  it('threads imagePullSecrets through when provided', () => {
    const spec = buildPodSpec(
      'd',
      baseInput,
      resolveConfig({ imagePullSecrets: ['regcred-1', 'regcred-2'] }),
    );
    expect(
      (spec.spec as { imagePullSecrets?: Array<{ name: string }> }).imagePullSecrets,
    ).toEqual([{ name: 'regcred-1' }, { name: 'regcred-2' }]);
  });

  it('omits imagePullSecrets when not configured', () => {
    const spec = buildPodSpec('e', baseInput, resolveConfig());
    expect(
      (spec.spec as { imagePullSecrets?: unknown }).imagePullSecrets,
    ).toBeUndefined();
  });

  it('labels the pod with sessionId for kubectl filtering', () => {
    const spec = buildPodSpec('f', baseInput, resolveConfig());
    expect(spec.metadata.labels['ax.io/session-id']).toBe('sess');
    expect(spec.metadata.labels['app.kubernetes.io/component']).toBe(
      'ax-next-runner',
    );
  });
});
