import { describe, it, expect } from 'vitest';
import {
  WorkspaceApplyRequestSchema,
  WorkspaceApplyResponseSchema,
  WorkspaceReadRequestSchema,
  WorkspaceReadResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceDiffRequestSchema,
  WorkspaceDiffResponseSchema,
} from '../actions.js';
import { WorkspaceErrorEnvelopeSchema } from '../errors.js';

describe('workspace wire schemas', () => {
  it('apply request: rejects extra fields and wrong types', () => {
    const ok = WorkspaceApplyRequestSchema.safeParse({
      changes: [{ path: 'a', kind: 'put', contentBase64: 'aGVsbG8=' }],
      parent: null,
    });
    expect(ok.success).toBe(true);

    const bad = WorkspaceApplyRequestSchema.safeParse({
      changes: [{ path: 'a', kind: 'put', content: 'hello' }],
      parent: null,
    });
    expect(bad.success).toBe(false);
  });

  it('apply response: parses a delta envelope and rejects unknown fields', () => {
    const ok = WorkspaceApplyResponseSchema.safeParse({
      version: 'v1',
      delta: {
        before: null,
        after: 'v1',
        changes: [
          { path: 'a', kind: 'added', contentAfterBase64: 'aGVsbG8=' },
        ],
      },
    });
    expect(ok.success).toBe(true);

    const bad = WorkspaceApplyResponseSchema.safeParse({
      version: 'v1',
      delta: { before: null, after: 'v1', changes: [] },
      extra: 'nope',
    });
    expect(bad.success).toBe(false);
  });

  it('read request: requires path, version optional', () => {
    expect(WorkspaceReadRequestSchema.safeParse({ path: 'a' }).success).toBe(true);
    expect(
      WorkspaceReadRequestSchema.safeParse({ path: 'a', version: 'v1' }).success,
    ).toBe(true);
    expect(WorkspaceReadRequestSchema.safeParse({}).success).toBe(false);
  });

  it('read response: discriminates on found', () => {
    expect(
      WorkspaceReadResponseSchema.safeParse({ found: true, bytesBase64: 'aGVsbG8=' })
        .success,
    ).toBe(true);
    expect(WorkspaceReadResponseSchema.safeParse({ found: false }).success).toBe(true);
    // found:true must include bytesBase64
    expect(WorkspaceReadResponseSchema.safeParse({ found: true }).success).toBe(false);
    // found:false must not include bytesBase64 (strict)
    expect(
      WorkspaceReadResponseSchema.safeParse({ found: false, bytesBase64: 'x' }).success,
    ).toBe(false);
  });

  it('list request: all fields optional but extras rejected', () => {
    expect(WorkspaceListRequestSchema.safeParse({}).success).toBe(true);
    expect(
      WorkspaceListRequestSchema.safeParse({ pathGlob: '*.ts', version: 'v1' }).success,
    ).toBe(true);
    expect(WorkspaceListRequestSchema.safeParse({ junk: 1 }).success).toBe(false);
  });

  it('list response: paths must be string array', () => {
    const ok = WorkspaceListResponseSchema.safeParse({ paths: ['a', 'b'] });
    expect(ok.success).toBe(true);
    const bad = WorkspaceListResponseSchema.safeParse({ paths: 'a,b' });
    expect(bad.success).toBe(false);
  });

  it('diff request: from is nullable, to required', () => {
    expect(
      WorkspaceDiffRequestSchema.safeParse({ from: null, to: 'v1' }).success,
    ).toBe(true);
    expect(
      WorkspaceDiffRequestSchema.safeParse({ from: 'v0', to: 'v1' }).success,
    ).toBe(true);
    expect(WorkspaceDiffRequestSchema.safeParse({ to: 'v1' }).success).toBe(false);
  });

  it('diff response: wraps a delta', () => {
    const ok = WorkspaceDiffResponseSchema.safeParse({
      delta: { before: 'v0', after: 'v1', changes: [] },
    });
    expect(ok.success).toBe(true);
    const bad = WorkspaceDiffResponseSchema.safeParse({ delta: 'nope' });
    expect(bad.success).toBe(false);
  });

  it('error envelope: accepts code+message, optional parent fields, rejects extras', () => {
    expect(
      WorkspaceErrorEnvelopeSchema.safeParse({
        error: { code: 'PARENT_MISMATCH', message: 'oops' },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceErrorEnvelopeSchema.safeParse({
        error: {
          code: 'PARENT_MISMATCH',
          message: 'oops',
          expectedParent: 'v0',
          actualParent: 'v1',
        },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceErrorEnvelopeSchema.safeParse({
        error: { code: 'X', message: 'y' },
        extra: true,
      }).success,
    ).toBe(false);
  });
});
