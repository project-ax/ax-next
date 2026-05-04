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

  it('uses args (not command) so the image ENTRYPOINT stays PID 1', () => {
    // Regression: switching to `command` here replaces the image's
    // ENTRYPOINT (tini in container/agent/Dockerfile), so orphaned
    // grandchildren of the Claude SDK runner stop being reaped. Args
    // preserve the supervisor; this test pins that contract.
    const spec = buildPodSpec('pod-x', baseInput, baseResolved());
    const container = (
      spec.spec as {
        containers: Array<{ command?: string[]; args?: string[] }>;
      }
    ).containers[0]!;
    expect(container.command).toBeUndefined();
    expect(container.args).toEqual(['node', '/opt/runner.js']);
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

  it('mounts /permanent (workspace) and /ephemeral (scratch) emptyDirs', () => {
    // Phase 3: the legacy single /workspace mount is replaced by two
    // emptyDirs. /permanent holds the git working tree (materialize source,
    // turn-end commit/bundle target). /ephemeral holds caches and scratch
    // (anything not part of the workspace lineage). Splitting them keeps
    // the storage tier bounded by what's actually persisted across turns.
    const spec = buildPodSpec('h', baseInput, baseResolved());
    const containers = (
      spec.spec as {
        containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string }> }>;
      }
    ).containers;
    const mounts = containers[0]!.volumeMounts ?? [];
    expect(mounts.find((m) => m.mountPath === '/permanent')).toBeDefined();
    expect(mounts.find((m) => m.mountPath === '/ephemeral')).toBeDefined();
    // No legacy /workspace mount.
    expect(mounts.find((m) => m.mountPath === '/workspace')).toBeUndefined();

    const volumes = (spec.spec as { volumes?: Array<{ name: string; emptyDir?: object }> })
      .volumes ?? [];
    const permanent = volumes.find((v) => v.name === 'permanent');
    expect(permanent?.emptyDir).toBeDefined();
    const ephemeral = volumes.find((v) => v.name === 'ephemeral');
    expect(ephemeral?.emptyDir).toBeDefined();
    // No legacy `workspace` volume.
    expect(volumes.find((v) => v.name === 'workspace')).toBeUndefined();
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

  // Phase 1a — credential-proxy cross-pod reach (k8s side).
  describe('proxyConfig wiring', () => {
    const proxyInput = {
      ...baseInput,
      proxyConfig: {
        unixSocketPath: '/var/run/ax/proxy.sock',
        caCertPem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
        envMap: {
          ANTHROPIC_API_KEY: 'ax-cred:00000000000000000000000000000000',
        },
      },
    };

    it('stamps AX_PROXY_UNIX_SOCKET, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, and the placeholder envMap when proxyConfig is present', () => {
      // Without these env vars the runner exits at boot with "missing
      // required env: AX_PROXY_ENDPOINT or AX_PROXY_UNIX_SOCKET" — which
      // is exactly how the kind goldenpath broke before this wiring.
      const spec = buildPodSpec('p', proxyInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
      ).containers[0]!.env;
      const byName = (n: string) => env.find((e) => e.name === n)?.value;
      expect(byName('AX_PROXY_UNIX_SOCKET')).toBe('/var/run/ax/proxy.sock');
      expect(byName('NODE_EXTRA_CA_CERTS')).toBe('/var/run/ax/proxy-ca/ca.crt');
      expect(byName('SSL_CERT_FILE')).toBe('/var/run/ax/proxy-ca/ca.crt');
      expect(byName('ANTHROPIC_API_KEY')).toBe(
        'ax-cred:00000000000000000000000000000000',
      );
    });

    it('mounts the proxy socket dir at /var/run/ax via hostPath when proxySocketHostPath is set', () => {
      // The mount is what makes the host pod's Unix socket reachable
      // from the runner pod — without it, the env stamps point at a
      // path that doesn't exist inside the runner.
      const cfg = resolveConfig({
        hostIpcUrl: 'http://test-host:8080',
        proxySocketHostPath: '/var/lib/ax-next-proxy',
      });
      const spec = buildPodSpec('p', proxyInput, cfg);
      const containers = (
        spec.spec as {
          containers: Array<{
            volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
          }>;
          volumes: Array<{ name: string; hostPath?: { path: string; type: string } }>;
        }
      );
      const mount = containers.containers[0]!.volumeMounts.find(
        (m) => m.name === 'proxy-socket',
      );
      // RW (no readOnly): connect(2) to a Unix socket needs write
      // access — a read-only mount silently blocks the runner-side
      // bridge dial. See pod-spec.ts comment for the trade-off.
      expect(mount).toEqual({
        name: 'proxy-socket',
        mountPath: '/var/run/ax',
      });
      const vol = (spec.spec as {
        volumes: Array<{ name: string; hostPath?: { path: string; type: string } }>;
      }).volumes.find((v) => v.name === 'proxy-socket');
      expect(vol?.hostPath).toEqual({
        path: '/var/lib/ax-next-proxy',
        type: 'DirectoryOrCreate',
      });
    });

    it('skips both the mount and the env when proxyConfig is absent (legacy posture)', () => {
      // When @ax/credential-proxy isn't loaded (synthetic preset, tests),
      // the orchestrator never calls proxy:open-session and never threads
      // proxyConfig through. Pod-spec must NOT add the env stamps in
      // that case — they'd point at paths that don't exist.
      const spec = buildPodSpec('p', baseInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string }> }> }
      ).containers[0]!.env;
      expect(env.find((e) => e.name === 'AX_PROXY_UNIX_SOCKET')).toBeUndefined();
      expect(env.find((e) => e.name === 'NODE_EXTRA_CA_CERTS')).toBeUndefined();
      const vols = (spec.spec as { volumes: Array<{ name: string }> }).volumes;
      expect(vols.find((v) => v.name === 'proxy-socket')).toBeUndefined();
    });
  });
});
