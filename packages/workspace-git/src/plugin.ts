import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';

const PLUGIN_NAME = '@ax/workspace-git';

export interface WorkspaceGitConfig {
  /**
   * Absolute path to the directory that will host the bare repositories,
   * one per `(userId, agentId)` at `<repoRoot>/<workspaceId>.git`. The plugin
   * idempotently `git.init`s each on first use. Capabilities are scoped to
   * this directory only — nothing outside `repoRoot` is read or written.
   */
  repoRoot: string;
}

/**
 * Single-replica workspace plugin backed by bare `isomorphic-git`
 * repositories on disk — one per (userId, agentId), so the tree this
 * deployment serves a user is that user's agent's tree and nobody else's
 * (TASK-396; it was one shared repo before). Thin wrapper over
 * `@ax/workspace-git-core` —
 * registers the four base `workspace:*` service hooks plus the two
 * Phase 3 bundle hooks (`workspace:apply-bundle` +
 * `workspace:export-baseline-bundle`) against a local repoRoot. Use
 * this for the local CLI / single-pod deployments. Multi-replica
 * deployments use `@ax/workspace-git-http` instead.
 *
 * The bundle hooks are what enables multi-turn /agent persistence:
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
        'workspace:apply-internal',
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
