import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import { createWorkspaceGitPlugin } from '../plugin.js';

runWorkspaceContract('@ax/workspace-git', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-git-'));
  return createWorkspaceGitPlugin({ repoRoot });
});
