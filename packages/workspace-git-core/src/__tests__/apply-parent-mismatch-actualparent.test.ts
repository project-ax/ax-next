// ---------------------------------------------------------------------------
// Regression (F-1 sibling): the single-replica `@ax/workspace-git-core`
// backend's `workspace:apply` (FileChange) parent-CAS must carry the freshly-
// read mirror head as `cause.actualParent` — the same contract the multi-
// replica `@ax/workspace-git-server` backend honors (its `parentMismatch`
// helper) and the apply-BUNDLE CAS already honors (impl.ts Site 1, PR #133).
//
// Why it matters: `attachments:commit` (and any rebase-on-mismatch consumer)
// calls `workspace:apply` with `parent: null` first, then retries using the
// `actualParent` the backend echoes. Pre-fix this throw had NO `cause`, so the
// consumer re-threw → `POST /api/chat/messages` 500 on the single-replica
// backend. The `workspace:apply` facade forwards the internal error UNCHANGED
// (workspace-apply-facade.ts:95-97), so the cause must originate here.
//
// RED pre-fix: `err.cause` is undefined. GREEN post-fix: actualParent === head.
// ---------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import {
  PluginError,
  type Plugin,
  type WorkspaceApplyInput,
  type WorkspaceApplyOutput,
  type WorkspaceVersion,
} from '@ax/core';
import { registerWorkspaceGitHooks } from '../impl.js';

// Test-only Plugin shim (modeled on contract.test.ts): the manifest's
// `registers` lists the public `workspace:apply` facade + the internal hooks
// registerWorkspaceGitHooks installs.
function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-actualparent-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-internal',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      registerWorkspaceGitHooks(bus, { repoRoot });
    },
  };
}

const repoRoots: string[] = [];

afterEach(async () => {
  for (const r of repoRoots.splice(0)) {
    await rm(r, { recursive: true, force: true });
  }
});

async function load() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-core-ap-'));
  repoRoots.push(repoRoot);
  return createTestHarness({ plugins: [makeCorePlugin(repoRoot)] });
}

const enc = new TextEncoder();

function readActualParent(err: unknown): {
  has: boolean;
  value: WorkspaceVersion | null | undefined;
} {
  if (
    err instanceof PluginError &&
    err.cause !== null &&
    typeof err.cause === 'object' &&
    'actualParent' in err.cause
  ) {
    return {
      has: true,
      value: (err.cause as { actualParent: WorkspaceVersion | null }).actualParent,
    };
  }
  return { has: false, value: undefined };
}

describe('workspace:apply parent-mismatch carries cause.actualParent (single-replica F-1 sibling)', () => {
  it('non-null head: a mismatched parent echoes the current head as cause.actualParent', async () => {
    const h = await load();

    // Seed one commit so the mirror head is non-null (V1).
    const v1 = (
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
      )
    ).version;

    // A second apply with parent: null is a CAS mismatch (head is now V1).
    let caught: unknown;
    try {
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'b', kind: 'put', content: enc.encode('2') }], parent: null },
      );
      expect.fail('expected workspace:apply to throw parent-mismatch');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('parent-mismatch');

    const { has, value } = readActualParent(caught);
    expect(has).toBe(true);
    expect(value).toBe(v1);
  });

  it('empty mirror (null head): a non-null parent echoes cause.actualParent === null', async () => {
    const h = await load();

    let caught: unknown;
    try {
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        {
          changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }],
          parent: 'definitely-not-a-real-version' as WorkspaceVersion,
        },
      );
      expect.fail('expected workspace:apply to throw parent-mismatch');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginError);
    expect((caught as PluginError).code).toBe('parent-mismatch');

    const { has, value } = readActualParent(caught);
    expect(has).toBe(true);
    expect(value).toBeNull();
  });
});
