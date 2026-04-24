import { describe, it, expect } from 'vitest';
import { HookBus, makeChatContext, createLogger } from '@ax/core';
import { createSandboxSubprocessPlugin } from '../plugin.js';

const ctx = () =>
  makeChatContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'test', writer: () => {} }),
  });

describe('sandbox-subprocess registration', () => {
  it('registers sandbox:spawn service hook', async () => {
    const bus = new HookBus();
    const plugin = createSandboxSubprocessPlugin();
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('sandbox:spawn')).toBe(true);
  });

  it('rejects malformed input via Zod before invoking spawnImpl', async () => {
    const bus = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {} });
    await expect(
      bus.call('sandbox:spawn', ctx(), { argv: [], cwd: '/tmp', env: {} }),
    ).rejects.toThrow();
  });
});
