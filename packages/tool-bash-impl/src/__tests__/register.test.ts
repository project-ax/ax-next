import { describe, it, expect } from 'vitest';
import { createLocalDispatcher } from '@ax/agent-runner-core';
import type { ToolCall } from '@ax/ipc-protocol';
import { registerWithDispatcher } from '../register.js';
import type { BashResult } from '../exec.js';

// ---------------------------------------------------------------------------
// Register tests use a real createLocalDispatcher() instance — no mocks.
// The register pathway is the only way a runner binary will ever invoke
// the executor, so tests must go through it end-to-end.
// ---------------------------------------------------------------------------

function makeCall(input: unknown): ToolCall {
  return { id: 'c1', name: 'bash', input };
}

describe('registerWithDispatcher', () => {
  it('registers the bash tool so dispatcher.has("bash") is true', () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot: '/tmp' });
    expect(dispatcher.has('bash')).toBe(true);
  });

  it('executes a bash call end-to-end and returns a BashResult', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot: '/tmp' });
    const result = (await dispatcher.execute(
      makeCall({ command: 'echo ok' }),
    )) as BashResult;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toEqual({ stdout: false, stderr: false });
  });

  it('throws a clear error when input has no command field', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot: '/tmp' });
    // LocalDispatcher wraps executor errors with the tool name; the inner
    // message is what we care about here.
    await expect(dispatcher.execute(makeCall({}))).rejects.toThrow(
      /input\.command must be a string/,
    );
  });

  it('throws a clear error when input is not an object', async () => {
    const dispatcher = createLocalDispatcher();
    registerWithDispatcher(dispatcher, { workspaceRoot: '/tmp' });
    await expect(dispatcher.execute(makeCall('just a string'))).rejects.toThrow(
      /input must be an object/,
    );
  });
});
