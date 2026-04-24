import { describe, it, expect } from 'vitest';
import {
  HookBus,
  bootstrap,
  makeChatContext,
  createLogger,
  PluginError,
  type Plugin,
} from '../index.js';

// ---------------------------------------------------------------------------
// Week 1-2 acceptance (revised in Week 6.5a, Task 12)
//
// Original Week 1-2 acceptance asserted that `chat:run` terminated cleanly
// with `llm:call:no-service` when no llm plugin was loaded — that behaviour
// was owned by the deleted core `chat-loop.ts`. In the 6.5a topology the
// host-side chat:run lives in `@ax/chat-orchestrator`, so asserting it here
// would be a cross-plugin import from the kernel (I2).
//
// The kernel-level invariant worth keeping is: bootstrap refuses to start a
// plugin set that has unmet `calls:` declarations. That IS the v2 equivalent
// of "the chat pipeline halts cleanly when the llm is missing" — it halts
// at boot instead of at first call, which is the topology we wanted.
// ---------------------------------------------------------------------------

describe('Week 1-2 acceptance (revised 6.5a)', () => {
  it('bootstrap rejects a plugin set with unmet calls (missing-service at boot)', async () => {
    const bus = new HookBus();
    const needsLlm: Plugin = {
      manifest: {
        name: 'needs-llm',
        version: '0.0.0',
        registers: [],
        calls: ['llm:call'],
        subscribes: [],
      },
      init: () => undefined,
    };
    await expect(
      bootstrap({ bus, plugins: [needsLlm], config: {} }),
    ).rejects.toBeInstanceOf(PluginError);
  });

  it('bootstrap accepts a minimal kernel set (bus + ctx factory only)', async () => {
    const bus = new HookBus();
    await bootstrap({ bus, plugins: [], config: {} });
    const ctx = makeChatContext({
      reqId: 'acceptance',
      sessionId: 's',
      agentId: 'a',
      userId: 'u',
      logger: createLogger({ reqId: 'acceptance', writer: () => undefined }),
    });
    expect(ctx.reqId).toBe('acceptance');
    expect(bus.hasService('anything')).toBe(false);
  });
});
