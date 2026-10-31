import { createHoldLatch } from '@ax/agent-runner-core';
import type { IpcClient } from '@ax/ipc-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createPreToolUseHook } from '../pre-tool-use.js';
import {
  DISABLED_BUILTINS,
  DISABLED_BUILTIN_REASONS,
} from '../tool-names.js';

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

const HOOK_OPTS = { signal: new AbortController().signal };

function preToolUseInput(overrides: {
  tool_name: string;
  tool_input: unknown;
}): Parameters<ReturnType<typeof createPreToolUseHook>>[0] {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/files',
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

  it('sends the canonical mcp.<ns>.<tool> name to tool.pre-call for a connector namespace (TASK-734)', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-c1' });
    const out = await hook(
      preToolUseInput({
        tool_name: 'mcp__c0123456789__send_message',
        tool_input: { text: 'hi' },
      }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(calls).toEqual([
      {
        action: 'tool.pre-call',
        payload: {
          call: {
            id: 'tu_abc',
            name: 'mcp.c0123456789.send_message',
            input: { text: 'hi' },
          },
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

  it('keeps a foreign mcp__<server>__<tool> name verbatim on tool.pre-call (only host-minted namespaces are lifted)', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, idGen: () => 'id-c2' });
    await hook(
      preToolUseInput({ tool_name: 'mcp__linear__create_issue', tool_input: {} }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(
      (calls[0]?.payload as { call: { name: string } }).call.name,
    ).toBe('mcp__linear__create_issue');
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
        permissionDecisionReason: DISABLED_BUILTIN_REASONS.WebFetch,
      },
    });
  });

  // TASK-238. `disallowedTools` keeps all four out of the model's context, so
  // this branch is defence in depth and does not run in a healthy session (see
  // pre-tool-use.ts). What is pinned here is that when it DOES run, the four
  // causes are distinguishable instead of collapsed into one string.
  it('gives each disabled built-in a distinguishable deny reason', async () => {
    const { client, calls } = mkClient(async () => {
      throw new Error('IPC should not be reached for disabled tools');
    });
    const hook = createPreToolUseHook({ client, idGen: () => 'id-5b' });
    const reasons: string[] = [];
    for (const name of DISABLED_BUILTINS) {
      const out = await hook(
        preToolUseInput({ tool_name: name, tool_input: {} }),
        'tu_abc',
        HOOK_OPTS,
      );
      const hso = (out as { hookSpecificOutput: Record<string, string> })
        .hookSpecificOutput;
      expect(hso.permissionDecision).toBe('deny');
      reasons.push(hso.permissionDecisionReason!);
    }
    expect(calls).toEqual([]);
    expect(new Set(reasons).size).toBe(DISABLED_BUILTINS.length);
  });

  // TASK-239. `permissionDecisionReason` is not an internal channel: the SDK
  // turns it into an `is_error` tool_result, which is persisted and rendered in
  // the web transcript. It used to be the raw `Error.message`, so one click in
  // the UI showed a non-technical person `connect failed: ECONNREFUSED`.
  it('translates IPC errors into a deny without putting the raw error in the transcript', async () => {
    const { client } = mkClient(async () => {
      throw new Error('connect failed: ECONNREFUSED');
    });
    const warn = vi.fn();
    const hook = createPreToolUseHook({
      client,
      idGen: () => 'id-6',
      warn,
    });
    const out = await hook(
      preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      'tu_abc',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'the approval check could not be completed',
      },
    });
    // Still recoverable by whoever operates the thing, just not by the reader.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0] as string).toContain('ECONNREFUSED');
  });

  // TASK-995: there is no second tree to steer writes into. A path that looks
  // like configuration — `.ax/**`, `.claude/**`, a root `CLAUDE.md` — is an
  // ordinary file in the agent's home, and nothing loads it (the SDK reads its
  // trusted configuration only from CLAUDE_CONFIG_DIR, outside the home). So
  // every path reaches the host exactly as the model wrote it, the host
  // adjudicates the call the SDK will really run, and only a host
  // `modifiedCall` (the test above) can change it.
  it('never rewrites .ax/, .claude/ or CLAUDE.md paths', async () => {
    const cases: Array<{ tool_name: string; tool_input: Record<string, unknown> }> = [
      { tool_name: 'Write', tool_input: { file_path: '/files/.ax/SOUL.md', content: 'x' } },
      { tool_name: 'Write', tool_input: { file_path: '.ax/IDENTITY.md', content: 'x' } },
      { tool_name: 'Read', tool_input: { file_path: '~/.ax/uploads/cnv_x/req-y/report.pdf' } },
      { tool_name: 'Read', tool_input: { file_path: '/home/user/.ax/uploads/cnv_x/report.pdf' } },
      {
        tool_name: 'Edit',
        tool_input: { file_path: '.claude/settings.json', old_string: '{}', new_string: '{"hooks":{}}' },
      },
      { tool_name: 'Write', tool_input: { file_path: '/files/.claude/skills/x/SKILL.md', content: 'x' } },
      { tool_name: 'Write', tool_input: { file_path: 'CLAUDE.md', content: 'x' } },
      { tool_name: 'Write', tool_input: { file_path: '/files/CLAUDE.local.md', content: 'x' } },
      { tool_name: 'Glob', tool_input: { pattern: '**/*.md', path: '.claude' } },
      { tool_name: 'Grep', tool_input: { pattern: 'x', path: '/files/.ax' } },
      { tool_name: 'NotebookEdit', tool_input: { notebook_path: '.ax/n.ipynb', new_source: 'x' } },
    ];
    for (const c of cases) {
      const label = `${c.tool_name} ${JSON.stringify(c.tool_input)}`;
      // A private copy goes in, so an in-place rewrite cannot hide by
      // changing the expected value too.
      const asWritten = structuredClone(c.tool_input);
      const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
      const hook = createPreToolUseHook({ client, idGen: () => 'id-as-written' });
      const out = await hook(
        preToolUseInput({ tool_name: c.tool_name, tool_input: structuredClone(c.tool_input) }),
        'tu_abc',
        HOOK_OPTS,
      );
      // The host adjudicates the model's own input...
      expect(calls, label).toEqual([
        {
          action: 'tool.pre-call',
          payload: { call: { id: 'tu_abc', name: c.tool_name, input: asWritten } },
        },
      ]);
      // ...and the SDK runs it unchanged: no updatedInput at all.
      expect(out, label).toEqual({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      });
    }
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

  it('stops the SDK loop on a hold instead of denying', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'hold',
      decisionId: 'dec_9',
      note: 'Held: sending email',
    }));
    const latch = createHoldLatch();
    const hook = createPreToolUseHook({ client, holdLatch: latch });
    const out = await hook(
      preToolUseInput({ tool_name: 'mcp__gmail__send', tool_input: {} }),
      'tu_1',
      HOOK_OPTS,
    );
    expect(out).toEqual({
      continue: false,
      stopReason: 'Held: sending email',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Held: sending email',
      },
    });
    expect(latch.decisionId).toBe('dec_9');
  });

  it('reports the held tool-call id to onHold (main.ts rewrites that call’s published result)', async () => {
    const { client } = mkClient(async () => ({
      verdict: 'hold',
      decisionId: 'dec_9',
      note: 'Held: sending email',
    }));
    const held: string[] = [];
    const hook = createPreToolUseHook({
      client,
      onHold: (id) => held.push(id),
    });
    await hook(
      preToolUseInput({ tool_name: 'mcp__gmail__send', tool_input: {} }),
      'tu_1',
      HOOK_OPTS,
    );
    expect(held).toEqual(['tu_1']);
  });

  it('does NOT call onHold on allow or on deny — only a hold is a hold', async () => {
    const held: string[] = [];
    const allowClient = mkClient(async () => ({ verdict: 'allow' })).client;
    await createPreToolUseHook({
      client: allowClient,
      onHold: (id) => held.push(id),
    })(preToolUseInput({ tool_name: 'Bash', tool_input: {} }), 'tu_1', HOOK_OPTS);
    expect(held).toEqual([]);

    const denyClient = mkClient(async () => ({
      verdict: 'reject',
      reason: 'nope',
    })).client;
    await createPreToolUseHook({
      client: denyClient,
      onHold: (id) => held.push(id),
    })(preToolUseInput({ tool_name: 'Bash', tool_input: {} }), 'tu_2', HOOK_OPTS);
    expect(held).toEqual([]);
  });

  it('does NOT call onHold when the SDK handed us no usable toolUseID', async () => {
    // Same care as the `toolUseId ?? idGen()` comment in the hook: '' and
    // undefined are DIFFERENT here. The policy may mint a synthetic id for the
    // pre-call payload, but that id is not what the SDK will stamp on the
    // tool_result, so recording it would either miss the substitution or —
    // worse, for '' — key the registry on an id a later real result could
    // collide with.
    const { client } = mkClient(async () => ({
      verdict: 'hold',
      decisionId: 'dec_9',
      note: 'Held: sending email',
    }));
    const held: string[] = [];
    const latch = createHoldLatch();
    const hook = createPreToolUseHook({
      client,
      idGen: () => 'generated-id',
      holdLatch: latch,
      onHold: (id) => held.push(id),
    });

    await hook(
      preToolUseInput({ tool_name: 'mcp__gmail__send', tool_input: {} }),
      '',
      HOOK_OPTS,
    );
    await hook(
      preToolUseInput({ tool_name: 'mcp__gmail__send', tool_input: {} }),
      undefined,
      HOOK_OPTS,
    );

    expect(held).toEqual([]);
    // The hold itself still happened — only the display substitution is skipped.
    expect(latch.decisionId).toBe('dec_9');
  });
});

describe('Stop gates', () => {
  it('denies before policy when Stop was latched during startup', async () => {
    const { client, calls } = mkClient(async () => ({ verdict: 'allow' }));
    const hook = createPreToolUseHook({ client, isInterrupted: () => true });
    const out = await hook(preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'touch marker' } }), 'call', HOOK_OPTS);
    expect(out).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(calls).toHaveLength(0);
  });

  it('denies an allow that returns after Stop', async () => {
    let interrupted = false;
    const { client } = mkClient(async () => { interrupted = true; return { verdict: 'allow' }; });
    const hook = createPreToolUseHook({ client, isInterrupted: () => interrupted });
    const out = await hook(preToolUseInput({ tool_name: 'Bash', tool_input: { command: 'touch marker' } }), 'call', HOOK_OPTS);
    expect(out).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});
