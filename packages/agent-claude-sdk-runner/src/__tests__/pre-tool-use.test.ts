import type { IpcClient } from '@ax/agent-runner-core';
import { describe, expect, it } from 'vitest';
import { createPreToolUseHook } from '../pre-tool-use.js';

// PreToolUse is the primary `tool.pre-call` forwarder: the SDK fires it
// for EVERY tool invocation, including built-ins the CLI auto-approves
// internally (e.g. Bash under permissionMode 'default'). canUseTool does
// NOT cover those, which is the bug Week 6.5d Task 14's acceptance test
// uncovered. These tests pin the hook's translation contract.

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

const HOOK_OPTS = { signal: new AbortController().signal };

function preToolUseInput(overrides: {
  tool_name: string;
  tool_input: unknown;
}): Parameters<ReturnType<typeof createPreToolUseHook>>[0] {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/workspace',
    tool_name: overrides.tool_name,
    tool_input: overrides.tool_input,
    tool_use_id: 'tu_abc',
  } as unknown as Parameters<ReturnType<typeof createPreToolUseHook>>[0];
}

describe('createPreToolUseHook', () => {
  it('forwards built-in tool name verbatim to tool.pre-call and allows on verdict=allow', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-1' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls).toEqual([
      {
        action: 'tool.pre-call',
        payload: {
          call: { id: 'tu_abc', name: 'Bash', input: { command: 'ls' } },
        },
      },
    ]);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('strips the mcp__ax-host-tools__ prefix for our MCP host tools', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-2' });
    await hook(
      preToolUseInput({
        tool_name: 'mcp__ax-host-tools__memory.recall',
        tool_input: { q: 'x' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls[0]).toEqual({
      action: 'tool.pre-call',
      payload: { call: { id: 'tu_abc', name: 'memory.recall', input: { q: 'x' } } },
    });
  });

  it('propagates modifiedCall.input as hookSpecificOutput.updatedInput on allow', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'allow',
      modifiedCall: {
        id: 'tu_abc',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-3' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'ls -la' },
      },
    });
  });

  it('translates verdict=reject into permissionDecision=deny with the reason', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'reject',
      reason: 'path escapes workspace root',
    }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-4' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'path escapes workspace root',
      },
    });
  });

  it('denies disabled tool names without touching IPC', async () => {
    const { client, calls } = mkClient(async () => {
      throw new Error('IPC should not be reached for disabled tools');
    });
    const hook = createPreToolUseHook({ client, idGen: () => 'id-5' });
    const out = await hook(
      preToolUseInput({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls).toEqual([]);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'tool disabled by policy',
      },
    });
  });

  it('translates IPC errors into a deny so the SDK surfaces the failure', async () => {
    const { client } = mkClient(async () => {
      throw new Error('host unavailable');
    });
    const hook = createPreToolUseHook({ client, idGen: () => 'id-6' });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'host unavailable',
      },
    });
  });

  it('ignores non-PreToolUse events (defensive narrow)', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-7' });
    // Cast is fine; in practice the SDK matcher never routes a different
    // event here, but the adapter guards the wire shape anyway.
    const out = await hook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      } as unknown as Parameters<ReturnType<typeof createPreToolUseHook>>[0],
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({});
    expect(calls).toEqual([]);
  });
});
