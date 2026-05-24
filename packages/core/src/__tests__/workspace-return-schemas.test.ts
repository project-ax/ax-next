import { describe, it, expect } from 'vitest';
import {
  WorkspaceReadOutputSchema,
  WorkspaceListOutputSchema,
  asWorkspaceVersion,
} from '../index.js';
import type { WorkspaceReadOutput, WorkspaceListOutput } from '../index.js';

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
});
