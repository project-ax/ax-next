import { describe, it, expect } from 'vitest';
import type { ToolCall } from '@ax/ipc-protocol';
import { createLocalDispatcher } from '../local-dispatcher.js';

// ---------------------------------------------------------------------------
// local-dispatcher tests
//
// Surface is tiny — we're just exercising register/has/execute and the two
// error paths (duplicate register, unknown tool). Executor-throws is the
// one semantically interesting case: the wrapper must preserve the original
// error as `cause` so debugging doesn't lose context.
// ---------------------------------------------------------------------------

function makeCall(name: string, input: unknown = {}): ToolCall {
  return { id: 'call-1', name, input };
}

describe('createLocalDispatcher', () => {
  it('registers and executes a tool round-trip', async () => {
    const d = createLocalDispatcher();
    d.register('echo', async (call) => ({ echoed: call.input }));
    const result = await d.execute(makeCall('echo', { hello: 'world' }));
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  it('has() returns true for registered tools and false otherwise', () => {
    const d = createLocalDispatcher();
    d.register('registered', async () => 'ok');
    expect(d.has('registered')).toBe(true);
    expect(d.has('nope')).toBe(false);
  });

  it('throws on duplicate registration', () => {
    const d = createLocalDispatcher();
    d.register('once', async () => 'first');
    expect(() => d.register('once', async () => 'second')).toThrow(
      /duplicate tool registration for 'once'/,
    );
  });

  it('throws a clear error when executing an unregistered tool', async () => {
    const d = createLocalDispatcher();
    await expect(d.execute(makeCall('missing'))).rejects.toThrow(
      /no local impl registered for tool 'missing'/,
    );
  });

  it('rethrows executor errors with tool name in message and preserves cause', async () => {
    const d = createLocalDispatcher();
    const original = new Error('boom');
    d.register('explode', async () => {
      throw original;
    });
    try {
      await d.execute(makeCall('explode'));
      expect.fail('expected execute() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/tool 'explode' failed: boom/);
      expect((err as Error & { cause: unknown }).cause).toBe(original);
    }
  });
});
