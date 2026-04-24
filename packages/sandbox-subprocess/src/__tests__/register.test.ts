import { describe, it, expect } from 'vitest';
import { HookBus } from '@ax/core';
import { createSandboxSubprocessPlugin } from '../plugin.js';

describe('sandbox-subprocess registration', () => {
  it('registers sandbox:open-session service hook', async () => {
    const bus = new HookBus();
    const plugin = createSandboxSubprocessPlugin();
    // The plugin declares calls on session:* and ipc:* hooks; init itself
    // only performs the service-hook registration. We don't exercise the
    // hook here — open-session.test.ts covers the behavior end-to-end with
    // the real dependency graph.
    await plugin.init({ bus, config: {} });
    expect(bus.hasService('sandbox:open-session')).toBe(true);
  });

  it('no longer registers the deleted sandbox:spawn hook', async () => {
    const bus = new HookBus();
    await createSandboxSubprocessPlugin().init({ bus, config: {} });
    expect(bus.hasService('sandbox:spawn')).toBe(false);
  });
});
