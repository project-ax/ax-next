import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BootstrapAssignmentSchema, POD_SCRATCH_ROOT, allowedBootstrapEnv, parseServiceForwards } from '../bootstrap.js';
const assignment = (extra: Record<string, string> = {}) => ({ version: 1, assignmentId: randomUUID(),
  instanceId: randomUUID(), expiresAt: Date.now() + 1000, env: { AX_SESSION_ID: 's', AX_AUTH_TOKEN: 'token',
    AX_RUNNER_ENDPOINT: 'http://host:80', AX_PROXY_ENDPOINT: 'http://proxy:8888',
    AX_PROXY_TOKEN: 'b'.repeat(32), ...extra } });
describe('bootstrap process capabilities', () => {
  it('accepts the host-scoped credential rewrite for a custom HTTPS port', () => {
    expect(BootstrapAssignmentSchema.safeParse(assignment({ GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:ax-cred:test@git.internal:8443/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://git.internal:8443/' })).success).toBe(true);
  });
  it.each(['NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'AX_RUNNER_BINARY', 'PYTHONPATH'])('rejects %s', name => {
    expect(BootstrapAssignmentSchema.safeParse(assignment({ [name]: 'ax-cred:test' })).success).toBe(false);
  });
  it('rejects loading CA or configuration files from tenant storage', () => {
    expect(BootstrapAssignmentSchema.safeParse(assignment({ NODE_EXTRA_CA_CERTS: '/files/ca.pem' })).success).toBe(false);
    expect(BootstrapAssignmentSchema.safeParse(assignment({ GIT_CONFIG_GLOBAL: '/files/gitconfig' })).success).toBe(false);
  });
  it('accepts the baseline assignment (so the rejections below are about the token)', () => {
    expect(BootstrapAssignmentSchema.safeParse(assignment()).success).toBe(true);
  });
  it('bootstrap allows AX_INBOX_IDLE_MS and AX_TURN_LIMIT_MS', () => {
    expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_INBOX_IDLE_MS: '2100000', AX_TURN_LIMIT_MS: '7200000' })).success).toBe(true);
  });
  it.each([['AX_INBOX_IDLE_MS', ''], ['AX_INBOX_IDLE_MS', 'soon'], ['AX_TURN_LIMIT_MS', '-1'], ['AX_TURN_LIMIT_MS', '0'], ['AX_TURN_LIMIT_MS', '1e9'], ['AX_INBOX_IDLE_MS', '9'.repeat(16)]])(
    'rejects %s=%j (digits only)', (name, value) => {
      expect(allowedBootstrapEnv(name, value)).toBe(false);
    });
  it('AX_SERVICE_FORWARDS is not on the bootstrap allowlist (pods with services skip the warm pool)', () => {
    const v = JSON.stringify([{ published: 47017, target: 27017 }]);
    expect(allowedBootstrapEnv('AX_SERVICE_FORWARDS', v)).toBe(false);
    expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_SERVICE_FORWARDS: v })).success).toBe(false);
  });
  describe('parseServiceForwards', () => {
    it('accepts a valid map and the empty array', () => {
      expect(parseServiceForwards('[{"published":47017,"target":27017}]')).toEqual([{ published: 47017, target: 27017 }]);
      expect(parseServiceForwards('[]')).toEqual([]);
      const sixtyFour = Array.from({ length: 64 }, (_, i) => ({ published: 10000 + i, target: 5432 }));
      expect(parseServiceForwards(JSON.stringify(sixtyFour))).toHaveLength(64);
    });
    it.each([
      ['not json', 'nope'],
      ['an object', '{"published":1,"target":2}'],
      ['a string port', '[{"published":"1","target":2}]'],
      ['a float', '[{"published":1.5,"target":2}]'],
      ['port 0', '[{"published":0,"target":2}]'],
      ['port 65536', '[{"published":1,"target":65536}]'],
      ['an extra key', '[{"published":1,"target":2,"host":"evil"}]'],
      ['a missing key', '[{"published":1}]'],
      ['a bare number', '[1]'],
      ['65 pairs', JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ published: 10000 + i, target: 9 })))],
      ['too long', '[' + ' '.repeat(5000) + ']'],
      ['a self-forward', '[{"published":9000,"target":9000}]'],
      ['a cycle', '[{"published":9000,"target":9001},{"published":9001,"target":9000}]'],
      ['a chain (target is another published port)', '[{"published":9000,"target":9001},{"published":9001,"target":9002}]'],
    ])('rejects %s', (_l, v) => {
      expect(parseServiceForwards(v)).toBeNull();
    });
  });
  it('rejects an assignment without AX_PROXY_TOKEN (TASK-784)', () => {
    const a = assignment();
    delete (a.env as Record<string, string>).AX_PROXY_TOKEN;
    expect(BootstrapAssignmentSchema.safeParse(a).success).toBe(false);
  });
  it.each(['', 'not-hex', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)])(
    'rejects a malformed AX_PROXY_TOKEN %j (TASK-784)',
    (token) => {
      expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_PROXY_TOKEN: token })).success).toBe(false);
    },
  );
  // TASK-994 — sandbox-k8s stamps AX_TRANSCRIPTS_ROOT on every runner pod, and a
  // pooled runner takes its env only from this assignment, so the name must be
  // listed. Only its one pod-private value is accepted: anything else could put
  // the SDK's transcripts in the agent's durable files or on the tmpfs HOME.
  it('accepts the pinned AX_TRANSCRIPTS_ROOT (TASK-994)', () => {
    expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_TRANSCRIPTS_ROOT: '/tmp/transcripts' })).success).toBe(true);
  });
  it.each(['/files/transcripts', '/home/runner/.ax/session/projects', '/tmp/transcripts/../../files'])(
    'rejects AX_TRANSCRIPTS_ROOT %j (TASK-994)',
    (value) => {
      expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_TRANSCRIPTS_ROOT: value })).success).toBe(false);
    },
  );
  // TASK-995 — the k8s scratch root is the pod's disk /tmp (it used to be a
  // separate emptyDir). A pooled runner learns it only from this assignment,
  // and puts uploads, transcripts, caches and venvs under it, so only the one
  // pod-private value is accepted: anything else could put that scratch in
  // the agent's durable files or on the tmpfs HOME.
  it('accepts AX_EPHEMERAL_ROOT=/tmp, the exported pod scratch root (TASK-995)', () => {
    expect(allowedBootstrapEnv('AX_EPHEMERAL_ROOT', '/tmp')).toBe(true);
    expect(allowedBootstrapEnv('AX_EPHEMERAL_ROOT', POD_SCRATCH_ROOT)).toBe(true);
    expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_EPHEMERAL_ROOT: '/tmp' })).success).toBe(true);
  });
  it.each(['/ephemeral', '/files', '/tmp/', '/tmp/uploads', '/home/runner'])(
    'rejects AX_EPHEMERAL_ROOT %j (TASK-995)',
    (value) => {
      expect(allowedBootstrapEnv('AX_EPHEMERAL_ROOT', value)).toBe(false);
      expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_EPHEMERAL_ROOT: value })).success).toBe(false);
    },
  );
  // The git working tree is gone and the runner reads no workspace root, so
  // the retired name is not a control variable any more: the generic AX_ rule
  // refuses it with any value, rather than carrying it into a warm runner.
  it.each(['/agent', '/tmp', '/files'])('rejects the retired AX_WORKSPACE_ROOT=%j (TASK-995)', (value) => {
    expect(allowedBootstrapEnv('AX_WORKSPACE_ROOT', value)).toBe(false);
    expect(BootstrapAssignmentSchema.safeParse(assignment({ AX_WORKSPACE_ROOT: value })).success).toBe(false);
  });
});
