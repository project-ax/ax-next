import { describe, expect, it, vi } from 'vitest';

// The loop must hand the runner env's turn limit to the Bash tool. Capture the
// options the loop builds the built-ins with, then stop the turn right there.
const seen = vi.hoisted(() => ({ opts: undefined as Record<string, unknown> | undefined }));
vi.mock('../tools/builtins.js', () => ({
  buildBuiltinTools: (opts: Record<string, unknown>) => {
    seen.opts = opts;
    throw new Error('stop-after-builtins');
  },
}));
const { createAiSdkLoop } = await import('../main.js');

async function builtinOptsFor(turnLimitMs: number | undefined): Promise<Record<string, unknown>> {
  seen.opts = undefined;
  const loop = createAiSdkLoop({
    client: { call: vi.fn(), event: vi.fn() },
    env: { ephemeralRoot: '/tmp/ax-turn-limit-test', ...(turnLimitMs !== undefined ? { turnLimitMs } : {}) },
    agentConfig: { runner: 'aisdk', model: 'anthropic/claude-sonnet-4-7', displayName: 'T' },
    tools: [],
    localDispatcher: {},
    proxyStartup: { providerEnv: {} },
    pythonVenvReady: false,
    homeDir: '/tmp/ax-turn-limit-test',
    systemPrompt: 'x',
    resumeSessionId: null,
    transcript: {},
  } as never);
  await expect(loop.run({} as never)).rejects.toThrow('stop-after-builtins');
  return seen.opts!;
}

describe('aisdk loop: turn limit reaches the Bash tool', () => {
  it('passes env.turnLimitMs as bashMaxTimeoutMs', async () => {
    expect((await builtinOptsFor(7_200_000))['bashMaxTimeoutMs']).toBe(7_200_000);
  });
  it('passes nothing when the host sent no turn limit', async () => {
    expect((await builtinOptsFor(undefined))['bashMaxTimeoutMs']).toBeUndefined();
  });
});
