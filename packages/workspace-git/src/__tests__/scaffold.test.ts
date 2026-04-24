import { describe, it, expect } from 'vitest';
import { createWorkspaceGitPlugin } from '../plugin.js';

describe('@ax/workspace-git scaffold', () => {
  it('exports a factory that builds a Plugin manifest', () => {
    const p = createWorkspaceGitPlugin({ repoRoot: '/tmp/repo' });
    expect(p.manifest.name).toBe('@ax/workspace-git');
    expect(p.manifest.registers).toEqual(
      expect.arrayContaining([
        'workspace:apply',
        'workspace:read',
        'workspace:list',
        'workspace:diff',
      ]),
    );
  });
});
