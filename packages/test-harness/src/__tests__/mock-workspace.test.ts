import { describe, it, expect } from 'vitest';
import { createTestHarness } from '../harness.js';
import { createMockWorkspacePlugin } from '../mock-workspace.js';
import type {
  WorkspaceApplyInput,
  WorkspaceApplyOutput,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceVersion,
} from '@ax/core';

describe('MockWorkspace', () => {
  it('apply → read round-trips bytes', async () => {
    const harness = await createTestHarness({ plugins: [createMockWorkspacePlugin()] });
    const r = await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      harness.ctx(),
      {
        changes: [{ path: 'a.txt', kind: 'put', content: new TextEncoder().encode('hi') }],
        parent: null,
        reason: 'test',
      },
    );
    const read = await harness.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      harness.ctx(),
      { path: 'a.txt', version: r.version },
    );
    expect(read.found).toBe(true);
    if (read.found) expect(new TextDecoder().decode(read.bytes)).toBe('hi');
  });

  it('parent mismatch rejects with a structured PluginError', async () => {
    const harness = await createTestHarness({ plugins: [createMockWorkspacePlugin()] });
    const first = await harness.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      harness.ctx(),
      { changes: [], parent: null },
    );
    void first;
    await expect(
      harness.bus.call('workspace:apply', harness.ctx(), {
        changes: [],
        parent: 'wrong' as WorkspaceVersion,
      }),
    ).rejects.toMatchObject({ code: 'parent-mismatch' });
  });
});
