import { describe, it, expect, vi } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import type { Logger } from '@ax/core';
import { WEB_EXTRACT_DESCRIPTOR, registerWebExtract } from '../tools/web-extract.js';

/** A logger whose `warn` calls a test can read back. */
function spyLogger() {
  const warn = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return { logger, warn };
}

function ctx(userId = 'u', logger?: Logger) {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId, ...(logger ? { logger } : {}) });
}

async function wired(run = vi.fn()) {
  const bus = new HookBus();
  bus.registerService('tool:register', 'disp', async () => ({ ok: true }));
  await registerWebExtract(bus, { run });
  return { bus, run };
}

/**
 * The same harness plus a stand-in for @ax/tool-policy's
 * `egress-allowlist:remember`. `impl` lets a test make the recording throw.
 */
async function wiredWithAllowlist(
  run = vi.fn(),
  impl: () => Promise<{ remembered: boolean }> = async () => ({ remembered: true }),
) {
  const { bus } = await wired(run);
  const remember = vi.fn(async (_c: unknown, _i: unknown) => impl());
  bus.registerService('egress-allowlist:remember', 'policy', remember);
  return { bus, run, remember };
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

  // --- egress allowlist (TASK-330) ----------------------------------------

  it('records the bare hostname after a successful fetch — lowercased, no path/query/fragment', async () => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus, remember } = await wiredWithAllowlist(run);
    await bus.call('tool:execute:web_extract', ctx(), {
      id: 'c', name: 'web_extract', input: { url: 'https://Example.COM/some/path?q=1#frag' },
    });
    expect(remember).toHaveBeenCalledTimes(1);
    // The one that matters: anything URL-shaped here would make the allowlist
    // bypassable by tacking a query string onto an approved host.
    expect(remember.mock.calls[0]?.[1]).toEqual({ host: 'example.com' });
  });

  it('still refuses a private target and records nothing, even with the allowlist present', async () => {
    const { bus, run, remember } = await wiredWithAllowlist();
    // `localhost` is exactly the sort of host somebody might have talked their
    // way onto an allowlist. The guard sits UNDERNEATH the list, not beside it.
    await expect(
      bus.call('tool:execute:web_extract', ctx(), {
        id: 'c', name: 'web_extract', input: { url: 'http://localhost:8080/admin' },
      }),
    ).rejects.toThrow(PluginError);
    expect(run).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it('records nothing when the fetch fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('upstream 502'));
    const { bus, remember } = await wiredWithAllowlist(run);
    await expect(
      bus.call('tool:execute:web_extract', ctx(), {
        id: 'c', name: 'web_extract', input: { url: 'https://example.com/' },
      }),
    ).rejects.toThrow(/502/);
    expect(remember).not.toHaveBeenCalled();
  });

  it('a throwing remember service cannot break the tool, and the warning names no url', async () => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus, remember } = await wiredWithAllowlist(run, async () => {
      throw new Error('allowlist store is down');
    });
    const { logger, warn } = spyLogger();
    const out = await bus.call('tool:execute:web_extract', ctx('u', logger), {
      id: 'c', name: 'web_extract', input: { url: 'https://example.com/p?token=SUPERSECRET' },
    });
    expect(remember).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ url: 'https://x', title: 'T', text: 'body' });
    expect(warn).toHaveBeenCalledWith(
      'web_extract_remember_host_failed',
      expect.objectContaining({ host: 'example.com' }),
    );
    // The url is model-authored and can carry a token in its query string.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SUPERSECRET');
  });

  it('works on a bus with no egress-allowlist:remember service at all — cleanly, no warning', async () => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus } = await wired(run);
    expect(bus.hasService('egress-allowlist:remember')).toBe(false);
    const { logger, warn } = spyLogger();
    const out = await bus.call('tool:execute:web_extract', ctx('u', logger), {
      id: 'c', name: 'web_extract', input: { url: 'https://example.com/' },
    });
    expect(out).toEqual({ url: 'https://x', title: 'T', text: 'body' });
    // An absent hook is a supported configuration, not an incident. Without the
    // `hasService` check this still "works" — but noisily, every single fetch.
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([['system'], ['']])('records nothing for userId %j', async (userId) => {
    const run = vi.fn().mockResolvedValue({ url: 'https://x', title: 'T', text: 'body' });
    const { bus, remember } = await wiredWithAllowlist(run);
    const out = await bus.call('tool:execute:web_extract', ctx(userId), {
      id: 'c', name: 'web_extract', input: { url: 'https://example.com/' },
    });
    expect(remember).not.toHaveBeenCalled();
    expect(out).toEqual({ url: 'https://x', title: 'T', text: 'body' });
  });
});
