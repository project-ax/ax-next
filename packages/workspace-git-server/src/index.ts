// @ax/workspace-git-server — Phase 1 of the workspace redesign.
// See docs/plans/2026-05-01-workspace-redesign-design.md for the architecture
// and docs/plans/2026-05-01-workspace-redesign-phase-1-plan.md for the slice plan.
//
// Public surface: the production plugin factory + workspaceId derivation.
// The test-only factory (`plugin-test-only.ts`) and the internal helpers
// (mirror-cache, repo-lifecycle, git-engine, retry) are intentionally
// NOT re-exported — callers go through the plugin's hook surface, not its
// internals.
export {
  createWorkspaceGitServerPlugin,
  type CreateWorkspaceGitServerPluginOptions,
} from './client/plugin.js';
export { workspaceIdFor } from './client/workspace-id.js';
