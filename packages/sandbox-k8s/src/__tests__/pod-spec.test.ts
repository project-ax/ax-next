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

  it('respects activeDeadlineSeconds config (default 21600, override 600)', () => {
    const dflt = buildPodSpec('a', baseInput, baseResolved());
    expect((dflt.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds).toBe(
      21600,
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

  it('sanitizes the session-id label for k8s constraints (regression for #83)', () => {
    // The routines plugin builds sessionIds like
    // `routine-<agentId>-<routinePath>`. `/` is invalid in label values,
    // and these strings routinely blow the 63-byte cap. Before #83's
    // fix, pod create failed 422. The original sessionId must still
    // land in AX_SESSION_ID — only the label surface gets sanitized.
    const longRoutineSessionId =
      'routine-agt_RpigE1XjEzmgwGHB34QcHA-.ax/routines/fixed-1778930880.md';
    const spec = buildPodSpec(
      'pod-x',
      { ...baseInput, sessionId: longRoutineSessionId },
      baseResolved(),
    );
    const label = spec.metadata.labels['ax.io/session-id'];
    expect(label).toBeDefined();
    // Constraint 1: ≤ 63 bytes.
    expect(Buffer.byteLength(label!, 'utf8')).toBeLessThanOrEqual(63);
    // Constraint 2: matches the k8s label-value regex.
    expect(label).toMatch(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/);
    // Constraint 3: no `/` chars (the original failure mode).
    expect(label).not.toContain('/');
    // The AX_SESSION_ID env keeps the FULL original sessionId — runner
    // identity, transcript correlation, and logs all key off that value
    // and must not see the truncated/sanitized form.
    const env = (
      spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
    ).containers[0]!.env;
    const sid = env.find((e) => e.name === 'AX_SESSION_ID')?.value;
    expect(sid).toBe(longRoutineSessionId);
  });

  it('sanitization is deterministic and collision-resistant on long inputs', () => {
    // Two sessionIds that share a long prefix but differ in the tail
    // get DIFFERENT labels. Without a hash suffix, naive truncation
    // would collide here and the same label would attach to pods from
    // distinct routines.
    const prefix = 'routine-agt_RpigE1XjEzmgwGHB34QcHA-.ax/routines/very-long-routine-name';
    const a = buildPodSpec(
      'pa',
      { ...baseInput, sessionId: `${prefix}-A.md` },
      baseResolved(),
    );
    const b = buildPodSpec(
      'pb',
      { ...baseInput, sessionId: `${prefix}-B.md` },
      baseResolved(),
    );
    const labelA = a.metadata.labels['ax.io/session-id'];
    const labelB = b.metadata.labels['ax.io/session-id'];
    expect(labelA).not.toBe(labelB);
    // Deterministic: rebuilding the same sessionId gives the same label.
    const aAgain = buildPodSpec(
      'pa2',
      { ...baseInput, sessionId: `${prefix}-A.md` },
      baseResolved(),
    );
    expect(aAgain.metadata.labels['ax.io/session-id']).toBe(labelA);
  });

  it('leaves short, already-valid sessionIds untouched', () => {
    // The common case (UUIDs, short ids) must round-trip through
    // sanitizeLabel without modification.
    const spec = buildPodSpec(
      'p',
      { ...baseInput, sessionId: 'session-01HW1ZA9TQK4N6B8X9V2YZ' },
      baseResolved(),
    );
    expect(spec.metadata.labels['ax.io/session-id']).toBe(
      'session-01HW1ZA9TQK4N6B8X9V2YZ',
    );
  });

  it('falls back to sha1 prefix when sanitization leaves no alphanumerics', () => {
    // Defensive: a sessionId of all-non-alphanumerics would slugify to a
    // string that fails the k8s `[A-Za-z0-9]` start/end constraint. The
    // helper returns a sha1[:16] in that case so the label is still
    // valid and deterministic (instead of empty, which the API rejects).
    const spec = buildPodSpec(
      'p1',
      { ...baseInput, sessionId: '/////' },
      baseResolved(),
    );
    const label = spec.metadata.labels['ax.io/session-id'];
    expect(label).toMatch(/^[a-f0-9]{16}$/);
    expect(label).toMatch(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/);
  });

  it('passes through inputs exactly at the 63-byte cap, hashes one byte over', () => {
    // Boundary check: 63 alphanumerics round-trips verbatim; 64 forces
    // the truncate+hash branch. Without this, an off-by-one in
    // K8S_LABEL_MAX_BYTES would only surface in production.
    const sixtyThree = 'a'.repeat(63);
    const sixtyFour = 'a'.repeat(64);
    const fits = buildPodSpec(
      'pcap',
      { ...baseInput, sessionId: sixtyThree },
      baseResolved(),
    );
    expect(fits.metadata.labels['ax.io/session-id']).toBe(sixtyThree);

    const over = buildPodSpec(
      'pover',
      { ...baseInput, sessionId: sixtyFour },
      baseResolved(),
    );
    const overLabel = over.metadata.labels['ax.io/session-id'];
    expect(Buffer.byteLength(overLabel!, 'utf8')).toBeLessThanOrEqual(63);
    expect(overLabel).toMatch(/^a{54}-[a-f0-9]{8}$/);
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

    // The mount alone is inert — the runner only wires the scratch tier
    // into the SDK (additionalDirectories + system-prompt note) when
    // AX_EPHEMERAL_ROOT is stamped. Assert the env points at the mount so
    // the two halves can't drift apart.
    const env = (
      spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
    ).containers[0]!.env;
    expect(env.find((e) => e.name === 'AX_EPHEMERAL_ROOT')?.value).toBe(
      '/ephemeral',
    );
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
    // HOME is now /home/runner (a writable emptyDir Memory mount) per
    // I-P0-3 — see the skill-install Phase 0 describe block below for
    // the rationale and the volume/mount/env-stamp assertions.
    expect(byName('HOME')).toBe('/home/runner');
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

    it('stamps GIT_SSL_CAINFO at the proxy CA path so git trusts the MITM cert (TASK-12)', () => {
      // TASK-12 regression: NODE_EXTRA_CA_CERTS / SSL_CERT_FILE only steer
      // Node's TLS (the SDK's undici fetch). The `git` binary the Bash tool
      // spawns is libcurl/OpenSSL-backed and reads NEITHER of those — it
      // verifies the proxy's MITM cert against GIT_SSL_CAINFO (or
      // http.sslCAInfo config). Without this stamp, `git clone` over the
      // credential proxy dies with `SSL certificate problem: unable to get
      // local issuer certificate`, which is exactly the CLI-1 walk-fail.
      const spec = buildPodSpec('p', proxyInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
      ).containers[0]!.env;
      const byName = (n: string) => env.find((e) => e.name === n)?.value;
      expect(byName('GIT_SSL_CAINFO')).toBe('/var/run/ax/proxy-ca/ca.crt');
    });

    it('does NOT stamp GIT_SSL_CAINFO when proxyConfig is absent (no MITM, no extra CA)', () => {
      // Outside a proxied session git talks to the in-cluster workspace git
      // server over plain HTTP / its own trust store — pinning a CA path
      // that doesn't exist would break it. Only stamp when the proxy is on.
      const spec = buildPodSpec('p', baseInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string }> }> }
      ).containers[0]!.env;
      expect(env.find((e) => e.name === 'GIT_SSL_CAINFO')).toBeUndefined();
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

  // Phase 0 of skill-install: HOME + CLAUDE_CONFIG_DIR + init-container
  // skills scaffold (I-P0-3/4). K8s sibling of the sandbox-subprocess
  // fix in 87a8c2c8 + 5b3d1828.
  describe('skill-install Phase 0 (HOME + skills scaffold)', () => {
    it('mounts an emptyDir at /home/runner with HOME pointing at it', () => {
      // The SDK's `'user'` setting source walks `$HOME/.claude/skills/`. We
      // can't let it land on the host node's /root or whatever the image
      // ships — that's a per-pod tmpfs (Memory) so it's ephemeral, isolated
      // per session, and writable despite the rest of rootfs being RO.
      const spec = buildPodSpec('pod-home', baseInput, baseResolved());
      const podSpec = spec.spec as {
        containers: Array<{
          env: Array<{ name: string; value: string }>;
          volumeMounts: Array<{ name: string; mountPath: string }>;
        }>;
        volumes: Array<{ name: string; emptyDir?: { medium?: string } }>;
      };
      const homeVolume = podSpec.volumes.find((v) => v.name === 'home');
      expect(homeVolume).toBeDefined();
      expect(homeVolume!.emptyDir).toEqual({ medium: 'Memory' });

      const main = podSpec.containers[0]!;
      const homeMount = main.volumeMounts.find((m) => m.mountPath === '/home/runner');
      expect(homeMount?.name).toBe('home');

      const homeEnv = main.env.find((e) => e.name === 'HOME');
      expect(homeEnv?.value).toBe('/home/runner');
    });

    it('sets CLAUDE_CONFIG_DIR to /home/runner/.ax/session', () => {
      // The SDK's `'project'` setting source reads
      // $CLAUDE_CONFIG_DIR/skills/ — point it at the per-session HOME
      // subdir so Phase 1 (skill materialization) writes there.
      const spec = buildPodSpec('pod-ccd', baseInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
      ).containers[0]!.env;
      const ccd = env.find((e) => e.name === 'CLAUDE_CONFIG_DIR');
      expect(ccd?.value).toBe('/home/runner/.ax/session');
    });

    it('includes an init container that scaffolds the user-source skills dir', () => {
      // The init container creates the empty $CLAUDE_CONFIG_DIR/skills dir
      // the SDK's `'user'` source walks at startup. The matching
      // `.claude/skills → ../.ax/skills` symlink (`'project'` source)
      // is laid down by the runner AFTER `materializeWorkspace` clones
      // the baseline bundle — see
      // `git-workspace.ts#scaffoldWorkspaceSkillSurface`. Doing it here
      // would non-empty `/permanent` before the runner's `git clone`
      // and crash the runner with "destination path '/permanent'
      // already exists and is not an empty directory."
      const spec = buildPodSpec('pod-init', baseInput, baseResolved());
      const init = (
        spec.spec as {
          initContainers?: Array<{
            name: string;
            command?: string[];
            args?: string[];
            volumeMounts?: Array<{ name: string; mountPath: string }>;
          }>;
        }
      ).initContainers ?? [];
      const scaffold = init.find((c) => c.name === 'sdk-scaffold');
      expect(scaffold).toBeDefined();

      const mounts = (scaffold!.volumeMounts ?? []).map((m) => m.name);
      expect(mounts).toContain('home');
      // Regression guard: the init container MUST NOT mount /permanent.
      // Mounting it here lets a future maintainer reintroduce the
      // pre-clone scaffold that broke chat post-Phase-0.
      expect(mounts).not.toContain('permanent');

      const cmdJoined = (scaffold!.command ?? []).concat(scaffold!.args ?? []).join(' ');
      expect(cmdJoined).toContain('/home/runner/.ax/session/skills');
      // Regression guard: no writes to /permanent here.
      expect(cmdJoined).not.toMatch(/\/permanent/);
    });

    it('init container runs as the same non-root user as the main container', () => {
      // Init containers run BEFORE the main container with their own
      // security context. If we don't pin them to the same uid + locked
      // down caps, an attacker who breaks into the init step (e.g. via
      // a future image-supply-chain compromise) escalates beyond what
      // the main container can do. Match the main container exactly.
      const spec = buildPodSpec('pod-sec', baseInput, baseResolved());
      const podSpec = spec.spec as {
        containers: Array<{ securityContext: Record<string, unknown> }>;
        initContainers: Array<{ name: string; securityContext: Record<string, unknown> }>;
      };
      const main = podSpec.containers[0]!;
      const init = podSpec.initContainers.find((c) => c.name === 'sdk-scaffold')!;
      expect(init.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: main.securityContext.runAsUser,
        runAsGroup: main.securityContext.runAsGroup,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
    });

    it('init container uses the same image as the main runner container', () => {
      // Same-image saves a second image pull on cold starts (the runner
      // image is already cached when the init step runs). Introducing a
      // separate busybox dep would also widen the supply-chain surface
      // for what is effectively a few `mkdir`/`ln` calls.
      const cfg = resolveConfig({
        hostIpcUrl: 'http://test:80',
      });
      const spec = buildPodSpec('pod-img', baseInput, cfg);
      const podSpec = spec.spec as {
        containers: Array<{ image: string }>;
        initContainers: Array<{ name: string; image: string }>;
      };
      const main = podSpec.containers[0]!;
      const init = podSpec.initContainers.find((c) => c.name === 'sdk-scaffold')!;
      expect(init.image).toBe(main.image);
    });

    it('init container env is narrowed to HOME only (no inherited GIT_* vars)', () => {
      // Invariant #5 (capabilities minimized): the init step runs only
      // mkdir + ln, neither of which reads any GIT_* var or expands
      // $HOME (the snippet uses absolute paths everywhere). Inheriting
      // the full 7-var gitParanoidEnv would be harmless but soft-violate
      // capabilities-minimized. HOME stays — it's documentation that the
      // init container knows where HOME lives, and load-bearing if a
      // future maintainer references `$HOME/...` in the snippet.
      const spec = buildPodSpec('pod-narrow-env', baseInput, baseResolved());
      const podSpec = spec.spec as {
        initContainers: Array<{
          name: string;
          env: Array<{ name: string; value: string }>;
        }>;
      };
      const init = podSpec.initContainers.find((c) => c.name === 'sdk-scaffold')!;
      expect(init.env).toEqual([{ name: 'HOME', value: '/home/runner' }]);
      // Specifically, none of the GIT_* vars should appear here.
      for (const name of [
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_TERMINAL_PROMPT',
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ]) {
        expect(init.env.find((e) => e.name === name)).toBeUndefined();
      }
    });
  });

  // Phase 1 (skill-install): AX_INSTALLED_SKILLS_JSON env var wiring (I-P1-3).
  //
  // K8s pods can't have the host write files into them at create-time, so
  // we pass installed-skill content as the env var AX_INSTALLED_SKILLS_JSON
  // (JSON-encoded array, 256 KiB cap). The runner reads it from process.env
  // in main() BEFORE the SDK spawns and materializes each skill at
  // $CLAUDE_CONFIG_DIR/skills/<id>/SKILL.md, then chmods the parent dir to
  // 0555. The Phase 0 init container created the empty dir; Phase 1's
  // runner-side step fills + locks it.
  describe('AX_INSTALLED_SKILLS_JSON wiring (I-P1-3)', () => {
    it('encodes installedSkills files into AX_INSTALLED_SKILLS_JSON', () => {
      const spec = buildPodSpec(
        'pod-skills',
        {
          ...baseInput,
          installedSkills: [
            {
              id: 'github',
              files: [
                { path: 'SKILL.md', contents: '---\nname: github\ndescription: x\n---\nBody' },
                { path: 'scripts/a.py', contents: 'print(1)' },
              ],
            },
          ],
        },
        baseResolved(),
      );
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
      ).containers[0]!.env;
      const entry = env.find((e) => e.name === 'AX_INSTALLED_SKILLS_JSON');
      expect(entry).toBeDefined();
      const parsed = JSON.parse(entry!.value) as Array<{
        id: string;
        files: Array<{ path: string; contents: string }>;
      }>;
      expect(parsed[0]!.id).toBe('github');
      expect(parsed[0]!.files).toEqual([
        { path: 'SKILL.md', contents: '---\nname: github\ndescription: x\n---\nBody' },
        { path: 'scripts/a.py', contents: 'print(1)' },
      ]);
    });

    it('does NOT stamp AX_INSTALLED_SKILLS_JSON when installedSkills is absent', () => {
      const spec = buildPodSpec('pod-no-skills', baseInput, baseResolved());
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string }> }> }
      ).containers[0]!.env;
      expect(env.find((e) => e.name === 'AX_INSTALLED_SKILLS_JSON')).toBeUndefined();
    });

    it('does NOT stamp AX_INSTALLED_SKILLS_JSON when installedSkills is empty', () => {
      const spec = buildPodSpec(
        'pod-empty-skills',
        { ...baseInput, installedSkills: [] },
        baseResolved(),
      );
      const env = (
        spec.spec as { containers: Array<{ env: Array<{ name: string }> }> }
      ).containers[0]!.env;
      expect(env.find((e) => e.name === 'AX_INSTALLED_SKILLS_JSON')).toBeUndefined();
    });

    it('throws when the total installedSkills payload exceeds 768 KiB', () => {
      // A bundle is a file tree (bigger than a single SKILL.md string), so the
      // env-var transport cap is 768 KiB. The combined JSON must still fit.
      const hugeContents = 'x'.repeat(800 * 1024); // 800 KiB > 768 KiB cap
      expect(() =>
        buildPodSpec(
          'pod-huge',
          {
            ...baseInput,
            installedSkills: [
              { id: 'giant', files: [{ path: 'SKILL.md', contents: hugeContents }] },
            ],
          },
          baseResolved(),
        ),
      ).toThrow(/over 768 KiB/);
    });
  });
});
