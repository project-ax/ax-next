import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PluginError } from '@ax/core';
import {
  WorkspaceApplyResponseSchema,
  WorkspaceReadResponseSchema,
  WorkspaceListResponseSchema,
  WorkspaceDiffResponseSchema,
} from '@ax/workspace-protocol';
import { handleApply, handleRead, handleList, handleDiff } from '../handlers.js';

function freshRepo(): string {
  return mkdtempSync(join(tmpdir(), 'ax-ws-srv-'));
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const fromB64 = (s: string): string => Buffer.from(s, 'base64').toString();

describe('git-server handlers', () => {
  it('apply round-trips: returns version + delta with base64 contentAfter', async () => {
    const repoRoot = freshRepo();
    const r = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('hi') }],
      parent: null,
    });
    expect(typeof r.version).toBe('string');
    expect(r.delta.before).toBeNull();
    expect(r.delta.after).toBe(r.version);
    expect(r.delta.changes).toHaveLength(1);
    const ch = r.delta.changes[0]!;
    expect(ch.kind).toBe('added');
    if (ch.kind === 'added') {
      expect(fromB64(ch.contentAfterBase64)).toBe('hi');
    }
    // Wire-shape sanity: response parses through the protocol schema.
    expect(WorkspaceApplyResponseSchema.safeParse(r).success).toBe(true);
  });

  it('apply with reason preserves it on the delta and author is populated', async () => {
    const repoRoot = freshRepo();
    const r = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('hi') }],
      parent: null,
      reason: 'first write',
    });
    expect(r.delta.reason).toBe('first write');
    expect(r.delta.author).toEqual({
      agentId: 'git-server',
      userId: 'git-server',
      sessionId: 'git-server',
    });
    expect(WorkspaceApplyResponseSchema.safeParse(r).success).toBe(true);
  });

  it('apply produces a modified change on overwrite', async () => {
    const repoRoot = freshRepo();
    const v1 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('one') }],
      parent: null,
    });
    const v2 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('two') }],
      parent: v1.version,
    });
    expect(v2.delta.before).toBe(v1.version);
    expect(v2.delta.changes).toHaveLength(1);
    const ch = v2.delta.changes[0]!;
    expect(ch.kind).toBe('modified');
    if (ch.kind === 'modified') {
      expect(fromB64(ch.contentBeforeBase64)).toBe('one');
      expect(fromB64(ch.contentAfterBase64)).toBe('two');
    }
  });

  it('apply produces a deleted change with contentBefore', async () => {
    const repoRoot = freshRepo();
    const v1 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('bye') }],
      parent: null,
    });
    const v2 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'delete' }],
      parent: v1.version,
    });
    expect(v2.delta.changes).toHaveLength(1);
    const ch = v2.delta.changes[0]!;
    expect(ch.kind).toBe('deleted');
    if (ch.kind === 'deleted') {
      expect(fromB64(ch.contentBeforeBase64)).toBe('bye');
    }
  });

  it('read returns { found: false } for unknown path', async () => {
    const repoRoot = freshRepo();
    // Need at least one commit so the version exists; otherwise read returns
    // { found: false } trivially.
    await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('hi') }],
      parent: null,
    });
    const r = await handleRead(repoRoot, { path: 'nope.txt' });
    expect(r).toEqual({ found: false });
    expect(WorkspaceReadResponseSchema.safeParse(r).success).toBe(true);
  });

  it('read returns { found: true, bytesBase64 } for an existing path', async () => {
    const repoRoot = freshRepo();
    await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('hello world') }],
      parent: null,
    });
    const r = await handleRead(repoRoot, { path: 'a.txt' });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(fromB64(r.bytesBase64)).toBe('hello world');
    }
    expect(WorkspaceReadResponseSchema.safeParse(r).success).toBe(true);
  });

  it('list with pathGlob honors the glob', async () => {
    const repoRoot = freshRepo();
    await handleApply(repoRoot, {
      changes: [
        { path: 'src/a.ts', kind: 'put', contentBase64: b64('a') },
        { path: 'src/b.ts', kind: 'put', contentBase64: b64('b') },
        { path: 'README.md', kind: 'put', contentBase64: b64('r') },
      ],
      parent: null,
    });
    const r = await handleList(repoRoot, { pathGlob: 'src/*.ts' });
    expect(r.paths.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(WorkspaceListResponseSchema.safeParse(r).success).toBe(true);
  });

  it('list without pathGlob returns every path', async () => {
    const repoRoot = freshRepo();
    await handleApply(repoRoot, {
      changes: [
        { path: 'a.txt', kind: 'put', contentBase64: b64('a') },
        { path: 'sub/b.txt', kind: 'put', contentBase64: b64('b') },
      ],
      parent: null,
    });
    const r = await handleList(repoRoot, {});
    expect(r.paths.sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('diff between two versions returns the right delta shape with eager bytes', async () => {
    const repoRoot = freshRepo();
    const v1 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('one') }],
      parent: null,
    });
    const v2 = await handleApply(repoRoot, {
      changes: [
        { path: 'a.txt', kind: 'put', contentBase64: b64('two') },
        { path: 'b.txt', kind: 'put', contentBase64: b64('new') },
      ],
      parent: v1.version,
    });
    const r = await handleDiff(repoRoot, { from: v1.version, to: v2.version });
    expect(r.delta.before).toBe(v1.version);
    expect(r.delta.after).toBe(v2.version);
    expect(r.delta.changes).toHaveLength(2);
    const byPath = Object.fromEntries(r.delta.changes.map((c) => [c.path, c]));
    expect(byPath['a.txt']!.kind).toBe('modified');
    if (byPath['a.txt']!.kind === 'modified') {
      expect(fromB64(byPath['a.txt']!.contentBeforeBase64)).toBe('one');
      expect(fromB64(byPath['a.txt']!.contentAfterBase64)).toBe('two');
    }
    expect(byPath['b.txt']!.kind).toBe('added');
    if (byPath['b.txt']!.kind === 'added') {
      expect(fromB64(byPath['b.txt']!.contentAfterBase64)).toBe('new');
    }
    expect(WorkspaceDiffResponseSchema.safeParse(r).success).toBe(true);
  });

  it('diff from null returns "added" for every path in `to`', async () => {
    const repoRoot = freshRepo();
    const v1 = await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('hi') }],
      parent: null,
    });
    const r = await handleDiff(repoRoot, { from: null, to: v1.version });
    expect(r.delta.before).toBeNull();
    expect(r.delta.after).toBe(v1.version);
    expect(r.delta.changes).toHaveLength(1);
    const ch = r.delta.changes[0]!;
    expect(ch.kind).toBe('added');
    if (ch.kind === 'added') {
      expect(fromB64(ch.contentAfterBase64)).toBe('hi');
    }
  });

  it('parent-mismatch on second apply throws PluginError that bubbles', async () => {
    const repoRoot = freshRepo();
    await handleApply(repoRoot, {
      changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('one') }],
      parent: null,
    });
    await expect(
      handleApply(repoRoot, {
        changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('two') }],
        // Wrong parent — first apply set HEAD to a real SHA, not null.
        parent: null,
      }),
    ).rejects.toBeInstanceOf(PluginError);
    await expect(
      handleApply(repoRoot, {
        changes: [{ path: 'a.txt', kind: 'put', contentBase64: b64('two') }],
        parent: null,
      }),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
  });

  it('separate repoRoots get separate buses (no state crosstalk)', async () => {
    const r1 = freshRepo();
    const r2 = freshRepo();
    const v1 = await handleApply(r1, {
      changes: [{ path: 'only-in-r1.txt', kind: 'put', contentBase64: b64('1') }],
      parent: null,
    });
    expect(typeof v1.version).toBe('string');
    // r2 has nothing yet — list should be empty.
    const list2 = await handleList(r2, {});
    expect(list2.paths).toEqual([]);
    // And r2's first apply should accept parent: null (independent HEAD).
    const v2 = await handleApply(r2, {
      changes: [{ path: 'only-in-r2.txt', kind: 'put', contentBase64: b64('2') }],
      parent: null,
    });
    expect(typeof v2.version).toBe('string');
  });
});
