import { describe, expect, it, vi } from 'vitest';
import type { IpcClient, ToolDescriptor } from '@ax/ipc-protocol';
import { createHoldLatch, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import { POLICY_WRAPPED, type WrappedExecute } from '../tools/policy-wrap.js';
import { buildHostTools } from '../tools/host-tools.js';

function fakePolicy(over: Partial<ToolPolicy> = {}): ToolPolicy & {
  preToolUse: ReturnType<typeof vi.fn>;
  postToolUse: ReturnType<typeof vi.fn>;
} {
  const policy = {
    preToolUse: vi.fn(
      async (): Promise<PreToolVerdict> => ({ decision: 'allow' }),
    ),
    postToolUse: vi.fn(async () => ({})),
    ...over,
  };
  return policy as never;
}

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
    callBinaryUpload: async () => {
      throw new Error('callBinaryUpload not expected');
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

const holdLatch = createHoldLatch();

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
  name: 'host_reads_workspace',
  description: 'a host tool that reads files the agent just wrote',
  inputSchema: { type: 'object' },
  executesIn: 'host',
  flushWorkspaceBeforeCall: true,
};
// A connector-backed MCP tool arrives here as an ordinary host-tool
// descriptor — connectors are host-side in @ax/mcp-client (constraint 6).
// There is nothing distinguishing it in the descriptor shape; that is the
// point. We just need it to register + dispatch identically.
const CONNECTOR_TOOL: ToolDescriptor = {
  name: 'mcp__linear__search_issues',
  description: 'search Linear issues via a connected MCP server',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  executesIn: 'host',
};

const OPTS = { toolCallId: 'call-1', messages: [], context: {} };

function unwrap(execute: unknown): WrappedExecute {
  return execute as WrappedExecute;
}

describe('buildHostTools', () => {
  it('filters to executesIn=host tools only', () => {
    const { client } = mkClient(async () => ({ output: 'x' }));
    const tools = buildHostTools({
      policy: fakePolicy(),
      client,
      tools: [HOST_TOOL_A, SANDBOX_TOOL, HOST_TOOL_B],
      holdLatch,
    });
    expect(Object.keys(tools).sort()).toEqual(['memory.recall', 'memory.store']);
  });

  it('returns an empty object when no host tools are present', () => {
    const { client } = mkClient(async () => ({ output: 'x' }));
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [SANDBOX_TOOL], holdLatch });
    expect(tools).toEqual({});
  });

  it('registers a connector-backed MCP tool like any other host tool (constraint 6)', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'issue-123' }));
    const tools = buildHostTools({
      policy: fakePolicy(),
      client,
      tools: [CONNECTOR_TOOL],
      idGen: () => 'id-1',
      holdLatch,
    });
    expect(Object.keys(tools)).toEqual(['mcp__linear__search_issues']);
    const out = await unwrap(tools['mcp__linear__search_issues']?.execute)(
      { query: 'bug' },
      OPTS,
    );
    expect(out).toBe('issue-123');
    expect(calls).toEqual([
      {
        action: 'tool.execute-host',
        payload: {
          call: { id: 'id-1', name: 'mcp__linear__search_issues', input: { query: 'bug' } },
        },
      },
    ]);
  });

  it('forwards to tool.execute-host with the right name + input', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const tools = buildHostTools({
      policy: fakePolicy(),
      client,
      tools: [HOST_TOOL_A],
      idGen: () => 'id-1',
      holdLatch,
    });
    await unwrap(tools['memory.recall']?.execute)({ query: 'hello' }, OPTS);
    expect(calls).toEqual([
      {
        action: 'tool.execute-host',
        payload: {
          call: { id: 'id-1', name: 'memory.recall', input: { query: 'hello' } },
        },
      },
    ]);
  });

  it('renders string output verbatim', async () => {
    const { client } = mkClient(async () => ({ output: 'hello world' }));
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [HOST_TOOL_A], holdLatch });
    const out = await unwrap(tools['memory.recall']?.execute)({}, OPTS);
    expect(out).toBe('hello world');
  });

  it('renders object output as JSON-stringified text', async () => {
    const payload = { hits: [1, 2, 3], ok: true };
    const { client } = mkClient(async () => ({ output: payload }));
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [HOST_TOOL_A], holdLatch });
    const out = await unwrap(tools['memory.recall']?.execute)({}, OPTS);
    expect(out).toBe(JSON.stringify(payload));
  });

  it('renders a null output as the string "null"', async () => {
    const { client } = mkClient(async () => ({ output: null }));
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [HOST_TOOL_A], holdLatch });
    const out = await unwrap(tools['memory.recall']?.execute)({}, OPTS);
    expect(out).toBe('null');
  });

  it('lets an IPC failure propagate as a throw (constraint 5 — not an isError result)', async () => {
    const { client } = mkClient(async () => {
      throw new Error('host refused');
    });
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [HOST_TOOL_A], holdLatch });
    await expect(unwrap(tools['memory.recall']?.execute)({}, OPTS)).rejects.toThrow(
      'host refused',
    );
  });

  it('uses the default randomUUID idGen when none is supplied', async () => {
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [HOST_TOOL_A], holdLatch });
    await unwrap(tools['memory.recall']?.execute)({}, OPTS);
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
    const tools = buildHostTools({ policy: fakePolicy(), client, tools: [toolNoDesc], holdLatch });
    expect(tools['no.desc']?.description).toBe('');
  });

  // Constraint 4 — the regression the SDK's shapeFromInputSchema workaround
  // existed to prevent. ai@7's jsonSchema() does not validate-and-strip like
  // the SDK's `z.object(shape)` did, so a key the declared schema doesn't
  // mention must still reach the executor (here: still reach the IPC call).
  it('passes an undeclared key straight through to the executor (constraint 4)', async () => {
    const toolWithProps: ToolDescriptor = {
      name: 'echo.host',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      executesIn: 'host',
    };
    const { client, calls } = mkClient(async () => ({ output: 'ok' }));
    const tools = buildHostTools({
      policy: fakePolicy(),
      client,
      tools: [toolWithProps],
      idGen: () => 'id-1',
      holdLatch,
    });
    await unwrap(tools['echo.host']?.execute)(
      { text: 'hi', undeclaredKey: 'still here' },
      OPTS,
    );
    const payload = calls[0]?.payload as { call: { input: Record<string, unknown> } };
    expect(payload.call.input).toEqual({ text: 'hi', undeclaredKey: 'still here' });
  });

  // Every registered execute must be policy-wrapped — enumerate the whole
  // set rather than spot-checking one entry.
  it('policy-wraps every registered execute', () => {
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const tools = buildHostTools({
      policy: fakePolicy(),
      client,
      tools: [HOST_TOOL_A, HOST_TOOL_B, HOST_TOOL_FLUSH, CONNECTOR_TOOL],
      holdLatch,
    });
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const execute = tools[name]?.execute as WrappedExecute | undefined;
      expect(typeof execute).toBe('function');
      expect(execute?.[POLICY_WRAPPED]).toBe(true);
    }
  });

  it('runs the executor through the policy (deny short-circuits the forward)', async () => {
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'not on the allowlist',
      })),
    } as never);
    const { client, calls } = mkClient(async () => ({ output: 'should not run' }));
    const tools = buildHostTools({ policy, client, tools: [HOST_TOOL_A], holdLatch });
    const out = await unwrap(tools['memory.recall']?.execute)({}, OPTS);
    expect(out).toContain('not on the allowlist');
    expect(calls).toEqual([]);
  });

  // A catalog tool is never a builtin, even one that happens to be NAMED
  // `Bash` (like SANDBOX_TOOL above, though that one is executesIn:'sandbox'
  // and thus never reaches buildHostTools). `isBuiltin: false` here is what
  // keeps such a tool OUT of the policy's Bash egress-block drain, which is
  // gated on builtin-AND-Bash.
  it('always tells the policy isBuiltin:false, even for a tool named Bash', async () => {
    const policy = fakePolicy();
    const hostNamedBash: ToolDescriptor = { ...HOST_TOOL_A, name: 'Bash' };
    const { client } = mkClient(async () => ({ output: 'ok' }));
    const tools = buildHostTools({ policy, client, tools: [hostNamedBash], holdLatch });
    await unwrap(tools['Bash']?.execute)({}, OPTS);
    expect(policy.preToolUse).toHaveBeenCalledWith('Bash', {}, 'call-1');
    expect(policy.postToolUse).toHaveBeenCalledWith(
      'Bash',
      'call-1',
      {},
      'ok',
      false,
    );
  });

  describe('flushWorkspaceBeforeCall precondition gate (BUG-W2)', () => {
    it('flushes the workspace BEFORE forwarding when the descriptor requires it', async () => {
      const order: string[] = [];
      const { client } = mkClient(async () => {
        order.push('forward');
        return { output: 'ok' };
      });
      const flushWorkspace = async (): Promise<'accepted'> => {
        order.push('flush');
        return 'accepted';
      };
      const tools = buildHostTools({
        policy: fakePolicy(),
        client,
        tools: [HOST_TOOL_FLUSH],
        flushWorkspace,
        holdLatch,
      });
      await unwrap(tools['host_reads_workspace']?.execute)({}, OPTS);
      expect(order).toEqual(['flush', 'forward']);
    });

    it('forwards on a no-op flush (already synced on a prior turn)', async () => {
      const { client, calls } = mkClient(async () => ({ output: 'ok' }));
      const flushWorkspace = async (): Promise<'noop'> => 'noop';
      const tools = buildHostTools({
        policy: fakePolicy(),
        client,
        tools: [HOST_TOOL_FLUSH],
        flushWorkspace,
        holdLatch,
      });
      const out = await unwrap(tools['host_reads_workspace']?.execute)({}, OPTS);
      expect(calls.map((c) => c.action)).toEqual(['tool.execute-host']);
      expect(out).toBe('ok');
    });

    it('does NOT flush for a host tool without flushWorkspaceBeforeCall', async () => {
      let flushed = false;
      const { client, calls } = mkClient(async () => ({ output: 'ok' }));
      const flushWorkspace = async (): Promise<'accepted'> => {
        flushed = true;
        return 'accepted';
      };
      const tools = buildHostTools({
        policy: fakePolicy(),
        client,
        tools: [HOST_TOOL_A],
        flushWorkspace,
        holdLatch,
      });
      await unwrap(tools['memory.recall']?.execute)({}, OPTS);
      expect(flushed).toBe(false);
      expect(calls.map((c) => c.action)).toEqual(['tool.execute-host']);
    });

    it('forwards anyway when a flagged tool has no flushWorkspace wired', async () => {
      const { client, calls } = mkClient(async () => ({ output: 'ok' }));
      const tools = buildHostTools({
        policy: fakePolicy(),
        client,
        tools: [HOST_TOOL_FLUSH],
        holdLatch,
      });
      const out = await unwrap(tools['host_reads_workspace']?.execute)({}, OPTS);
      expect(calls.map((c) => c.action)).toEqual(['tool.execute-host']);
      expect(out).toBe('ok');
    });

    it.each(['kept', 'rolled-back'] as const)(
      'does NOT forward and raises a retryable tool error when the flush is %s',
      async (outcome) => {
        const order: string[] = [];
        const { client } = mkClient(async () => {
          order.push('forward');
          return { output: 'host-ok' };
        });
        const flushWorkspace = async (): Promise<typeof outcome> => {
          order.push('flush');
          return outcome;
        };
        const tools = buildHostTools({
          policy: fakePolicy(),
          client,
          tools: [HOST_TOOL_FLUSH],
          flushWorkspace,
          holdLatch,
        });
        // Throws, so the host records `is_error` and the UI renders a FAILED
        // tool — matching the SDK runner's `{ isError: true }` shim. The turn
        // survives: ai@7 turns this into an error-text tool result and keeps
        // looping, so the model reads the message and can retry.
        await expect(
          unwrap(tools['host_reads_workspace']?.execute)({}, OPTS),
        ).rejects.toThrow(new RegExp(outcome));
        // Flushed, but did NOT forward.
        expect(order).toEqual(['flush']);
      },
    );

    it('does NOT forward and raises a retryable tool error when the flush throws', async () => {
      const order: string[] = [];
      const { client } = mkClient(async () => {
        order.push('forward');
        return { output: 'host-ok' };
      });
      const flushWorkspace = async (): Promise<'accepted'> => {
        order.push('flush-throw');
        throw new Error('commit-notify unreachable');
      };
      const tools = buildHostTools({
        policy: fakePolicy(),
        client,
        tools: [HOST_TOOL_FLUSH],
        flushWorkspace,
        holdLatch,
      });
      await expect(
        unwrap(tools['host_reads_workspace']?.execute)({}, OPTS),
      ).rejects.toThrow(/flush outcome: error/);
      expect(order).toEqual(['flush-throw']);
    });
  });
});
