import { describe, expect, it, vi } from 'vitest';
import type { ToolDescriptor } from '@ax/ipc-protocol';
import { createHoldLatch, createLocalDispatcher, type PreToolVerdict, type ToolPolicy } from '@ax/agent-runner-core';
import { POLICY_WRAPPED, type WrappedExecute } from '../tools/policy-wrap.js';
import { buildSandboxTools } from '../tools/sandbox-tools.js';

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

const holdLatch = createHoldLatch();

const sampleSandboxDescriptor: ToolDescriptor = {
  name: 'echo_local',
  description: 'echo (sandbox-executed)',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  executesIn: 'sandbox',
};

const sampleHostDescriptor: ToolDescriptor = {
  ...sampleSandboxDescriptor,
  name: 'echo_host',
  executesIn: 'host',
};

const OPTS = { toolCallId: 'call-1', messages: [], context: {} };

function unwrap(execute: unknown): WrappedExecute {
  return execute as WrappedExecute;
}

describe('buildSandboxTools', () => {
  it('filters to executesIn=sandbox tools only', () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async (call) => ({ echoed: call.input }));
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor, sampleHostDescriptor],
      holdLatch,
    });
    expect(Object.keys(tools)).toEqual(['echo_local']);
  });

  it('dispatches to the local dispatcher in-process (no IPC)', async () => {
    const dispatcher = createLocalDispatcher();
    let dispatched = 0;
    dispatcher.register('echo_local', async (call) => {
      dispatched += 1;
      return { input: call.input, name: call.name };
    });
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      idGen: () => 'id-1',
      holdLatch,
    });

    const out = await unwrap(tools['echo_local']?.execute)({ text: 'hi' }, OPTS);
    expect(dispatched).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.input).toEqual({ text: 'hi' });
    expect(parsed.name).toBe('echo_local');
  });

  it('propagates a dispatcher/executor failure as a throw (constraint 5)', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => {
      throw new Error('artifact-path-not-publishable: bad prefix');
    });
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    await expect(unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS)).rejects.toThrow(
      /artifact-path-not-publishable/,
    );
  });

  it('throws (naming the tool) when no local executor is registered for the descriptor', async () => {
    const dispatcher = createLocalDispatcher();
    // Note: no dispatcher.register for echo_local.
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    await expect(unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS)).rejects.toThrow(
      /echo_local/,
    );
  });

  it('coerces undefined executor output to the string "undefined" (JSON.stringify(undefined) === undefined)', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => undefined);
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    const out = await unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS);
    expect(typeof out).toBe('string');
    expect(out).toBe('undefined');
  });

  it('renders string output verbatim', async () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => 'plain string result');
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    const out = await unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS);
    expect(out).toBe('plain string result');
  });

  it('uses the default randomUUID idGen when none is supplied', async () => {
    const dispatcher = createLocalDispatcher();
    let seenId = '';
    dispatcher.register('echo_local', async (call) => {
      seenId = call.id;
      return 'ok';
    });
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    await unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS);
    expect(seenId.length).toBeGreaterThan(0);
  });

  it('tolerates a missing description by falling back to empty string', () => {
    const dispatcher = createLocalDispatcher();
    const toolNoDesc: ToolDescriptor = {
      name: 'no.desc',
      inputSchema: { type: 'object' },
      executesIn: 'sandbox',
    };
    const tools = buildSandboxTools({ policy: fakePolicy(), dispatcher, tools: [toolNoDesc], holdLatch });
    expect(tools['no.desc']?.description).toBe('');
  });

  // Constraint 4 — no counterpart to the SDK's shapeFromInputSchema
  // key-stripping workaround here. A key the declared schema doesn't
  // mention must still reach the executor.
  it('passes an undeclared key straight through to the executor (constraint 4)', async () => {
    const dispatcher = createLocalDispatcher();
    let seenInput: unknown;
    dispatcher.register('echo_local', async (call) => {
      seenInput = call.input;
      return 'ok';
    });
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor],
      holdLatch,
    });
    await unwrap(tools['echo_local']?.execute)(
      { text: 'hi', undeclaredKey: 'still here' },
      OPTS,
    );
    expect(seenInput).toEqual({ text: 'hi', undeclaredKey: 'still here' });
  });

  // Every registered execute must be policy-wrapped — enumerate the whole
  // set rather than spot-checking one entry.
  it('policy-wraps every registered execute', () => {
    const dispatcher = createLocalDispatcher();
    dispatcher.register('echo_local', async () => 'ok');
    const second: ToolDescriptor = { ...sampleSandboxDescriptor, name: 'second_local' };
    dispatcher.register('second_local', async () => 'ok');
    const tools = buildSandboxTools({
      policy: fakePolicy(),
      dispatcher,
      tools: [sampleSandboxDescriptor, second],
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

  it('runs through the policy — a deny short-circuits dispatch', async () => {
    const dispatcher = createLocalDispatcher();
    let dispatched = false;
    dispatcher.register('echo_local', async () => {
      dispatched = true;
      return 'ok';
    });
    const policy = fakePolicy({
      preToolUse: vi.fn(async () => ({
        decision: 'deny' as const,
        reason: 'not on the allowlist',
      })),
    } as never);
    const tools = buildSandboxTools({ policy, dispatcher, tools: [sampleSandboxDescriptor], holdLatch });
    const out = await unwrap(tools['echo_local']?.execute)({ text: 'x' }, OPTS);
    expect(out).toContain('not on the allowlist');
    expect(dispatched).toBe(false);
  });
});
