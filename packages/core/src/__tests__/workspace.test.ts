import { describe, it, expect } from 'vitest';
import {
  asWorkspaceVersion,
  type WorkspaceVersion,
  type FileChange,
  type WorkspaceDelta,
  type WorkspaceChangeKind,
} from '../workspace.js';

describe('workspace contract', () => {
  it('brands WorkspaceVersion (raw strings cannot be assigned)', () => {
    const v: WorkspaceVersion = asWorkspaceVersion('opaque-token');
    expect(v).toBe('opaque-token');
    // @ts-expect-error — raw string must not be assignable
    const bad: WorkspaceVersion = 'plain';
    void bad;
  });

  it('FileChange union has exactly put and delete variants', () => {
    const put: FileChange = { path: 'a', kind: 'put', content: new Uint8Array([1]) };
    const del: FileChange = { path: 'a', kind: 'delete' };
    expect(put.kind).toBe('put');
    expect(del.kind).toBe('delete');
  });

  it('WorkspaceDelta exposes lazy contentBefore/contentAfter fetchers', async () => {
    const kinds: WorkspaceChangeKind[] = ['added', 'modified', 'deleted'];
    expect(kinds).toContain('modified');
    const d: WorkspaceDelta = {
      before: null,
      after: asWorkspaceVersion('v1'),
      reason: 'test',
      changes: [{
        path: 'x',
        kind: 'added',
        contentAfter: async () => new Uint8Array([42]),
      }],
    };
    const bytes = await d.changes[0].contentAfter!();
    expect(bytes[0]).toBe(42);
  });

  it('WorkspaceDelta.changes never holds bytes eagerly', () => {
    type Change = WorkspaceDelta['changes'][number];
    type Cb = NonNullable<Change['contentBefore']>;
    const _proof: Cb extends () => Promise<Uint8Array> ? true : false = true;
    expect(_proof).toBe(true);
  });
});
