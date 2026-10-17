import { describe, expect, it } from 'vitest';
import {
  OpenSessionInputSchema,
  SHARED_FOLDER_ID_RE,
  SharedFolderIdSchema,
  isValidSharedFolderId,
} from '../index.js';

// ---------------------------------------------------------------------------
// W2 shared folders — folder-id vocabulary. `sf_` + base64url, a safe SINGLE
// path segment: it becomes `.shared/<folderId>` (backing store) and
// `/shared/<folderId>` (sandbox), so anything that could escape or alias a
// segment (`.`, `..`, `/`, empty tail) must be refused here, once, for every
// consumer.
// ---------------------------------------------------------------------------

const VALID_IDS = [
  'sf_a',
  'sf_abc123',
  'sf_AbC-_xyz',
  'sf_' + 'a'.repeat(64),
  'sf__', // underscore is base64url
  'sf_-',
];

const INVALID_IDS: ReadonlyArray<readonly [label: string, id: unknown]> = [
  ['dot-shared dir name', '.shared'],
  ['prefix only', 'sf_'],
  ['slash in tail', 'sf_a/b'],
  ['dotdot tail', 'sf_..'],
  ['dot tail', 'sf_.'],
  ['traversal', '../x'],
  ['traversal with prefix', 'sf_../x'],
  ['65-char tail', 'sf_' + 'a'.repeat(65)],
  ['wrong prefix', 'folder_abc'],
  ['uppercase prefix', 'SF_abc'],
  ['empty string', ''],
  ['leading space', ' sf_abc'],
  ['trailing newline', 'sf_abc\n'],
  ['NUL byte', 'sf_a\u0000b'],
  ['unicode tail', 'sf_é'],
  ['base64 plus', 'sf_a+b'],
  ['base64 pad', 'sf_ab=='],
  ['backslash', 'sf_a\\b'],
  ['non-string number', 42],
  ['non-string null', null],
  ['non-string undefined', undefined],
  ['non-string object', { id: 'sf_a' }],
];

describe('SHARED_FOLDER_ID_RE', () => {
  it('is anchored: ^sf_[A-Za-z0-9_-]{1,64}$', () => {
    expect(SHARED_FOLDER_ID_RE.source).toBe('^sf_[A-Za-z0-9_-]{1,64}$');
  });

  it('is not global/sticky (no lastIndex state shared across calls)', () => {
    expect(SHARED_FOLDER_ID_RE.global).toBe(false);
    expect(SHARED_FOLDER_ID_RE.sticky).toBe(false);
  });
});

describe('isValidSharedFolderId', () => {
  it.each(VALID_IDS)('accepts %s', (id) => {
    expect(isValidSharedFolderId(id)).toBe(true);
  });

  it.each(INVALID_IDS)('rejects %s', (_label, id) => {
    expect(isValidSharedFolderId(id)).toBe(false);
  });

  it('narrows unknown to string', () => {
    const x: unknown = 'sf_abc';
    if (isValidSharedFolderId(x)) {
      const s: string = x;
      expect(s).toBe('sf_abc');
    } else {
      throw new Error('expected narrowing');
    }
  });
});

describe('SharedFolderIdSchema', () => {
  it.each(VALID_IDS)('accepts %s', (id) => {
    expect(SharedFolderIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(INVALID_IDS)('rejects %s', (_label, id) => {
    expect(SharedFolderIdSchema.safeParse(id).success).toBe(false);
  });
});

// --- OpenSessionInputSchema.sharedFolderIds ---------------------------------

function baseOpenSessionInput(): Record<string, unknown> {
  return {
    sessionId: 'sess-1',
    workspaceRoot: '/tmp/ws',
    runnerBinary: '/opt/ax/runner.js',
    proxyConfig: {
      endpoint: 'http://127.0.0.1:1',
      caCertPem: 'PEM',
      envMap: {},
      proxyAuthToken: 'a'.repeat(32),
    },
  };
}

describe('OpenSessionInputSchema.sharedFolderIds', () => {
  it('still parses when the field is omitted (back-compat)', () => {
    const r = OpenSessionInputSchema.safeParse(baseOpenSessionInput());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sharedFolderIds).toBeUndefined();
  });

  it('accepts a list of valid unique ids and preserves order', () => {
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: ['sf_b', 'sf_a'],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sharedFolderIds).toEqual(['sf_b', 'sf_a']);
  });

  it('accepts an empty list', () => {
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: [],
    });
    expect(r.success).toBe(true);
  });

  it('accepts exactly 16 ids', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `sf_id${i}`);
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: ids,
    });
    expect(r.success).toBe(true);
  });

  it('rejects 17 ids', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `sf_id${i}`);
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: ids,
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate ids', () => {
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: ['sf_a', 'sf_b', 'sf_a'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid id anywhere in the list', () => {
    for (const bad of ['.shared', 'sf_', 'sf_a/b', 'sf_..', '../x', 'sf_' + 'a'.repeat(65)]) {
      const r = OpenSessionInputSchema.safeParse({
        ...baseOpenSessionInput(),
        sharedFolderIds: ['sf_ok', bad],
      });
      expect(r.success, bad).toBe(false);
    }
  });

  it('rejects a non-array value', () => {
    const r = OpenSessionInputSchema.safeParse({
      ...baseOpenSessionInput(),
      sharedFolderIds: 'sf_a',
    });
    expect(r.success).toBe(false);
  });
});
