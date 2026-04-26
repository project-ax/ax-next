export { createAuthPlugin } from './plugin.js';
export {
  runAuthMigration,
  type AuthDatabase,
  type AuthSessionRow,
  type UserRow,
} from './migrations.js';
export {
  createAuthStore,
  mintSessionId,
  mintUserId,
  type AuthStore,
} from './store.js';
export type {
  AuthConfig,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  GetUserInput,
  GetUserOutput,
  HttpRequestLike,
  RequireUserInput,
  RequireUserOutput,
  User,
} from './types.js';
