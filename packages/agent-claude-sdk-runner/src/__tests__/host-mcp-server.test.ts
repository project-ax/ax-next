import type { IpcClient } from '@ax/agent-runner-core';
import type { ToolDescriptor } from '@ax/ipc-protocol';
import { describe, expect, it } from 'vitest';
import {
  buildHostToolEntries,
  createHostMcpServer,
} from '../host-mcp-server.js';

function mkClient(
  callImpl: (action: string, payload: unknown) => Promise<unknown>,
): { client: IpcClient; calls: Array<{ action: string; payload: unknown }> } {
  const calls: Array<{ action: string; payload: unknown }> = [];
  const client: IpcClient = {
    call: async (action, payload) => {
      calls.push({ action, payload });
      return await callImpl(action, payload);
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    event: async () => {
      throw new Error('event not expected');
    },
    close: async () => {
      /* no-op */
    },
  };
  return { client, calls };
}

const HOST_TOOL_A: ToolDescriptor = {
  name: 'memory.recall',
  description: 'recall a memory',
  inputSchema: { type: 'object' },
  executesIn: 'host',
};
const HOST_TOOL_B: ToolDescriptor = {
  name: 'memory.store',
  description: 'store a memory',
  inputSchema: { type: 'object' },
  executesIn: 'host',
};
const SANDBOX_TOOL: ToolDescriptor = {
  name: 'Bash',
  description: 'run a shell command',
  inputSchema: { type: 'object' },
  executesIn: 'sandbox',
};

// Shape of the SDK tool entry we care about in tests. The full type is
// SdkMcpToolDefinition but we only poke at these fields.
type ToolEntry = {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

describe('buildHostToolEntries', () => {
  it('filters to executesIn=host tools only', () => {
    const { client } = mkClient(async () => ({ output: 'x' }));
    const entries = buildHostToolEntries(
      client,
      [HOST_TOOL_A, SANDBOX_TOOL, HOST_TOOL_B],
    );
    expect(entries.map((e) => (e as ToolEntry).name)).toEqual([
      'memory.recall',
      'memory.store',
    ]);
  });

  it('returns an empty array when no host tools are present', () => {
    const { client } = mkClient(async () => ({ output: 'x' }));
    const entries = buildHostToolEntries(client, [SANDBOX_TOOL]);
    expect(entries).toEqual([]);
  });

  it('handler forwards to tool.execute-host with the right name + input', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    await handler({ query: 'hello' }, {});
    expect(calls).toEqual([
      {
        action: 'tool.execute-host',
        payload: {
          call: { id: 'id-1', name: 'memory.recall', input: { query: 'hello' } },
        },
      },
    ]);
  });

  it('handler renders string output as a single text content block', async () => {
    const { client } = mkClient(async () => ({ output: 'hello world' }));
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    const result = (await handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('handler renders object output as JSON-stringified text', async () => {
    const out = { hits: [1, 2, 3], ok: true };
    const { client } = mkClient(async () => ({ output: out }));
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    const result = (await handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(out) }],
    });
  });

  it('handler renders a null output as the string "null"', async () => {
    // Edge case: typeof null === 'object', so our typeof-string branch does
    // NOT fire; JSON.stringify(null) === 'null' is the sensible default.
    const { client } = mkClient(async () => ({ output: null }));
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    const result = (await handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result).toEqual({ content: [{ type: 'text', text: 'null' }] });
  });

  it('handler on IPC error returns isError=true with the error message', async () => {
    const { client } = mkClient(async () => {
      throw new Error('host refused');
    });
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    const result = (await handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result).toEqual({
      content: [{ type: 'text', text: 'host refused' }],
      isError: true,
    });
  });

  it('handler on non-Error throw stringifies the value', async () => {
    const { client } = mkClient(async () => {
      // Throwing a non-Error is a pathological case — but the SDK
      // MUST get something serializable back so we coerce.
      throw 'plain string';
    });
    const entries = buildHostToolEntries(client, [HOST_TOOL_A], () => 'id-1');
    const handler = (entries[0] as ToolEntry).handler;
    const result = (await handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result).toEqual({
      content: [{ type: 'text', text: 'plain string' }],
      isError: true,
    });
  });

  it('uses the default randomUUID idGen when none is supplied', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const entries = buildHostToolEntries(client, [HOST_TOOL_A]);
    const handler = (entries[0] as ToolEntry).handler;
    await handler({}, {});
    const payload = calls[0]?.payload as { call: { id: string } };
    expect(typeof payload.call.id).toBe('string');
    expect(payload.call.id.length).toBeGreaterThan(0);
  });

  it('tolerates a missing description by falling back to empty string', () => {
    const toolNoDesc: ToolDescriptor = {
      name: 'no.desc',
      inputSchema: { type: 'object' },
      executesIn: 'host',
    };
    const { client } = mkClient(async () => ({ output: 'x' }));
    const entries = buildHostToolEntries(client, [toolNoDesc]);
    expect((entries[0] as ToolEntry).description).toBe('');
  });
});

describe('createHostMcpServer', () => {
  it('returns a server config with name=ax-host-tools and type=sdk', () => {
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const server = createHostMcpServer({
      client,
      tools: [HOST_TOOL_A, HOST_TOOL_B, SANDBOX_TOOL],
    });
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('ax-host-tools');
  });

  it('returns a server even when there are zero host tools', () => {
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const server = createHostMcpServer({ client, tools: [SANDBOX_TOOL] });
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('ax-host-tools');
  });
});
