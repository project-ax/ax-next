import { describe, expect, it, vi } from 'vitest';
import { createToolPolicy } from '../tool-policy.js';

function fakeClient(response: unknown) {
  return { call: vi.fn().mockResolvedValue(response) } as never;
}

describe('createToolPolicy', () => {
  it('forwards the re-rooted input to tool.pre-call and allows on accept', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    const verdict = await policy.preToolUse(
      'Read',
      { file_path: '.ax/uploads/c1/t1/a.pdf' },
      'call-1',
    );

    expect(verdict).toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
    });
    expect((client as never as { call: ReturnType<typeof vi.fn> }).call)
      .toHaveBeenCalledWith('tool.pre-call', {
        call: {
          id: 'call-1',
          name: 'Read',
          input: { file_path: '/agent/.ax/uploads/c1/t1/a.pdf' },
        },
      });
  });

  it('denies when the host rejects, carrying the reason', async () => {
    const client = fakeClient({ verdict: 'reject', reason: 'npm not permitted' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(policy.preToolUse('Bash', { command: 'npm i' }, 'call-2'))
      .resolves.toEqual({ decision: 'deny', reason: 'npm not permitted' });
  });

  it('denies (fail-closed) when the IPC call throws', async () => {
    const client = { call: vi.fn().mockRejectedValue(new Error('socket closed')) } as never;
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(policy.preToolUse('Bash', { command: 'ls' }, 'call-3'))
      .resolves.toEqual({ decision: 'deny', reason: 'socket closed' });
  });

  it('prefers the host modifiedCall input over our re-rooted input', async () => {
    // modifiedCall is a full ToolCallSchema — { id, name, input }.
    const client = fakeClient({
      verdict: 'allow',
      modifiedCall: {
        id: 'call-4',
        name: 'Read',
        input: { file_path: '/permanent/a.pdf' },
      },
    });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await expect(
      policy.preToolUse('Read', { file_path: '.ax/uploads/c1/t1/a.pdf' }, 'call-4'),
    ).resolves.toEqual({
      decision: 'allow',
      updatedInput: { file_path: '/permanent/a.pdf' },
    });
  });

  // The original (pre-split) hook did `toolUseID ?? idGen()`, which sends the
  // literal '' as the call id when the SDK hands us an empty string — it only
  // generates a fresh id for `undefined`. These two cases pin that behaviour
  // so a `||` (or similar) regression that treats '' as "missing" is caught.
  it('sends the literal empty string as call.id, not a generated id', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await policy.preToolUse('Bash', { command: 'ls' }, '');

    expect((client as never as { call: ReturnType<typeof vi.fn> }).call)
      .toHaveBeenCalledWith('tool.pre-call', {
        call: { id: '', name: 'Bash', input: { command: 'ls' } },
      });
  });

  it('generates a call.id when toolUseId is undefined', async () => {
    const client = fakeClient({ verdict: 'allow' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    await policy.preToolUse('Bash', { command: 'ls' }, undefined);

    const call = (client as never as { call: ReturnType<typeof vi.fn> }).call;
    expect(call).toHaveBeenCalledTimes(1);
    const sentId = (call.mock.calls[0]![1] as { call: { id: string } }).call.id;
    expect(sentId).not.toBe('');
    expect(typeof sentId).toBe('string');
    expect(sentId.length).toBeGreaterThan(0);
  });

  it('denies (fail-closed) when the host response fails schema validation', async () => {
    const client = fakeClient({ verdict: 'not-a-real-verdict' });
    const policy = createToolPolicy({ client, workspaceRoot: '/agent' });

    const verdict = await policy.preToolUse('Bash', { command: 'ls' }, 'call-5');

    expect(verdict.decision).toBe('deny');
  });
});
