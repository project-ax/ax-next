import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export * from './harness.js';
export * from './mock-services.js';
export { signInAsAdmin } from './sign-in.js';
export type { SignInAsAdminOptions, SignInAsAdminResult } from './sign-in.js';
export { createMockWorkspacePlugin } from './mock-workspace.js';
export { createTestHostToolPlugin } from './test-host-tool.js';
export { createTestProxyPlugin } from './test-proxy-plugin.js';
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
 * Start the streamable-HTTP MCP server stub (`dist/mcp-http-server-stub.js`)
 * as a child process and resolve once it is listening. `close()` kills it.
 * Consumers must `pnpm --filter @ax/test-harness build` first.
 */
export async function startMcpHttpServerStub(): Promise<{ url: string; close(): Promise<void> }> {
  const stubPath = fileURLToPath(new URL('../dist/mcp-http-server-stub.js', import.meta.url));
  const child = spawn(process.execPath, [stubPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString('utf-8');
      const m = /LISTENING (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.once('exit', (code) => reject(new Error(`mcp-http-server-stub exited before listening (code ${code})`)));
    child.once('error', reject);
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

/**
 * Absolute path to the built stub agent runner. Spawned via
 * `child_process.spawn(process.execPath, [stubRunnerPath], { env })` by the
 * chat-orchestrator e2e tests in place of `@ax/agent-claude-sdk-runner` —
 * lets a test drive the real IPC wire path without a live LLM.
 *
 * Same resolution contract as `startMcpHttpServerStub` (cross-platform via
 * `new URL('../dist/...')`).
 */
export const stubRunnerPath = fileURLToPath(
  new URL('../dist/stub-runner.js', import.meta.url),
);
