import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '@ax/core';
import { createWebToolsPlugin } from '../plugin.js';

function busWithDispatcher() {
  const bus = new HookBus();
  const registered: string[] = [];
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  return { bus, registered };
}

const fakeFactory = () => ({ messages: { create: vi.fn() } }) as never;

describe('createWebToolsPlugin', () => {
  it('manifest declares the two execute hooks + tool:register', () => {
    const p = createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: fakeFactory });
    expect(p.manifest.name).toBe('@ax/web-tools');
    expect(p.manifest.registers).toEqual(
      expect.arrayContaining(['tool:execute:web_search', 'tool:execute:web_extract']),
    );
    expect(p.manifest.calls).toContain('tool:register');
  });

  it('registers both descriptors on init', async () => {
    const { bus, registered } = busWithDispatcher();
    await createWebToolsPlugin({ apiKey: 'sk-ant-x', clientFactory: fakeFactory }).init({ bus, config: {} as never });
    expect(registered.sort()).toEqual(['web_extract', 'web_search']);
  });

  it('enabled:false registers nothing and never needs a key', async () => {
    const { bus, registered } = busWithDispatcher();
    await createWebToolsPlugin({ enabled: false }).init({ bus, config: {} as never });
    expect(registered).toEqual([]);
    expect(bus.hasService('tool:execute:web_search')).toBe(false);
  });

  it('throws at init when enabled and no key resolves', async () => {
    const { bus } = busWithDispatcher();
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        createWebToolsPlugin({ clientFactory: fakeFactory }).init({ bus, config: {} as never }),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
