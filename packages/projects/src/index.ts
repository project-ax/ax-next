export { runProjectsMigration, type ProjectsDatabase, type ProjectRow } from './migrations.js';
export { createProjectsPlugin, PROJECTS_DELETED_HOOK, PROJECTS_BLOCK_HOOK } from './plugin.js';
export {
  renderProjectBlock,
  renderProjectContext,
  type ProjectBlockInput,
  type ProjectContextInput,
  type ContextFilePart,
  type ContextTreePart,
  type ContextTreeEntry,
} from './block.js';
export {
  READ_FILE_PREVIEW_MAX_BYTES,
  READ_FILE_MAX_ENTRIES,
  DOWNLOAD_FILE_MAX_BYTES,
} from './types.js';
export type {
  ProjectMember,
  ProjectMemberRole,
  ProjectsCreateInput,
  ProjectsCreateOutput,
  ProjectsDeletedEvent,
  ProjectsDeleteInput,
  ProjectsDeleteOutput,
  ProjectsDownloadFileInput,
  ProjectsDownloadFileOutput,
  ProjectsDownloadRefusal,
  ProjectFileEntry,
  ProjectsGetInput,
  ProjectsGetOutput,
  ProjectsListInput,
  ProjectsListOutput,
  ProjectsReadFileInput,
  ProjectsReadFileOutput,
  ProjectsResolveInput,
  ProjectsResolveOutput,
  ProjectsUpdateInput,
  ProjectsUpdateOutput,
} from './types.js';
