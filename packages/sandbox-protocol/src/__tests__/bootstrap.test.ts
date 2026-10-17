import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BootstrapAssignmentSchema } from '../bootstrap.js';
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
  // W2 §3.8.1 — pooled sessions late-bind shared folders under /shared/<id>.
  describe('AX_SHARED_FOLDERS (W2 §3.8.1)', () => {
    const folder = (id: string, readOnly = false, path = `/shared/${id}`) => ({ id, path, readOnly });
    const parses = (value: string): boolean =>
      BootstrapAssignmentSchema.safeParse(assignment({ AX_SHARED_FOLDERS: value })).success;
    const parsesList = (list: unknown): boolean => parses(JSON.stringify(list));

    it('accepts an assignment without AX_SHARED_FOLDERS', () => {
      expect(BootstrapAssignmentSchema.safeParse(assignment()).success).toBe(true);
    });

    it('accepts a one-folder value', () => {
      expect(parsesList([folder('sf_a')])).toBe(true);
    });

    it('accepts a two-folder value', () => {
      expect(parsesList([folder('sf_a'), folder('sf_b-C_9')])).toBe(true);
    });

    it('accepts an editor (readOnly false) and a viewer (readOnly true)', () => {
      expect(parsesList([folder('sf_edit', false), folder('sf_view', true)])).toBe(true);
    });

    it('accepts an empty list', () => {
      expect(parsesList([])).toBe(true);
    });

    it('accepts exactly 16 folders', () => {
      expect(parsesList(Array.from({ length: 16 }, (_, i) => folder(`sf_${i}`)))).toBe(true);
    });

    it('rejects 17 folders', () => {
      expect(parsesList(Array.from({ length: 17 }, (_, i) => folder(`sf_${i}`)))).toBe(false);
    });

    it('rejects a value that is not JSON', () => {
      expect(parses('not json')).toBe(false);
      expect(parses('')).toBe(false);
      expect(parses('[{"id":')).toBe(false);
    });

    it.each([
      ['an object', { id: 'sf_a', path: '/shared/sf_a', readOnly: false }],
      ['a string', 'sf_a'],
      ['a number', 1],
      ['null', null],
      ['true', true],
    ])('rejects JSON that is %s, not an array', (_label, value) => {
      expect(parsesList(value)).toBe(false);
    });

    it.each([
      ['null', null],
      ['a string', 'sf_a'],
      ['an array', []],
      ['a number', 1],
    ])('rejects an entry that is %s, not an object', (_label, entry) => {
      expect(parsesList([entry])).toBe(false);
    });

    it('rejects an entry with an extra key', () => {
      expect(parsesList([{ ...folder('sf_a'), mode: 'rw' }])).toBe(false);
    });

    it.each(['id', 'path', 'readOnly'])('rejects an entry missing %s', (key) => {
      const entry: Record<string, unknown> = { ...folder('sf_a') };
      delete entry[key];
      expect(parsesList([entry])).toBe(false);
    });

    it.each(['.shared', 'sf_a/b', '../x', 'sf_', 'sf_a.b', 'sf_a\\b', '', 'a'])(
      'rejects the bad id %j',
      (id) => {
        // Pair the bad id with the path it would imply, so only the id is at fault.
        expect(parsesList([folder(id)])).toBe(false);
      },
    );

    it('rejects a non-string id', () => {
      expect(parsesList([{ id: 1, path: '/shared/1', readOnly: false }])).toBe(false);
    });

    it.each([
      ['/files', 'sf_a', '/files'],
      ['another folder\'s path', 'sf_a', '/shared/sf_other'],
      ['a trailing slash', 'sf_a', '/shared/sf_a/'],
      ['a dot-dot suffix', 'sf_a', '/shared/sf_a/..'],
      ['a relative path', 'sf_a', 'shared/sf_a'],
      ['an empty path', 'sf_a', ''],
      ['the shared root', 'sf_a', '/shared'],
      ['a double slash', 'sf_a', '/shared//sf_a'],
    ])('rejects a path that is %s', (_label, id, path) => {
      expect(parsesList([folder(id, false, path)])).toBe(false);
    });

    it('rejects a non-string path', () => {
      expect(parsesList([{ id: 'sf_a', path: 1, readOnly: false }])).toBe(false);
    });

    it.each(['true', 'false', 'yes', 0, 1, null])('rejects readOnly as %j', (readOnly) => {
      expect(parsesList([{ id: 'sf_a', path: '/shared/sf_a', readOnly }])).toBe(false);
    });

    it('rejects duplicate ids', () => {
      expect(parsesList([folder('sf_a'), folder('sf_a', true)])).toBe(false);
    });

    it('fails the whole assignment when one entry of several is bad', () => {
      expect(parsesList([folder('sf_a'), folder('sf_b', false, '/files')])).toBe(false);
    });

    it('keeps the 256 KiB per-value cap', () => {
      // A syntactically valid list can never be that big (16 entries), so
      // pad with JSON whitespace: still rejected, by size.
      const padded = `${JSON.stringify([folder('sf_a')])}${' '.repeat(256 * 1024)}`;
      expect(parses(padded)).toBe(false);
    });

    it('rejects a NUL byte', () => {
      expect(parses(`${JSON.stringify([folder('sf_a')])}\0`)).toBe(false);
    });
  });
});
