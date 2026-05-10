// Public surface of @ax/memory-strata. Phase 1 = Level 0 hot tier
// (system/{agent,user,session}.md) + Level 1 Observer (inbox/<ISO>.md
// extraction with sensitive-content gate). Future phases land in
// follow-up PRs; see docs/plans/memory-strata-design.md for the roadmap.

export { createMemoryStrataPlugin } from './plugin.js';
export type { MemoryStrataConfig } from './plugin.js';

export { bootstrapMemoryTree } from './bootstrap.js';
export type { BootstrapInput } from './bootstrap.js';

export { runObserver } from './observer.js';
export type { LlmCallFn, RunObserverInput, RunObserverResult } from './observer.js';

export {
  workspaceMemoryRoot,
  systemFile,
  inboxFile,
  MEMORY_ROOT,
  SYSTEM_DIR,
  INBOX_DIR,
} from './paths.js';
export type { SystemFileName } from './paths.js';

export { filterSensitive } from './sensitive-gate.js';
export type { FilterResult, RejectedFact, RejectionKind } from './sensitive-gate.js';

export type { MemoryFrontmatter, MemoryFileType, Observation } from './types.js';

export const PLUGIN_NAME = '@ax/memory-strata';
