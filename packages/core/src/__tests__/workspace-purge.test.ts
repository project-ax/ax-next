import { describe, it, expect } from 'vitest';
import {
  PluginError,
  WorkspacePurgeOutputSchema,
  validatePurgeSelector,
  asWorkspaceVersion,
} from '../index.js';
import type { WorkspacePurgeInput, WorkspacePurgeOutput } from '../index.js';

function expectInvalid(input: unknown): void {
  let caught: unknown;
  try {
    validatePurgeSelector(input as WorkspacePurgeInput);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PluginError);
  expect((caught as PluginError).code).toBe('invalid-input');
}

describe('validatePurgeSelector', () => {
  it('accepts the TASK-576 selector', () => {
    expect(() =>
      validatePurgeSelector({
        prefixes: ['memory/', 'permanent/memory/facts/'],
        keep: ['memory/system/rules.md'],
      }),
    ).not.toThrow();
  });

  it('accepts prefixes without keep, and paths with spaces / non-ASCII', () => {
    expect(() => validatePurgeSelector({ prefixes: ['memory/'] })).not.toThrow();
    expect(() =>
      validatePurgeSelector({ prefixes: ['a b/café/'], keep: ['a b/café/"x".md'] }),
    ).not.toThrow();
  });

  it.each([
    ['non-object', null],
    ['prefixes missing', {}],
    ['prefixes not array', { prefixes: 'memory/' }],
    ['prefixes empty', { prefixes: [] }],
    ['too many prefixes', { prefixes: Array.from({ length: 17 }, (_, i) => `p${i}/`) }],
    ['prefix not string', { prefixes: [1] }],
    ['prefix without trailing slash', { prefixes: ['memory'] }],
    ['empty prefix', { prefixes: [''] }],
    ['root prefix', { prefixes: ['/'] }],
    ['absolute prefix', { prefixes: ['/memory/'] }],
    ['NUL in prefix', { prefixes: ['mem\0ory/'] }],
    ['backslash in prefix', { prefixes: ['mem\\ory/'] }],
    ['dot segment', { prefixes: ['./memory/'] }],
    ['dotdot segment', { prefixes: ['memory/../'] }],
    ['empty segment', { prefixes: ['memory//docs/'] }],
    ['.git segment', { prefixes: ['.git/'] }],
    ['nested .git segment', { prefixes: ['memory/.git/'] }],
    ['keep not array', { prefixes: ['memory/'], keep: 'memory/x.md' }],
    [
      'too many keep',
      { prefixes: ['memory/'], keep: Array.from({ length: 65 }, (_, i) => `memory/${i}.md`) },
    ],
    ['keep not string', { prefixes: ['memory/'], keep: [3] }],
    ['keep with trailing slash', { prefixes: ['memory/'], keep: ['memory/system/'] }],
    ['keep outside every prefix', { prefixes: ['memory/'], keep: ['notes/a.md'] }],
    ['keep that is a sibling name', { prefixes: ['memory/'], keep: ['memory-notes.md'] }],
    ['keep absolute', { prefixes: ['memory/'], keep: ['/memory/x.md'] }],
    ['keep dotdot', { prefixes: ['memory/'], keep: ['memory/../x.md'] }],
    ['keep NUL', { prefixes: ['memory/'], keep: ['memory/\0x.md'] }],
    ['keep backslash', { prefixes: ['memory/'], keep: ['memory/a\\b.md'] }],
    ['keep .git', { prefixes: ['memory/'], keep: ['memory/.git'] }],
    ['keep empty', { prefixes: ['memory/'], keep: [''] }],
  ])('rejects %s', (_label, input) => {
    expectInvalid(input);
  });
});

describe('WorkspacePurgeOutputSchema', () => {
  it('round-trips a fully-populated value', () => {
    const v: WorkspacePurgeOutput = {
      purged: ['memory/docs/a.md'],
      version: asWorkspaceVersion('v2'),
      pastVersionsChanged: true,
    };
    expect(WorkspacePurgeOutputSchema.parse(v)).toEqual(v);
  });

  it('accepts a null version', () => {
    expect(
      WorkspacePurgeOutputSchema.safeParse({ purged: [], version: null, pastVersionsChanged: false })
        .success,
    ).toBe(true);
  });

  it('rejects a missing pastVersionsChanged', () => {
    expect(WorkspacePurgeOutputSchema.safeParse({ purged: [], version: null }).success).toBe(false);
  });

  it('rejects a non-string purged entry', () => {
    expect(
      WorkspacePurgeOutputSchema.safeParse({ purged: [1], version: null, pastVersionsChanged: false })
        .success,
    ).toBe(false);
  });
});
