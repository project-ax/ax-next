import { describe, it, expect, vi } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { WEB_EXTRACT_DESCRIPTOR, registerWebExtract } from '../tools/web-extract.js';

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

async function wired(run = vi.fn()) {
  const bus = new HookBus();
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  await registerWebExtract(bus, { run });
  return { bus, run };
}

describe('tools/web-extract', () => {
  it('descriptor is a host tool named web_extract requiring url', () => {
    expect(WEB_EXTRACT_DESCRIPTOR.name).toBe('web_extract');
    expect(WEB_EXTRACT_DESCRIPTOR.executesIn).toBe('host');
    expect(WEB_EXTRACT_DESCRIPTOR.inputSchema).toMatchObject({ required: ['url'] });
  });

  it('reads call.input.url and returns the bare extract result', async () => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus } = await wired(run);
    const out = await bus.call('tool:execute:web_extract', ctx(), {
      id: 'c', name: 'web_extract', input: { url: 'https://example.com' },
    });
    expect(run).toHaveBeenCalledWith('https://example.com');
    expect(out).toEqual({ url: 'https://x', title: 'T', text: 'body' });
  });

  it('rejects a disallowed (internal) URL before calling the backend', async () => {
    const { bus, run } = await wired();
    await expect(
      bus.call('tool:execute:web_extract', ctx(), { id: 'c', name: 'web_extract', input: { url: 'http://169.254.169.254/' } }),
    ).rejects.toThrow(/url/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a missing url', async () => {
    const { bus, run } = await wired();
    await expect(
      bus.call('tool:execute:web_extract', ctx(), { id: 'c', name: 'web_extract', input: {} }),
    ).rejects.toThrow(/url/i);
    expect(run).not.toHaveBeenCalled();
  });
});
