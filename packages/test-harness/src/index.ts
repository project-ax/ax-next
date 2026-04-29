import { fileURLToPath } from 'node:url';

export * from './harness.js';
export * from './mock-services.js';
export { createMockWorkspacePlugin } from './mock-workspace.js';
export { createTestHostToolPlugin } from './test-host-tool.js';
export { createTestProxyPlugin } from './test-proxy-plugin.js';
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
 * Resolved via `new URL('../dist/...', import.meta.url)` so the path is
 * native-separator-correct on Windows. From src (vitest): `<root>/src/index.ts`
 * → `<root>/dist/mcp-server-stub.js`. From dist (built): `<root>/dist/index.js`
 * → `<root>/dist/mcp-server-stub.js`. Both produce the same dist path.
 *
 * Consumers must `pnpm --filter @ax/test-harness build` before spawning.
 */
export const mcpServerStubPath = fileURLToPath(
  new URL('../dist/mcp-server-stub.js', import.meta.url),
);

/**
 * Absolute path to the built stub agent runner. Spawned via
 * `child_process.spawn(process.execPath, [stubRunnerPath], { env })` by the
 * chat-orchestrator e2e tests in place of `@ax/agent-claude-sdk-runner` —
 * lets a test drive the real IPC wire path without a live LLM.
 *
 * Same resolution contract as `mcpServerStubPath` (cross-platform via
 * `new URL('../dist/...')`).
 */
export const stubRunnerPath = fileURLToPath(
  new URL('../dist/stub-runner.js', import.meta.url),
);
