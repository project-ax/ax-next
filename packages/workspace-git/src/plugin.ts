import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from './impl.js';

const PLUGIN_NAME = '@ax/workspace-git';

export interface WorkspaceGitConfig {
  /**
   * Absolute path to the directory that will host the bare repository at
   * `<repoRoot>/repo.git`. The plugin will idempotently `git.init` it on
   * first use. Capabilities are scoped to this directory only — nothing
   * outside `repoRoot` is read or written.
   */
  repoRoot: string;
}

/**
 * Workspace plugin backed by a bare `isomorphic-git` repository on disk.
 *
 * Linear-history-only by construction: every `workspace:apply` is a CAS on
 * `refs/heads/main`. There are no branches, no merges, no rebase. The
 * `WorkspaceVersion` opaque string happens to be a 40-hex commit SHA today,
 * but subscribers MUST treat it as opaque (Invariant 1).
 */
export function createWorkspaceGitPlugin(config: WorkspaceGitConfig): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
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
      registerWorkspaceGitHooks(bus, config);
    },
  };
}
