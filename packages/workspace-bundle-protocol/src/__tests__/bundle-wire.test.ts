import { describe, expect, it } from 'vitest';
import type { WorkspaceApplyOutput, WorkspaceVersion } from '@ax/core';
import type {
  WorkspaceApplyBundleInput,
  WorkspaceApplyBundleOutput,
  WorkspaceExportBaselineBundleInput,
  WorkspaceExportBaselineBundleOutput,
} from '../index.js';

// This package is pure TS types — the contract IS the type. These tests pin
// the contract: a typed literal must satisfy each interface (compile-time),
// and the git-vocabulary fields the bundle wire depends on must be present
// (the whole reason these types are isolated in a git-runner package and out
// of the storage-neutral @ax/core kernel — ARCH-3 / invariant I1).

const v = 'deadbeef' as WorkspaceVersion;

describe('WorkspaceApplyBundleInput', () => {
  it('carries the git bundle-wire fields', () => {
    const input: WorkspaceApplyBundleInput = {
      bundleBytes: 'YmFzZTY0',
      baselineCommit: 'deadbeef',
      parent: v,
      reason: 'turn 1',
    };
    expect(input.bundleBytes).toBe('YmFzZTY0');
    expect(input.baselineCommit).toBe('deadbeef');
    expect(input.parent).toBe(v);
  });

  it('accepts a null parent (first apply)', () => {
    const input: WorkspaceApplyBundleInput = {
      bundleBytes: 'YmFzZTY0',
      baselineCommit: 'deadbeef',
      parent: null,
    };
    expect(input.parent).toBeNull();
  });
});

describe('WorkspaceApplyBundleOutput', () => {
  it('is the storage-neutral WorkspaceApplyOutput', () => {
    // Assignability both directions proves the alias holds.
    const apply: WorkspaceApplyOutput = {
      version: v,
      delta: { before: null, after: v, changes: [] },
    };
    const out: WorkspaceApplyBundleOutput = apply;
    const back: WorkspaceApplyOutput = out;
    expect(back.version).toBe(v);
  });
});

describe('WorkspaceExportBaselineBundleInput', () => {
  it('accepts undefined / null / a version', () => {
    const current: WorkspaceExportBaselineBundleInput = {};
    const seed: WorkspaceExportBaselineBundleInput = { version: null };
    const at: WorkspaceExportBaselineBundleInput = { version: v };
    expect(current.version).toBeUndefined();
    expect(seed.version).toBeNull();
    expect(at.version).toBe(v);
  });
});

describe('WorkspaceExportBaselineBundleOutput', () => {
  it('carries the base64 bundle bytes', () => {
    const out: WorkspaceExportBaselineBundleOutput = { bundleBytes: 'YmFzZTY0' };
    expect(out.bundleBytes).toBe('YmFzZTY0');
  });
});
