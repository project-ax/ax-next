import type { IpcClient } from '@ax/agent-runner-core';
import { describe, expect, it } from 'vitest';
import { createPostToolUseHook } from '../post-tool-use.js';

function mkClient(
  eventImpl?: (name: string, payload: unknown) => Promise<void>,
): {
  client: IpcClient;
  events: Array<{ name: string; payload: unknown }>;
} {
  const events: Array<{ name: string; payload: unknown }> = [];
  const client: IpcClient = {
    call: async () => {
      throw new Error('call not expected');
    },
    callGet: async () => {
      throw new Error('callGet not expected');
    },
    event: async (name, payload) => {
      events.push({ name, payload });
      if (eventImpl) await eventImpl(name, payload);
    },
    close: async () => {
      /* no-op */
    },
  };
  return { client, events };
}

// Default hook options used across tests — the SDK hands us a live
// AbortSignal but the post-tool adapter never reads it.
const HOOK_OPTS = { signal: new AbortController().signal };

// Convenience: build a valid PostToolUseHookInput (only the fields the
// adapter touches are load-bearing). `hook_event_name` is the narrow
// discriminator the adapter keys off.
function postToolUseInput(overrides: {
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}): Parameters<ReturnType<typeof createPostToolUseHook>>[0] {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/workspace',
    tool_name: overrides.tool_name,
    tool_input: overrides.tool_input,
    tool_response: overrides.tool_response,
    tool_use_id: 'tu_abc',
    // Cast: the full BaseHookInput has additional required fields, but for
    // unit-testing the adapter the above is sufficient. The adapter only
    // reads the narrowed PostToolUse fields.
  } as unknown as Parameters<ReturnType<typeof createPostToolUseHook>>[0];
}

describe('createPostToolUseHook', () => {
  it('emits event.tool-post-call for a normal PostToolUse event', async () => {
    const { client, events } = mkClient();
    const hook = createPostToolUseHook({ client });
    const result = await hook(
      postToolUseInput({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'a\nb\n' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(result).toEqual({});
    // Allow the fire-and-forget promise chain to flush.
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([
      {
        name: 'event.tool-post-call',
        payload: {
          call: { id: 'tu_abc', name: 'Bash', input: { command: 'ls' } },
          output: { stdout: 'a\nb\n' },
        },
      },
    ]);
  });

  it('uses the stripped axName for ax-host-tools MCP tools', async () => {
    const { client, events } = mkClient();
    const hook = createPostToolUseHook({ client });
    await hook(
      postToolUseInput({
        tool_name: 'mcp__ax-host-tools__memory.recall',
        tool_input: { query: 'hi' },
        tool_response: { hits: [] },
      }),
      'tu_mcp',
      HOOK_OPTS,
    );
    await new Promise((r) => setImmediate(r));
    expect(events[0]).toEqual({
      name: 'event.tool-post-call',
      payload: {
        call: { id: 'tu_mcp', name: 'memory.recall', input: { query: 'hi' } },
        output: { hits: [] },
      },
    });
  });

  it('falls back to empty-string id when toolUseID is undefined', async () => {
    // The SDK types say toolUseID can be undefined; the IPC schema requires
    // a string. Empty-string is the agreed "unknown" sentinel.
    const { client, events } = mkClient();
    const hook = createPostToolUseHook({ client });
    await hook(
      postToolUseInput({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'x' },
      }),
      undefined,
      HOOK_OPTS,
    );
    await new Promise((r) => setImmediate(r));
    const payload = events[0]?.payload as { call: { id: string } };
    expect(payload.call.id).toBe('');
  });

  it('skips emitting for disabled tool names (defense in depth)', async () => {
    const { client, events } = mkClient();
    const hook = createPostToolUseHook({ client });
    const result = await hook(
      postToolUseInput({
        tool_name: 'WebFetch',
        tool_input: { url: 'https://x' },
        tool_response: null,
      }),
      'tu_x',
      HOOK_OPTS,
    );
    expect(result).toEqual({});
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([]);
  });

  it('is a no-op for non-PostToolUse event types', async () => {
    const { client, events } = mkClient();
    const hook = createPostToolUseHook({ client });
    const result = await hook(
      // Cast: simulate the SDK delivering a differently-typed hook input.
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/x',
        cwd: '/x',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: 'tu_1',
      } as unknown as Parameters<ReturnType<typeof createPostToolUseHook>>[0],
      'tu_1',
      HOOK_OPTS,
    );
    expect(result).toEqual({});
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([]);
  });

  it('swallows event-emission errors (fire-and-forget, no unhandled rejection)', async () => {
    const { client, events } = mkClient(async () => {
      throw new Error('socket exploded');
    });
    const hook = createPostToolUseHook({ client });
    // Must not throw.
    const result = await hook(
      postToolUseInput({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { stdout: 'ok' },
      }),
      'tu_boom',
      HOOK_OPTS,
    );
    expect(result).toEqual({});
    // The event WAS dispatched (we track calls in the fake before throwing).
    expect(events).toHaveLength(1);
    // Wait a tick for the rejection to settle silently.
    await new Promise((r) => setImmediate(r));
  });
});
