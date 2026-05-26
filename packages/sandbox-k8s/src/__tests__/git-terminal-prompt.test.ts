import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../config.js';
import { buildPodSpec } from '../pod-spec.js';

// ---------------------------------------------------------------------------
// Regression guard: GIT_TERMINAL_PROMPT=0 must be present in the runner pod
// env for fail-fast git auth (B). Without it, git prompts for credentials
// interactively when Basic-auth fails, hanging the runner indefinitely.
// This test locks in the invariant so an accidental removal fails CI.
// ---------------------------------------------------------------------------

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

function podEnv(spec: ReturnType<typeof buildPodSpec>): Array<{ name: string; value: string }> {
  return (
    spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
  ).containers[0]!.env;
}

const PH = 'ax-cred:0123456789abcdef0123456789abcdef';

describe('sandbox-k8s git env', () => {
  it('stamps GIT_TERMINAL_PROMPT=0 so a missing credential fails fast (B)', () => {
    const spec = buildPodSpec('pod-x', baseInput, baseResolved());
    const env = podEnv(spec);
    const entry = env.find((e) => e.name === 'GIT_TERMINAL_PROMPT');
    expect(entry?.value).toBe('0');
  });

  // -------------------------------------------------------------------------
  // TASK-14 (CLI-1 part 2) regression: a credentialed skill's allowedHost must
  // produce a git `url.<base>.insteadOf` rewrite carrying the proxy placeholder
  // so `git clone https://<host>/...` authenticates. The original bug was the
  // ABSENCE of any such wiring: git had GIT_TOKEN=ax-cred:<hex> in env but never
  // sent it (`fatal: could not read Username ... terminal prompts disabled`),
  // so the egress audit showed credentialInjected:false (git never sent a
  // request). These tests would have caught that — the rewrite must be stamped,
  // and exactly once with a single GIT_CONFIG_COUNT.
  // -------------------------------------------------------------------------
  describe('skill git-credential wiring', () => {
    const proxyConfig = {
      unixSocketPath: '/var/run/ax/proxy.sock',
      caCertPem: 'PEM',
      envMap: { GIT_TOKEN: PH },
    };
    const credentialedSkill = {
      id: 'gitclonetest',
      files: [{ path: 'SKILL.md', contents: '---\nname: gitclonetest\n---\nbody' }],
      allowedHosts: ['github.com'],
      credentials: [{ slot: 'GIT_TOKEN' as const, kind: 'api-key' as const }],
    };

    it('stamps a host-scoped insteadOf rewrite carrying the placeholder', () => {
      const spec = buildPodSpec(
        'pod-x',
        { ...baseInput, proxyConfig, installedSkills: [credentialedSkill] },
        baseResolved(),
      );
      const env = podEnv(spec);
      const keys = env.filter((e) => e.name.startsWith('GIT_CONFIG_KEY_')).map((e) => e.value);
      const values = env.filter((e) => e.name.startsWith('GIT_CONFIG_VALUE_')).map((e) => e.value);
      expect(keys).toContain(`url.https://x-access-token:${PH}@github.com/.insteadOf`);
      expect(values).toContain('https://github.com/');
      // The placeholder — not a real secret — is what lands in the config (I1).
      const credKey = keys.find((k) => k.includes('insteadOf'))!;
      expect(credKey).toContain(PH);
    });

    it('preserves the safe.directory entry and sets exactly one GIT_CONFIG_COUNT', () => {
      const spec = buildPodSpec(
        'pod-x',
        { ...baseInput, proxyConfig, installedSkills: [credentialedSkill] },
        baseResolved(),
      );
      const env = podEnv(spec);
      const counts = env.filter((e) => e.name === 'GIT_CONFIG_COUNT');
      expect(counts).toHaveLength(1); // no duplicate count entry
      expect(counts[0]!.value).toBe('2'); // index 0 safe.directory + index 1 cred
      // index 0 is still safe.directory (untouched).
      expect(env.find((e) => e.name === 'GIT_CONFIG_KEY_0')?.value).toBe('safe.directory');
    });

    it('stamps NO insteadOf rewrite when the skill declares no credentials', () => {
      const spec = buildPodSpec(
        'pod-x',
        {
          ...baseInput,
          proxyConfig,
          installedSkills: [
            { id: 'plain', files: [{ path: 'SKILL.md', contents: '---\nname: plain\n---\nb' }], allowedHosts: ['example.com'], credentials: [] },
          ],
        },
        baseResolved(),
      );
      const env = podEnv(spec);
      expect(env.filter((e) => e.name.startsWith('GIT_CONFIG_KEY_')).map((e) => e.value)).not.toContain(
        'url.https://x-access-token:@example.com/.insteadOf',
      );
      // Only the safe.directory entry remains → count stays 1.
      expect(env.find((e) => e.name === 'GIT_CONFIG_COUNT')?.value).toBe('1');
    });

    it('stamps NO insteadOf rewrite when there is no proxyConfig', () => {
      const spec = buildPodSpec(
        'pod-x',
        { ...baseInput, installedSkills: [credentialedSkill] },
        baseResolved(),
      );
      const env = podEnv(spec);
      const keys = env.filter((e) => e.name.startsWith('GIT_CONFIG_KEY_')).map((e) => e.value);
      expect(keys.some((k) => k.includes('insteadOf'))).toBe(false);
      expect(env.find((e) => e.name === 'GIT_CONFIG_COUNT')?.value).toBe('1');
    });
  });
});
