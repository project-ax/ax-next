import type { IpcClient } from '@ax/ipc-protocol';
import { describe, expect, it } from 'vitest';
import { createCanUseTool } from '../can-use-tool.js';
import {
  DISABLED_BUILTINS,
  DISABLED_BUILTIN_REASONS,
} from '../tool-names.js';

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
      message: DISABLED_BUILTIN_REASONS.WebFetch,
    });
  });

  it('denies `Task` (nested-agent bypass) without touching IPC', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const result = await canUseTool('Task', { whatever: true }, OPTS);
    expect(result).toStrictEqual({
      behavior: 'deny',
      message: DISABLED_BUILTIN_REASONS.Task,
    });
  });

  // TASK-238. This path is defence in depth behind `disallowedTools` (see
  // can-use-tool.ts) — in a healthy session the SDK never routes a disabled
  // built-in here at all. What this pins is the debugging affordance: IF the
  // fallback fires, the four causes are told apart rather than collapsed into
  // one string.
  it('gives each disabled built-in a distinguishable deny message', async () => {
    const { client } = mkClient();
    const canUseTool = createCanUseTool({ client });
    const messages = await Promise.all(
      DISABLED_BUILTINS.map(async (name) => {
        const result = await canUseTool(name, {}, OPTS);
        expect(result.behavior).toBe('deny');
        return (result as { message: string }).message;
      }),
    );
    expect(new Set(messages).size).toBe(DISABLED_BUILTINS.length);
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
