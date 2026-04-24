import type { IpcClient } from '@ax/agent-runner-core';
import { describe, expect, it, vi } from 'vitest';
import { createCanUseTool } from '../can-use-tool.js';

// Minimal IpcClient stub factory — only `call` matters here. The other
// methods throw if touched so we notice accidental use.
function mkClient(
  callImpl: (action: string, payload: unknown) => Promise<unknown>,
): { client: IpcClient; calls: Array<{ action: string; payload: unknown }> } {
  const calls: Array<{ action: string; payload: unknown }> = [];
  const client: IpcClient = {
    async call(action, payload) {
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

// Minimal options object — we pass only what the adapter needs. The SDK's
// CanUseTool type requires a `signal`; toolUseID is also required by the
// 0.2.119 typings.
const OPTS = {
  signal: new AbortController().signal,
  toolUseID: 'tu_test',
} as const;

describe('createCanUseTool', () => {
  it('returns allow + echoes input when host verdict is allow without modifiedCall', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-1' });
    const result = await canUseTool('Bash', { command: 'ls' }, OPTS);
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(calls).toEqual([
      {
        action: 'tool.pre-call',
        payload: { call: { id: 'uuid-1', name: 'Bash', input: { command: 'ls' } } },
      },
    ]);
  });

  it('returns allow with the modifiedCall.input when host rewrote it', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'allow',
      modifiedCall: { id: 'uuid-2', name: 'Bash', input: { command: 'ls -la' } },
    }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-2' });
    const result = await canUseTool('Bash', { command: 'ls' }, OPTS);
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  it('returns deny with the host-supplied reason on verdict=reject', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'reject',
      reason: 'path escapes workspace root',
    }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-3' });
    const result = await canUseTool('Bash', { command: 'rm -rf /' }, OPTS);
    expect(result).toEqual({
      behavior: 'deny',
      message: 'path escapes workspace root',
    });
  });

  it('denies without calling IPC when the tool name is disabled', async () => {
    const { client, calls } = mkClient(async () => {
      throw new Error('IPC should not be reached for disabled tools');
    });
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-4' });
    const result = await canUseTool('WebFetch', { url: 'https://x' }, OPTS);
    expect(result).toEqual({
      behavior: 'deny',
      message: 'tool disabled by policy',
    });
    expect(calls).toEqual([]);
  });

  it('uses the stripped axName when the tool is our MCP-host tool', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-5' });
    await canUseTool(
      'mcp__ax-host-tools__memory.recall',
      { query: 'hi' },
      OPTS,
    );
    expect(calls[0]).toEqual({
      action: 'tool.pre-call',
      payload: {
        call: { id: 'uuid-5', name: 'memory.recall', input: { query: 'hi' } },
      },
    });
  });

  it('passes verbatim axName for built-in tool names', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'uuid-6' });
    await canUseTool('Read', { file_path: '/x' }, OPTS);
    expect(calls[0]).toEqual({
      action: 'tool.pre-call',
      payload: {
        call: { id: 'uuid-6', name: 'Read', input: { file_path: '/x' } },
      },
    });
  });

  it('propagates IPC errors out to the SDK (caller surfaces as turn error)', async () => {
    const boom = new Error('host unavailable');
    const { client } = mkClient(async () => {
      throw boom;
    });
    const canUseTool = createCanUseTool({ client });
    await expect(canUseTool('Bash', { command: 'ls' }, OPTS)).rejects.toBe(boom);
  });

  it('falls back to crypto.randomUUID when idGen is not supplied', async () => {
    // Don't assert the UUID shape — just assert SOMETHING nonempty was sent.
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const canUseTool = createCanUseTool({ client });
    await canUseTool('Bash', { command: 'ls' }, OPTS);
    const payload = calls[0]?.payload as { call: { id: string } };
    expect(typeof payload.call.id).toBe('string');
    expect(payload.call.id.length).toBeGreaterThan(0);
  });

  it('does not inspect the input object (opaque pass-through)', async () => {
    // Defensive: confirm we don't mutate or stringify input unexpectedly.
    const input = { a: 1, nested: { b: [1, 2, 3] } };
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const canUseTool = createCanUseTool({ client, idGen: () => 'u' });
    const result = await canUseTool('Bash', input, OPTS);
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    // Same reference preserved in the IPC payload.
    const sent = calls[0]?.payload as { call: { input: unknown } };
    expect(sent.call.input).toBe(input);
  });

  it('still-spies: confirms classifySdkToolName short-circuit does not leak a payload field', async () => {
    // Regression guard: disabled denial must NOT include, e.g., a phantom
    // tool-use id or modifiedCall field. Keeping the shape tight means the
    // SDK sees exactly what the type says.
    const mockFn = vi.fn();
    const { client } = mkClient(mockFn);
    const canUseTool = createCanUseTool({ client, idGen: () => 'u' });
    const result = await canUseTool('Task', { whatever: true }, OPTS);
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: 'tool disabled by policy',
    });
    expect(mockFn).not.toHaveBeenCalled();
  });
});
