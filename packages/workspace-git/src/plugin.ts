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
 * repository on disk. Thin wrapper over `@ax/workspace-git-core` —
 * registers the four base `workspace:*` service hooks plus the two
 * Phase 3 bundle hooks (`workspace:apply-bundle` +
 * `workspace:export-baseline-bundle`) against a local repoRoot. Use
 * this for the local CLI / single-pod deployments. Multi-replica
 * deployments use `@ax/workspace-git-http` instead.
 *
 * The bundle hooks are what enables multi-turn /permanent persistence:
 * the host's commit-notify handler probes for them before accepting a
 * runner's thin bundle, and rejects the apply if either is missing.
 */
export function createWorkspaceGitPlugin(config: WorkspaceGitConfig): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [
        'workspace:apply',
        'workspace:apply-bundle',
        'workspace:export-baseline-bundle',
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
