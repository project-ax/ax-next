import type { WorkspaceActionName } from './actions.js';

// Apply gets the longest because tree-write + commit can block behind
// the mutex on a busy git-server. Read/list are fast.
export const WORKSPACE_TIMEOUTS_MS: Record<WorkspaceActionName, number> = {
  'workspace.apply': 30_000,
  'workspace.read': 10_000,
  'workspace.list': 10_000,
  'workspace.diff': 30_000,
};
