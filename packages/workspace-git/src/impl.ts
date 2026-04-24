import type { HookBus } from '@ax/core';
import type { WorkspaceGitConfig } from './plugin.js';

/**
 * Hook registration is implemented in Task 6. The scaffold (Task 5) ships
 * the manifest only; consumers can already inspect `p.manifest`, but
 * actually calling `workspace:apply`/`read`/`list`/`diff` lights up in the
 * next commit.
 */
export function registerWorkspaceGitHooks(
  _bus: HookBus,
  _config: WorkspaceGitConfig,
): void {
  // intentionally empty for the scaffold commit
}
