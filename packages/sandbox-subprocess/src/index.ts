export { createSandboxSubprocessPlugin } from './plugin.js';
export {
  OpenSessionInputSchema,
  openSessionImpl,
  type OpenSessionInput,
  type OpenSessionParsed,
  type OpenSessionResult,
  type OpenSessionHandle,
} from './open-session.js';
// The pure descriptor → `docker compose` project translation (TASK-152). The
// subprocess backend's RENDER contract: a neutral ServiceDescriptor becomes a
// loopback-published, tmpfs-scratch compose project. Exported so the
// dev-services CI canary (TASK-155) can render the descriptor that reaches
// `sandbox:open-session` through the SAME function production uses, and assert
// the locked posture (I4/I8/I10) structurally — the k8s twin `buildPodSpec` is
// likewise exported from @ax/sandbox-k8s.
export {
  descriptorsToComposeProject,
  type ComposeProject,
} from './compose.js';
