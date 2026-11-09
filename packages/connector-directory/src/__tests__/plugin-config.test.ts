import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { createTestHarness } from '@ax/test-harness';
import {
  DIRECTORY_PROVENANCE_MARK_EDITED_HOOK,
  DIRECTORY_PROVENANCE_RECORD_HOOK,
} from '../contract.js';
import { createConnectorDirectoryPlugin, type ConnectorDirectoryConfig } from '../plugin.js';

const HOUR = 3_600_000;
const OFF = { enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false };
const ENABLED_MANIFEST = {
  name: '@ax/connector-directory',
  version: '0.0.0',
  registers: [
    'connectors:directory-search',
    'connectors:directory-provenance-record',
    'connectors:directory-provenance-mark-edited',
  ],
  calls: ['database:get-instance'],
  subscribes: ['connectors:deleted'],
};

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network is off in tests');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The PluginError a call throws; fails the test on anything else. */
function refusal(fn: () => unknown): PluginError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PluginError);
    return err as PluginError;
  }
  throw new Error('expected a throw');
}

describe('@ax/connector-directory: config and the off switch', () => {
  it('disabled: calls nothing, never fetches, answers the off body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const fetchImpl = vi.fn<typeof fetch>();
    const p = createConnectorDirectoryPlugin({
      enabled: false,
      fetchImpl,
      syncInitialDelayMs: 0,
      syncIntervalMs: 1_000,
    });
    expect(p.manifest).toEqual({
      name: '@ax/connector-directory',
      version: '0.0.0',
      registers: ['connectors:directory-search'],
      calls: [],
      subscribes: [],
    });

    // No services at all: a database call would fail the boot or the hook.
    const harness = await createTestHarness({ plugins: [p] });
    try {
      // Off remembers nothing: no provenance hooks, no delete subscriber (the
      // bus lists no subscribers; `unsubscribe` counts what it removed).
      expect(harness.bus.hasService(DIRECTORY_PROVENANCE_RECORD_HOOK)).toBe(false);
      expect(harness.bus.hasService(DIRECTORY_PROVENANCE_MARK_EDITED_HOOK)).toBe(false);
      expect(harness.bus.unsubscribe('connectors:deleted', '@ax/connector-directory')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(
        await harness.bus.call('connectors:directory-search', harness.ctx(), { query: 'x' }),
      ).toEqual(OFF);
      expect(await p.sync()).toEqual({ outcome: 'disabled' });
      await p.drain();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // Still the hook's contract: bad input is refused the same way.
      const call = harness.bus.call('connectors:directory-search', harness.ctx(), { query: 1 });
      await expect(call).rejects.toMatchObject({
        code: 'invalid-payload',
        message: 'invalid directory search input',
      });
    } finally {
      await harness.close();
    }
  });

  it('disabled echoes verifiedPublishersOnly', async () => {
    const p = createConnectorDirectoryPlugin({ enabled: false, verifiedPublishersOnly: true });
    const harness = await createTestHarness({ plugins: [p] });
    try {
      expect(
        await harness.bus.call('connectors:directory-search', harness.ctx(), { query: '' }),
      ).toEqual({ ...OFF, verifiedOnly: true });
    } finally {
      await harness.close();
    }
  });

  it('disabled ignores the registry URL and the timers', () => {
    expect(() =>
      createConnectorDirectoryPlugin({
        enabled: false,
        registryUrl: 'http://x',
        syncIntervalMs: -1,
        syncInitialDelayMs: Number.NaN,
      }),
    ).not.toThrow();
  });

  it.each<[string, ConnectorDirectoryConfig]>([
    ['an http registry URL', { registryUrl: 'http://x' }],
    ['a registry URL with a password', { registryUrl: 'https://u:p@registry.example' }],
    ['a negative interval', { syncIntervalMs: -1 }],
    ['a negative initial delay', { syncInitialDelayMs: -1 }],
    ['a fractional interval', { syncIntervalMs: 1.5 }],
    ['a NaN interval', { syncIntervalMs: Number.NaN }],
    ['an infinite initial delay', { syncInitialDelayMs: Number.POSITIVE_INFINITY }],
    // Node runs a timer longer than 2^31 - 1 ms after 1 ms: back-to-back syncs.
    ['an interval past the longest timer', { syncIntervalMs: 2 ** 31 }],
  ])('enabled with %s fails with invalid-config', (_label, config) => {
    const err = refusal(() => createConnectorDirectoryPlugin(config));
    expect(err.code).toBe('invalid-config');
    expect(err.plugin).toBe('@ax/connector-directory');
    expect(err.message).not.toContain('u:p');
  });

  it('the longest timer Node keeps is accepted', () => {
    expect(() =>
      createConnectorDirectoryPlugin({ syncIntervalMs: 2 ** 31 - 1, syncInitialDelayMs: 0 }),
    ).not.toThrow();
  });

  it('the factory default is enabled against the official registry', () => {
    const p = createConnectorDirectoryPlugin();
    expect(p.manifest).toEqual(ENABLED_MANIFEST);
  });

  it('enabled: registers the provenance hooks and hears connector deletes', () => {
    expect(createConnectorDirectoryPlugin({ syncIntervalMs: 0 }).manifest).toEqual(
      ENABLED_MANIFEST,
    );
  });

  it('enabled, before init: sync() is disabled and drain() resolves', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const p = createConnectorDirectoryPlugin({ fetchImpl });
    expect(await p.sync()).toEqual({ outcome: 'disabled' });
    await p.drain();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
