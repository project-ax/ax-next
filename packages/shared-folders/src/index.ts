export {
  runSharedFoldersMigration,
  type SharedFoldersDatabase,
  type SharedFolderRow,
  type SharedFolderGrantRow,
  type SharedFolderRole,
} from './migrations.js';
export {
  createSharedFoldersPlugin,
  ACCESS_REDUCED_HOOK,
  type SharedFoldersPlugin,
  type SharedFoldersPluginOptions,
} from './plugin.js';
export type {
  SharedFoldersAccessReducedEvent,
  SharedFoldersCreateInput,
  SharedFoldersCreateOutput,
  SharedFoldersDeleteInput,
  SharedFoldersDeleteOutput,
  SharedFoldersGrantInput,
  SharedFoldersGrantOutput,
  SharedFoldersListInput,
  SharedFoldersListOutput,
  SharedFoldersRevokeInput,
  SharedFoldersRevokeOutput,
} from './types.js';
