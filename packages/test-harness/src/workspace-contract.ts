// Shared contract test-suite for any plugin that registers the four
// workspace:* service hooks. The point: a single set of assertions that
// runs against every backend (MockWorkspace today, `@ax/workspace-git`
// next, anything else later) so we can prove the contract is genuinely
// interchangeable instead of accidentally git-shaped.
//
// Anything that passes here AND passes for `@ax/workspace-git` is
// backend-agnostic. Anything that needs backend-specific assertions
// belongs in that backend's own test file, not in here.
//
// This file imports `@ax/core` types only — no plugin imports — so the
// contract itself stays storage-agnostic (Invariant 1).

import { describe, it, expect } from 'vitest';
import type { Plugin } from '@ax/core';
import { createTestHarness } from './harness.js';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceListInput,
  WorkspaceListOutput,
  WorkspaceDiffInput,
  WorkspaceDiffOutput,
  WorkspaceVersion,
} from '@ax/core';

export function runWorkspaceContract(label: string, makePlugin: () => Plugin): void {
  describe(`workspace contract: ${label}`, () => {
    async function load() {
      const h = await createTestHarness({ plugins: [makePlugin()] });
      return h;
    }
    const enc = new TextEncoder();

    it('initial apply uses parent: null', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
      );
      expect(r.delta.before).toBeNull();
      expect(r.delta.after).toBe(r.version);
      expect(r.delta.changes).toHaveLength(1);
      expect(r.delta.changes[0]).toMatchObject({ path: 'a', kind: 'added' });
    });

    it('second apply must pass the previous version as parent', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
        )
      ).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 },
      );
      expect(v2.delta.before).toBe(v1);
      expect(v2.delta.changes[0]!.kind).toBe('modified');
    });

    it('parent mismatch raises PluginError with code: parent-mismatch', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [], parent: null },
      );
      await expect(
        h.bus.call('workspace:apply', h.ctx(), {
          changes: [],
          parent: 'definitely-not-a-real-version' as WorkspaceVersion,
        }),
      ).rejects.toMatchObject({ code: 'parent-mismatch' });
    });

    it('read returns { found: false } for unknown path', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        h.ctx(),
        { path: 'nope' },
      );
      expect(r.found).toBe(false);
    });

    it('list with pathGlob honors the glob', async () => {
      const h = await load();
      await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>('workspace:apply', h.ctx(), {
        changes: [
          { path: 'src/a.ts', kind: 'put', content: enc.encode('a') },
          { path: 'src/b.ts', kind: 'put', content: enc.encode('b') },
          { path: 'README.md', kind: 'put', content: enc.encode('r') },
        ],
        parent: null,
      });
      const list = await h.bus.call<WorkspaceListInput, WorkspaceListOutput>(
        'workspace:list',
        h.ctx(),
        { pathGlob: 'src/**' },
      );
      expect([...list.paths].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('delete shows up as kind: deleted in the next delta', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
        )
      ).version;
      const v2 = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'delete' }], parent: v1 },
      );
      expect(v2.delta.changes[0]).toMatchObject({ path: 'a', kind: 'deleted' });
    });

    it('contentAfter is lazy — not invoked unless called', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [{ path: 'a', kind: 'put', content: enc.encode('x') }], parent: null },
      );
      const ch = r.delta.changes[0]!;
      expect(typeof ch.contentAfter).toBe('function');
      expect(await ch.contentAfter!()).toEqual(enc.encode('x'));
    });

    it('diff between two versions returns the same delta shape', async () => {
      const h = await load();
      const v1 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('1') }], parent: null },
        )
      ).version;
      const v2 = (
        await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
          'workspace:apply',
          h.ctx(),
          { changes: [{ path: 'a', kind: 'put', content: enc.encode('2') }], parent: v1 },
        )
      ).version;
      const diff = await h.bus.call<WorkspaceDiffInput, WorkspaceDiffOutput>(
        'workspace:diff',
        h.ctx(),
        { from: v1, to: v2 },
      );
      expect(diff.delta.before).toBe(v1);
      expect(diff.delta.after).toBe(v2);
      expect(diff.delta.changes[0]!.kind).toBe('modified');
    });

    it('opaque versions: subscribers must NOT depend on version string format', async () => {
      const h = await load();
      const r = await h.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
        'workspace:apply',
        h.ctx(),
        { changes: [], parent: null },
      );
      // Documentation pin: if a subscriber reaches into r.version.startsWith('sha')
      // someday, they're violating the contract. This test asserts only that the
      // value is a string — nothing about its shape.
      expect(typeof r.version).toBe('string');
    });
  });
}
