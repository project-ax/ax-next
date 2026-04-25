import { fileURLToPath } from 'node:url';

export * from './harness.js';
export * from './mock-services.js';
export { createMockWorkspacePlugin } from './mock-workspace.js';
export { createTestHostToolPlugin } from './test-host-tool.js';
export { runWorkspaceContract } from './workspace-contract.js';

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
