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

describe('sandbox-k8s git env', () => {
  it('stamps GIT_TERMINAL_PROMPT=0 so a missing credential fails fast (B)', () => {
    const spec = buildPodSpec('pod-x', baseInput, baseResolved());
    const env = (
      spec.spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> }
    ).containers[0]!.env;
    const entry = env.find((e) => e.name === 'GIT_TERMINAL_PROMPT');
    expect(entry?.value).toBe('0');
  });
});
