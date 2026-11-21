export { createAuthBetterPlugin } from './plugin.js';
export {
  runAuthBetterMigration,
  type AuthBetterDatabase,
} from './migrations.js';
export type { AuthBetterConfig } from './plugin.js';
export type {
  CompleteBootstrapUserInput,
  CompleteBootstrapUserOutput,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
  FindUserByEmailInput,
  FindUserByEmailOutput,
  IsApprovedEmailInput,
  IsApprovedEmailOutput,
  ListAdminsInput,
  ListAdminsOutput,
  GetUserInput,
  GetUserOutput,
  HttpRequestLike,
  RequireUserInput,
  RequireUserOutput,
  User,
} from './types.js';
