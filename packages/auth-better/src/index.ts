export { createAuthBetterPlugin } from './plugin.js';
export {
  runAuthBetterMigration,
  type AuthBetterDatabase,
} from './migrations.js';
export type { AuthBetterConfig } from './plugin.js';
// Re-use the boundary types from auth-oidc — they ARE the contract.
// Allowed exception per Invariant I2: types only, no runtime import.
export type {
  User,
  CreateBootstrapUserInput,
  CreateBootstrapUserOutput,
} from '@ax/auth-oidc';
