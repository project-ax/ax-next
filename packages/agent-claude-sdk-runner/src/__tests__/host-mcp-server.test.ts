import type { IpcClient, ToolDescriptor } from '@ax/ipc-protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    callBinary: async () => {
      throw new Error('callBinary not expected');
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
const HOST_TOOL_FLUSH: ToolDescriptor = {
  name: 'install_authored_skill',
  description: 'install an authored skill',
  inputSchema: { type: 'object' },
  executesIn: 'host',
  flushWorkspaceBeforeCall: true,
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

  // Regression: the SDK's `tool()` helper wraps our raw shape in
  // `z.object(shape)`, which STRIPS keys not declared in the shape before
  // the handler sees them. If we pass an empty shape the model's input is
  // erased. We build the shape from `inputSchema.properties` so declared
  // keys survive. Caught by Week 6.5d e2e Task 14.
  it('builds a per-property shape so the SDK preserves declared input keys', () => {
    const toolWithProps: ToolDescriptor = {
      name: 'echo.host',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['text'],
      },
      executesIn: 'host',
    };
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const entries = buildHostToolEntries(client, [toolWithProps]);
    type InternalEntry = ToolEntry & {
      inputSchema: Record<string, z.ZodTypeAny>;
    };
    const shape = (entries[0] as InternalEntry).inputSchema;
    expect(Object.keys(shape).sort()).toEqual(['count', 'text']);
    // Defensive: confirm the entries are indeed Zod types (so the SDK's
    // internal z.object(shape) wrap works without a runtime type crash).
    for (const key of Object.keys(shape)) {
      expect(shape[key]).toHaveProperty('_def');
    }
  });

  // BUG-W2 regression: a host tool that reads workspace files the agent wrote
  // earlier in the SAME turn (install_authored_skill → .ax/skills/<id>/SKILL.md)
  // must have the runner flush its live tree to the host mirror BEFORE the
  // forward, or the host reads a stale mirror and fails authored-skill-not-found.
  it('flushes the workspace BEFORE forwarding a flushWorkspaceBeforeCall tool', async () => {
    const order: string[] = [];
    const { client } = mkClient(async () => {
      order.push('forward');
      return { output: 'ok' };
    });
    const flushWorkspace = async (): Promise<void> => {
      order.push('flush');
    };
    const entries = buildHostToolEntries(
      client,
      [HOST_TOOL_FLUSH],
      () => 'id-1',
      flushWorkspace,
    );
    await (entries[0] as ToolEntry).handler({}, {});
    // Flush must complete before the host call goes out — order is the contract.
    expect(order).toEqual(['flush', 'forward']);
  });

  it('does NOT flush for a host tool without flushWorkspaceBeforeCall', async () => {
    let flushed = false;
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const flushWorkspace = async (): Promise<void> => {
      flushed = true;
    };
    const entries = buildHostToolEntries(
      client,
      [HOST_TOOL_A],
      () => 'id-1',
      flushWorkspace,
    );
    await (entries[0] as ToolEntry).handler({}, {});
    expect(flushed).toBe(false);
    expect(calls.map((c) => c.action)).toEqual(['tool.execute-host']);
  });

  it('forwards anyway when a flagged tool has no flushWorkspace wired', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    // No flushWorkspace arg — e.g. a workspace-less deployment. The flag is a
    // no-op and the call still forwards.
    const entries = buildHostToolEntries(client, [HOST_TOOL_FLUSH], () => 'id-1');
    const result = (await (entries[0] as ToolEntry).handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(calls.map((c) => c.action)).toEqual(['tool.execute-host']);
    expect(result.content[0]?.text).toBe('ok');
  });

  it('forwards anyway (degrades) when the flush throws', async () => {
    const order: string[] = [];
    const { client } = mkClient(async () => {
      order.push('forward');
      return { output: 'host-ok' };
    });
    const flushWorkspace = async (): Promise<void> => {
      order.push('flush-throw');
      throw new Error('commit-notify unreachable');
    };
    const entries = buildHostToolEntries(
      client,
      [HOST_TOOL_FLUSH],
      () => 'id-1',
      flushWorkspace,
    );
    const result = (await (entries[0] as ToolEntry).handler({}, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    // The flush failure must NOT abort the turn — we forward and let the host
    // tool surface its own outcome (here, success).
    expect(order).toEqual(['flush-throw', 'forward']);
    expect(result).toEqual({ content: [{ type: 'text', text: 'host-ok' }] });
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
