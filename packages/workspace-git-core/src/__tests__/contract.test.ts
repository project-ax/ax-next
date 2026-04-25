import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkspaceContract } from '@ax/test-harness';
import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '../impl.js';

// Test-only Plugin shim so we can drive `registerWorkspaceGitHooks` (the
// core's bare API) through the contract suite. Production callers go through
// the @ax/workspace-git wrapper, which has a real manifest.
function makeCorePlugin(repoRoot: string): Plugin {
  return {
    manifest: {
      name: '@ax/workspace-git-core-test-shim',
      version: '0.0.0',
      registers: [
        'workspace:apply',
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

runWorkspaceContract('@ax/workspace-git-core', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ax-ws-core-'));
  return makeCorePlugin(repoRoot);
});
