import type { IpcClient } from '@ax/ipc-protocol';
import { describe, expect, it } from 'vitest';
import { createCanUseTool } from '../can-use-tool.js';

// As of Week 6.5d Task 14 the canUseTool adapter is a belt-and-suspenders
// allow-path: the real `tool:pre-call` forwarding lives in the PreToolUse
// hook (see pre-tool-use.test.ts). canUseTool now only needs to deny
// disabled tools and pass everything else through.

function mkClient(): { client: IpcClient; calls: Array<unknown> } {
  const calls: Array<unknown> = [];
  const client: IpcClient = {
    async call() {
      throw new Error('call should not be reached from canUseTool');
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

const OPTS = {
  signal: new AbortController().signal,
  toolUseID: 'tu_test',
} as const;

describe('createCanUseTool', () => {
  it('allows and echoes input verbatim for built-in tools', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const input = { command: 'ls' };
    const result = await canUseTool('Bash', input, OPTS);
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('allows and echoes input verbatim for our MCP-host tools', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const input = { query: 'hi' };
    const result = await canUseTool(
      'mcp__ax-host-tools__memory.recall',
      input,
      OPTS,
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('denies disabled tool names without touching IPC', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const result = await canUseTool('WebFetch', { url: 'https://x' }, OPTS);
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: 'tool disabled by policy',
    });
  });

  it('denies `Task` (nested-agent bypass) without touching IPC', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const result = await canUseTool('Task', { whatever: true }, OPTS);
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: 'tool disabled by policy',
    });
  });

  it('does not inspect the input object (opaque pass-through)', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const input = { a: 1, nested: { b: [1, 2, 3] } };
    const result = await canUseTool('Read', input, OPTS);
    // Same reference preserved on the way through.
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect((result as { updatedInput: unknown }).updatedInput).toBe(input);
  });
});
