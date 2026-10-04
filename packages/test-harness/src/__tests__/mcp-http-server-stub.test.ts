import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServerStub } from '../index.js';

const stubs: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'stub-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe('mcp-http-server-stub', () => {
  it('lists echo + crash and echoes text', async () => {
    const stub = await startMcpHttpServerStub();
    stubs.push(stub);
    const client = await connect(stub.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);
    const r = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
    await client.close();
  });

  it('crash kills the server so the call fails', async () => {
    const stub = await startMcpHttpServerStub();
    stubs.push(stub);
    const client = await connect(stub.url);
    await expect(client.callTool({ name: 'crash', arguments: {} })).rejects.toThrow();
    await client.close().catch(() => {});
  });
});
