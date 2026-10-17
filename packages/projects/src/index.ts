export { runProjectsMigration, type ProjectsDatabase, type ProjectRow } from './migrations.js';
export { createProjectsPlugin, PROJECTS_DELETED_HOOK, PROJECTS_BLOCK_HOOK } from './plugin.js';
export { renderProjectBlock, type ProjectBlockInput } from './block.js';
export type {
  ProjectMember,
  ProjectMemberRole,
  ProjectsCreateInput,
  ProjectsCreateOutput,
  ProjectsDeletedEvent,
  ProjectsDeleteInput,
  ProjectsDeleteOutput,
  ProjectsGetInput,
  ProjectsGetOutput,
  ProjectsListInput,
  ProjectsListOutput,
  ProjectsResolveInput,
  ProjectsResolveOutput,
  ProjectsUpdateInput,
  ProjectsUpdateOutput,
} from './types.js';
