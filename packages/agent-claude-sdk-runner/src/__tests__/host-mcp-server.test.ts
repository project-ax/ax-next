import { IpcRequestError } from '@ax/ipc-protocol';
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
// A host tool that reads files the agent just wrote: the kind that once had
// the runner flush its git workspace first (retired in TASK-995).
const HOST_TOOL_READS_FILES: ToolDescriptor = {
  name: 'host_reads_files',
  description: 'a host tool that reads files the agent just wrote',
  inputSchema: { type: 'object' },
  executesIn: 'host',
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

  // TASK-995: there is no workspace to flush, and the descriptor field that
  // asked for a flush is gone from the wire. A host tool that reads the
  // agent's files forwards like any other — straight to `tool.execute-host`,
  // with nothing run first. The fourth argument is what the old flush gate
  // took; nothing may call it now.
  it("forwards a host tool that reads the agent's files straight to tool.execute-host, with no flush first", async () => {
    const { client, calls } = mkClient(async () => ({ output: 'host-ok' }));
    let flushed = false;
    const legacyFlush = async () => {
      flushed = true;
      return { outcome: 'kept' as const };
    };
    const entries = (
      buildHostToolEntries as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof buildHostToolEntries>
    )(client, [HOST_TOOL_READS_FILES], () => 'id-1', legacyFlush);
    const result = (await (entries[0] as ToolEntry).handler({ q: 'x' }, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(flushed).toBe(false);
    expect(calls).toEqual([
      {
        action: 'tool.execute-host',
        payload: { call: { id: 'id-1', name: 'host_reads_files', input: { q: 'x' } } },
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('host-ok');
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

  it('advertises nested host input schemas as metadata without adding SDK validation', async () => {
    const definition = {
      type: 'object', additionalProperties: false,
      required: ['name', 'promptBody', 'trigger'],
      properties: {
        name: { type: 'string' }, promptBody: { type: 'string' },
        trigger: { oneOf: [
          { type: 'object', required: ['kind', 'every'], properties: { kind: { const: 'interval' }, every: { type: 'string' } } },
          { type: 'object', required: ['kind', 'expr', 'tz'], properties: { kind: { const: 'cron' }, expr: { type: 'string' }, tz: { type: 'string' } } },
          { type: 'object', required: ['kind', 'path'], properties: { kind: { const: 'webhook' }, path: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } } },
        ] },
      },
    };
    const patch = { ...definition, required: [], description: 'Only supplied fields change.' };
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const server = createHostMcpServer({ client, tools: [{
      name: 'routine_create', executesIn: 'host', inputSchema: {
        type: 'object', required: ['requestId', 'definition'],
        properties: { requestId: { type: 'string' }, definition, patch },
      },
    }] });
    // Exercise the actual advertised MCP response, not an adapter helper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (server.instance as any).server._requestHandlers.get('tools/list');
    const { tools } = await handler({ method: 'tools/list', params: {} }, {});
    const properties = tools[0].inputSchema.properties;
    expect(properties.definition.description).toContain('JSON schema: ');
    expect(JSON.parse(properties.definition.description.split('JSON schema: ')[1])).toEqual(definition);
    expect(properties.patch.description).toContain('Only supplied fields change.');
    expect(JSON.parse(properties.patch.description.split('JSON schema: ')[1])).toEqual(patch);
    expect(properties.requestId.description).toBeUndefined();
    // Authority and strict validation stay on the host. The SDK preserves a
    // malformed nested call so it can receive the host's safe field error.
    const entries = buildHostToolEntries(client, [{ name: 'routine_create', executesIn: 'host', inputSchema: { type: 'object', properties: { definition } } }]);
    const shape = (entries[0] as unknown as { inputSchema: Record<string, z.ZodTypeAny> }).inputSchema;
    expect(z.object(shape).parse({ definition: { instructions: 'wrong field' } })).toEqual({ definition: { instructions: 'wrong field' } });
  });

  it('advertises per-property descriptions from the JSON Schema in tools/list', async () => {
    const toolWithDescribedProps: ToolDescriptor = {
      name: 'memory.recall.described',
      description: 'recall with a described input schema',
      inputSchema: {
        type: 'object',
        properties: {
          about: { type: 'string', description: 'what to recall about' },
          limit: { type: 'number' },
          when: { type: 'string', description: 42 },
        },
      },
      executesIn: 'host',
    };
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const server = createHostMcpServer({
      client,
      tools: [toolWithDescribedProps],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (server.instance as any).server._requestHandlers.get(
      'tools/list',
    );
    expect(handler).toBeTypeOf('function');

    const res = await handler({ method: 'tools/list', params: {} }, {});
    const advertised = res.tools.find(
      (t: { name: string }) => t.name === 'memory.recall.described',
    );
    expect(advertised).toBeDefined();
    const props = advertised.inputSchema.properties;

    // Described property: the model sees the authored description.
    expect(props.about.description).toBe('what to recall about');
    // Undescribed property: key survives, no description.
    expect(props.limit).toBeDefined();
    expect(props.limit.description).toBeUndefined();
    // Non-string `description`: key survives, no description, no throw.
    expect(props.when).toBeDefined();
    expect(props.when.description).toBeUndefined();
  });
});

it('returns an actionable routine IPC refusal as an MCP error', async () => {
  const message = 'The routine changed. Read it with routine_get and submit a fresh edit. Field: expectedRevision';
  const { client } = mkClient(async () => { throw new IpcRequestError('HOOK_REJECTED', 409, message); });
  const entries = buildHostToolEntries(client, [{ ...HOST_TOOL_A, name: 'routine_update' }]);
  const result = await (entries[0] as ToolEntry).handler({}, {});
  expect(result).toEqual({ content: [{ type: 'text', text: message }], isError: true });
});
