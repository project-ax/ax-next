export {
  dispatch,
} from './dispatcher.js';
export {
  authenticate,
  type AuthResult,
} from './auth.js';
export {
  readJsonBody,
  BadJsonError,
  TooLargeError,
  type ReadBodyResult,
} from './body.js';
export {
  writeJsonError,
  writeJsonOk,
} from './response.js';
export {
  validationError,
  notFound,
  hookRejected,
  mapPluginError,
  internalError,
  logInternalError,
  type IpcErrorCode,
} from './errors.js';
// Phase 3: handlers exported so the preset-k8s acceptance test can
// drive the bundler-driven workspace.commit-notify pipeline against a
// real workspace-git-server backend without going through the IPC
// transport. Production callers always reach handlers via `dispatch`;
// these direct exports are an integration-test seam.
export { workspaceCommitNotifyHandler } from './handlers/workspace-commit-notify.js';
export {
  workspaceMaterializeHandler,
  buildBaselineBundle,
} from './handlers/workspace-materialize.js';
