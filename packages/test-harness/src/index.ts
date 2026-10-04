import { fileURLToPath } from 'node:url';

export * from './harness.js';
export * from './mock-services.js';
export { signInAsAdmin } from './sign-in.js';
export type { SignInAsAdminOptions, SignInAsAdminResult } from './sign-in.js';
export { createMockWorkspacePlugin } from './mock-workspace.js';
export { createTestHostToolPlugin } from './test-host-tool.js';
export { createTestProxyPlugin, TEST_PROXY_AUTH_TOKEN } from './test-proxy-plugin.js';
export { runWorkspaceContract } from './workspace-contract.js';
export { bootPluginGraph } from './boot-plugin-graph.js';
export {
  stopPostgresContainer,
  type StoppableContainer,
} from './stop-postgres-container.js';
export {
  preflightDocker,
  startTestContainer,
  DOCKER_PREFLIGHT_TIMEOUT_MS,
  DOCKER_BUSY_CONTAINER_COUNT,
  type DockerPreflightOptions,
  type StartableTestContainer,
} from './docker-preflight.js';
export {
  StubRunnerScriptSchema,
  type StubRunnerScript,
  encodeScript,
  decodeScript,
} from './script-schema.js';

/**
 * Absolute path to the built stub agent runner. Spawned via
 * `child_process.spawn(process.execPath, [stubRunnerPath], { env })` by the
 * chat-orchestrator e2e tests in place of `@ax/agent-claude-sdk-runner` —
 * lets a test drive the real IPC wire path without a live LLM.
 *
 * Resolved cross-platform via `new URL('../dist/...')`. Consumers must
 * `pnpm --filter @ax/test-harness build` first.
 */
export const stubRunnerPath = fileURLToPath(
  new URL('../dist/stub-runner.js', import.meta.url),
);
