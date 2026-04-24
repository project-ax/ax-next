import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { mcpServerStubPath } from '../index.js';

// These tests spawn a real subprocess and drive it through the MCP SDK's
// StdioClientTransport — same codepath the Task 18 acceptance test uses.
// Unit-level in-memory transport coverage lives in @ax/mcp-client; here we
// just confirm the stub itself behaves as advertised end-to-end.

async function spawnStubClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerStubPath],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'mcp-server-stub.test', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

describe('mcp-server-stub', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      try {
        await fn();
      } catch {
        // best effort
      }
    }
  });

  it('builds to the expected dist path', () => {
    // The exported path must point at an already-built artifact for the
    // Task 18 acceptance test to spawn it. If this fails, the package
    // hasn't been built — run `pnpm --filter @ax/test-harness build`.
    expect(existsSync(mcpServerStubPath)).toBe(true);
    expect(mcpServerStubPath).toMatch(/\/dist\/mcp-server-stub\.js$/);
  });

  it('lists the echo and crash tools over real stdio transport', async () => {
    const { client } = await spawnStubClient();
    cleanups.push(() => client.close());

    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['crash', 'echo']);
  });

  it('echo returns the input text verbatim', async () => {
    const { client } = await spawnStubClient();
    cleanups.push(() => client.close());

    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'acceptance' },
    });
    // SDK result shape: { content: [{ type: 'text', text: '...' }], ... }
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('acceptance');
  });

  it('crash causes the subprocess to exit with code 1', async () => {
    // Spawn manually so we can observe the `exit` event directly — the
    // SDK's StdioClientTransport owns the child process and does not
    // surface its exit code. We speak JSON-RPC over stdin by hand: MCP
    // requires `initialize` before any other request, and we only need
    // to fire one `tools/call` to prove the crash path.
    const child: ChildProcess = spawn(process.execPath, [mcpServerStubPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanups.push(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    });

    const send = (obj: unknown): void => {
      child.stdin!.write(`${JSON.stringify(obj)}\n`);
    };

    const lines: string[] = [];
    let buf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });

    const waitForId = async (id: number): Promise<void> => {
      const deadline = Date.now() + 5000;
      for (;;) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line == null || line.length === 0) continue;
          try {
            const msg = JSON.parse(line) as { id?: number };
            if (msg.id === id) {
              lines.splice(i, 1);
              return;
            }
          } catch {
            // ignore non-JSON lines (shouldn't happen on stdout)
          }
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for id=${id}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'crash-test', version: '0.0.0' },
      },
    });
    await waitForId(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'crash', arguments: {} },
    });

    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(code).toBe(1);
  });
});
