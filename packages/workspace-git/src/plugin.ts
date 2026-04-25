import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';

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
 * Single-replica workspace plugin backed by a bare `isomorphic-git`
 * repository on disk. Thin wrapper over `@ax/workspace-git-core` — registers
 * the four `workspace:*` service hooks against a local repoRoot. Use this
 * for the local CLI / single-pod deployments. Multi-replica deployments
 * use `@ax/workspace-git-http` instead.
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
      registerWorkspaceGitHooks(bus, { repoRoot: config.repoRoot });
    },
  };
}
