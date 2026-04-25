export { createIpcServerPlugin } from './plugin.js';
export { createListener, type Listener, type CreateListenerOptions } from './listener.js';
// Back-compat re-exports — canonical home is now @ax/ipc-core. Existing
// @ax/ipc-server consumers keep working without import-path churn; new
// consumers should import from @ax/ipc-core directly.
export {
  authenticate,
  type AuthResult,
  readJsonBody,
  BadJsonError,
  TooLargeError,
  type ReadBodyResult,
  writeJsonError,
  writeJsonOk,
  dispatch,
} from '@ax/ipc-core';
