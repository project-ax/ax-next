import { describe, it, expect } from 'vitest';
import {
  WorkspaceReadOutputSchema,
  WorkspaceListOutputSchema,
  WorkspaceApplyOutputSchema,
  WorkspaceDiffOutputSchema,
  asWorkspaceVersion,
} from '../index.js';
import type {
  WorkspaceReadOutput,
  WorkspaceListOutput,
  WorkspaceApplyOutput,
  WorkspaceDiffOutput,
  WorkspaceDelta,
} from '../index.js';

describe('workspace return schemas', () => {
  describe('WorkspaceReadOutputSchema', () => {
    it('accepts a found result with bytes and version', () => {
      const r = WorkspaceReadOutputSchema.safeParse({
        found: true,
        bytes: new Uint8Array([1, 2, 3]),
        version: 'abc',
      });
      expect(r.success).toBe(true);
    });

    it('accepts a found result without version (optional)', () => {
      const r = WorkspaceReadOutputSchema.safeParse({
        found: true,
        bytes: new Uint8Array([1]),
      });
      expect(r.success).toBe(true);
    });

    it('accepts a not-found result', () => {
      expect(WorkspaceReadOutputSchema.safeParse({ found: false }).success).toBe(true);
    });

    it('rejects found:true without bytes', () => {
      expect(WorkspaceReadOutputSchema.safeParse({ found: true }).success).toBe(false);
    });

    it('rejects bytes that are not a Uint8Array', () => {
      expect(
        WorkspaceReadOutputSchema.safeParse({ found: true, bytes: 'nope' }).success,
      ).toBe(false);
    });

    it('rejects a missing discriminant', () => {
      expect(WorkspaceReadOutputSchema.safeParse({}).success).toBe(false);
    });

    // Drift guard: a fully-populated interface value must round-trip without
    // losing fields. A new field on the interface absent from the schema would
    // be stripped here and diverge from the deep-equal assertion.
    it('round-trips a fully-populated found value without stripping fields', () => {
      const full: WorkspaceReadOutput = {
        found: true,
        bytes: new Uint8Array([7, 8, 9]),
        version: asWorkspaceVersion('deadbeef'),
      };
      const parsed = WorkspaceReadOutputSchema.parse(full);
      expect(parsed).toEqual(full);
    });

    it('round-trips a not-found value without adding fields', () => {
      const full: WorkspaceReadOutput = { found: false };
      expect(WorkspaceReadOutputSchema.parse(full)).toEqual(full);
    });
  });

  describe('WorkspaceListOutputSchema', () => {
    it('accepts a paths array', () => {
      expect(WorkspaceListOutputSchema.safeParse({ paths: ['a', 'b'] }).success).toBe(true);
    });

    it('accepts an empty paths array', () => {
      expect(WorkspaceListOutputSchema.safeParse({ paths: [] }).success).toBe(true);
    });

    it('rejects a missing paths field', () => {
      expect(WorkspaceListOutputSchema.safeParse({}).success).toBe(false);
    });

    it('rejects non-string entries', () => {
      expect(WorkspaceListOutputSchema.safeParse({ paths: [1] }).success).toBe(false);
    });

    it('round-trips a fully-populated value without stripping fields', () => {
      const full: WorkspaceListOutput = { paths: ['x/y', 'z'] };
      expect(WorkspaceListOutputSchema.parse(full)).toEqual(full);
    });
  });

  describe('WorkspaceApplyOutputSchema', () => {
    const mkDelta = (): WorkspaceDelta => ({
      before: asWorkspaceVersion('v0'),
      after: asWorkspaceVersion('v1'),
      reason: 'why',
      author: { agentId: 'a', userId: 'u', sessionId: 's' },
      changes: [
        {
          path: 'added.ts',
          kind: 'added',
          contentAfter: () => Promise.resolve(new Uint8Array([1])),
        },
        {
          path: 'mod.ts',
          kind: 'modified',
          contentBefore: () => Promise.resolve(new Uint8Array([2])),
          contentAfter: () => Promise.resolve(new Uint8Array([3])),
        },
        {
          path: 'gone.ts',
          kind: 'deleted',
          contentBefore: () => Promise.resolve(new Uint8Array([4])),
        },
      ],
    });

    it('accepts a fully-populated apply output', () => {
      const r = WorkspaceApplyOutputSchema.safeParse({
        version: asWorkspaceVersion('v1'),
        delta: mkDelta(),
      });
      expect(r.success).toBe(true);
    });

    it('accepts before: null (initial apply)', () => {
      const r = WorkspaceApplyOutputSchema.safeParse({
        version: asWorkspaceVersion('v1'),
        delta: { before: null, after: asWorkspaceVersion('v1'), changes: [] },
      });
      expect(r.success).toBe(true);
    });

    it('rejects a missing version', () => {
      expect(
        WorkspaceApplyOutputSchema.safeParse({
          delta: { before: null, after: asWorkspaceVersion('v1'), changes: [] },
        }).success,
      ).toBe(false);
    });

    it('rejects a change with a bad kind', () => {
      expect(
        WorkspaceApplyOutputSchema.safeParse({
          version: asWorkspaceVersion('v1'),
          delta: {
            before: null,
            after: asWorkspaceVersion('v1'),
            changes: [{ path: 'x', kind: 'bogus' }],
          },
        }).success,
      ).toBe(false);
    });

    // THE critical drift guard: the lazy content fns must survive .parse() by
    // reference identity, not be stripped (the ARCH-6-deferred trap).
    it('round-trips lazy contentBefore/contentAfter fn refs without stripping them', () => {
      const before = () => Promise.resolve(new Uint8Array([2]));
      const after = () => Promise.resolve(new Uint8Array([3]));
      const full: WorkspaceApplyOutput = {
        version: asWorkspaceVersion('v1'),
        delta: {
          before: asWorkspaceVersion('v0'),
          after: asWorkspaceVersion('v1'),
          changes: [
            { path: 'mod.ts', kind: 'modified', contentBefore: before, contentAfter: after },
          ],
        },
      };
      const parsed = WorkspaceApplyOutputSchema.parse(full) as WorkspaceApplyOutput;
      expect(parsed.delta.changes[0]!.contentBefore).toBe(before);
      expect(parsed.delta.changes[0]!.contentAfter).toBe(after);
      expect(typeof parsed.delta.changes[0]!.contentAfter).toBe('function');
      expect(parsed).toEqual(full);
    });
  });

  describe('WorkspaceDiffOutputSchema', () => {
    it('accepts a populated diff output', () => {
      const r = WorkspaceDiffOutputSchema.safeParse({
        delta: {
          before: asWorkspaceVersion('v0'),
          after: asWorkspaceVersion('v1'),
          changes: [
            { path: 'a', kind: 'added', contentAfter: () => Promise.resolve(new Uint8Array([1])) },
          ],
        },
      });
      expect(r.success).toBe(true);
    });

    it('rejects a missing delta', () => {
      expect(WorkspaceDiffOutputSchema.safeParse({}).success).toBe(false);
    });

    it('round-trips lazy contentAfter fn ref without stripping it', () => {
      const after = () => Promise.resolve(new Uint8Array([9]));
      const full: WorkspaceDiffOutput = {
        delta: {
          before: null,
          after: asWorkspaceVersion('v1'),
          changes: [{ path: 'a', kind: 'added', contentAfter: after }],
        },
      };
      const parsed = WorkspaceDiffOutputSchema.parse(full) as WorkspaceDiffOutput;
      expect(parsed.delta.changes[0]!.contentAfter).toBe(after);
      expect(parsed).toEqual(full);
    });
  });
});
