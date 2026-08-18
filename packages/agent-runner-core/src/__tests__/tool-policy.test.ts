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
});
