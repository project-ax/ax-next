import type { Plugin } from '@ax/core';
import { registerWorkspaceGitHooks } from '@ax/workspace-git-core';

const PLUGIN_NAME = '@ax/workspace-git';

export interface WorkspaceGitConfig {
  /**
   * Absolute path to the directory that will host the bare repositories,
   * one per `agentId` at `<repoRoot>/<workspaceId>.git`. The plugin
   * idempotently `git.init`s each on first use. Capabilities are scoped to
   * this directory only — nothing outside `repoRoot` is read or written.
   */
  repoRoot: string;
}

/**
 * Single-replica workspace plugin backed by bare `isomorphic-git`
 * repositories on disk — ONE PER AGENT (TASK-396; it was one repo for the
 * whole deployment before, which is how a user got served another user's
 * agent's file). Thin wrapper over `@ax/workspace-git-core` — registers the
 * four base `workspace:*` service hooks plus the two Phase 3 bundle hooks
 * (`workspace:apply-bundle` + `workspace:export-baseline-bundle`) against a
 * local repoRoot. Use this for the local CLI / single-pod deployments.
 * Multi-replica deployments use `@ax/workspace-git-server` instead.
 *
 * Be precise about what the partition does and does not buy, because the
 * comment this replaced got it wrong in the direction that matters: the
 * partition is `agentId` ALONE (matching `@ax/workspace-git-server` since
 * TASK-257), so it separates AGENTS, not USERS. Every user authorized to
 * reach an agent sees that agent's tree — that is the intended behaviour for
 * team agents. The thing that decides who may reach an agent is the
 * `agents:resolve` ACL the callers run before every per-agent read, not this
 * plugin.
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
