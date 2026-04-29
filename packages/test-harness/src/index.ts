import { fileURLToPath } from 'node:url';

export * from './harness.js';
export * from './mock-services.js';
export { createMockWorkspacePlugin } from './mock-workspace.js';
export { createTestHostToolPlugin } from './test-host-tool.js';
export { runWorkspaceContract } from './workspace-contract.js';
export {
  StubRunnerScriptSchema,
  type StubRunnerScript,
  encodeScript,
  decodeScript,
} from './script-schema.js';

/**
 * Absolute path to the built minimal stdio MCP server stub. Spawn via
 * `child_process.spawn(process.execPath, [mcpServerStubPath])`, or hand
 * it to `StdioClientTransport({ command: process.execPath, args: [...] })`,
 * to drive the real subprocess + stdio-pipe codepath in tests.
 *
 * The path always points at the built artifact in `dist/`, even when this
 * module is loaded from TypeScript source during Vitest — callers always
 * need a runnable `.js` file to spawn, and there is no runnable version
 * of the stub in `src/`. Consumers must `pnpm --filter @ax/test-harness
 * build` before spawning.
 */
export const mcpServerStubPath = fileURLToPath(
  new URL('./mcp-server-stub.js', import.meta.url),
).replace(/\/src\/mcp-server-stub\.js$/, '/dist/mcp-server-stub.js');

/**
 * Absolute path to the built stub agent runner. Spawned via
 * `child_process.spawn(process.execPath, [stubRunnerPath], { env })` by the
 * chat-orchestrator e2e tests in place of `@ax/agent-claude-sdk-runner` —
 * lets a test drive the real IPC wire path without a live LLM.
 *
 * Same build-artifact contract as `mcpServerStubPath`: the export always
 * points at `dist/stub-runner.js`, and consumers must run
 * `pnpm --filter @ax/test-harness build` before spawning.
 */
export const stubRunnerPath = fileURLToPath(
  new URL('./stub-runner.js', import.meta.url),
).replace(/\/src\/stub-runner\.js$/, '/dist/stub-runner.js');
