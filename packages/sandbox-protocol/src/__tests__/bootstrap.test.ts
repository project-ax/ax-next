import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BootstrapAssignmentSchema } from '../bootstrap.js';
const assignment = (extra: Record<string, string> = {}) => ({ version: 1, assignmentId: randomUUID(),
  instanceId: randomUUID(), expiresAt: Date.now() + 1000, env: { AX_SESSION_ID: 's', AX_AUTH_TOKEN: 'token',
    AX_RUNNER_ENDPOINT: 'http://host:80', AX_PROXY_ENDPOINT: 'http://proxy:8888', ...extra } });
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
});
