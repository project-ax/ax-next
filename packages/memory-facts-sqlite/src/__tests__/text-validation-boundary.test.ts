import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookBus, makeAgentContext, type Plugin } from '@ax/core';
import type { FactStatementInput } from '@ax/memory-facts-contract';
import { createMemoryFactsSqlitePlugin } from '../plugin.js';

const { storeTouched } = vi.hoisted(() => ({
  storeTouched: vi.fn(() => { throw new Error('deliberately unavailable test store'); }),
}));

vi.mock('../schema.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../schema.js')>(),
  openDatabase: vi.fn(() => ({
    driver: { open: true, transaction: storeTouched, close: vi.fn() },
    vectorExtensionLoaded: false,
  })),
}));

const LIMITS = [['about', 1024], ['relation', 1024], ['value', 8192], ['slot', 256]] as const;
const CONTROLS = [
  ...Array.from({ length: 0x20 }, (_, code) => code),
  ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
];
const BASE: FactStatementInput = {
  about: 'user', relation: 'r', value: 'v', when: '2023-01-01T00:00:00.000Z', slot: 'text-slot',
};
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

describe('@ax/memory-facts-sqlite text validation before the store', () => {
  let bus: HookBus;
  let plugin: Plugin;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new HookBus();
    plugin = createMemoryFactsSqlitePlugin({ databasePath: ':memory:' });
    await plugin.init({ bus, config: {} });
  });

  afterEach(async () => {
    await plugin.shutdown?.();
  });

  const record = (statement: FactStatementInput) =>
    bus.call('memory:facts:record', ctx, { statements: [statement] });
  const reindex = (slot: string | null) =>
    bus.call('memory:facts:reindex', ctx, { slots: [{ id: 'pending-id', slot }] });

  for (const [field, max] of LIMITS) {
    it(`${field}: rejects every forbidden C0/C1 character before storage`, async () => {
      for (const code of CONTROLS) {
        if (field === 'value' && (code === 0x09 || code === 0x0a)) continue;
        await expect(
          record({ ...BASE, [field]: `prefix${String.fromCharCode(code)}suffix` }),
          `${field}: U+${code.toString(16).padStart(4, '0')}`,
        ).rejects.toMatchObject({ code: 'invalid-payload' });
        expect(storeTouched).not.toHaveBeenCalled();
      }
    });

    it(`${field}: rejects text beyond its UTF-16 limit before storage`, async () => {
      for (const text of ['a'.repeat(max + 1), '\u{10400}'.repeat(max / 2) + 'x']) {
        await expect(record({ ...BASE, [field]: text })).rejects.toMatchObject({
          code: 'invalid-payload',
        });
        expect(storeTouched).not.toHaveBeenCalled();
      }
    });

    it(`${field}: compatibility: admits text at the exact UTF-16 limit`, async () => {
      await expect(record({ ...BASE, [field]: '\u{10400}'.repeat(max / 2) })).rejects.toMatchObject({
        code: 'store-unavailable',
      });
      expect(storeTouched).toHaveBeenCalledOnce();
    });

    it(`${field}: compatibility: admits Unicode, spaces and punctuation`, async () => {
      const text = field === 'value'
        ? '  Café 東京 | first\tcolumn\nnext \\ "quoted" \u{10400}  '
        : '  Café 東京 | a/b \\ "quoted" \u{10400}  ';
      await expect(record({ ...BASE, [field]: text })).rejects.toMatchObject({
        code: 'store-unavailable',
      });
      expect(storeTouched).toHaveBeenCalledOnce();
    });
  }

  it('validates the entire batch before the first store operation', async () => {
    await expect(bus.call('memory:facts:record', ctx, {
      statements: [BASE, { ...BASE, value: `prefix${String.fromCharCode(0)}suffix` }],
    })).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(storeTouched).not.toHaveBeenCalled();
  });

  it('reindex rejects every C0/C1 character in a new slot before storage', async () => {
    for (const code of CONTROLS) {
      await expect(reindex(`prefix${String.fromCharCode(code)}suffix`)).rejects.toMatchObject({
        code: 'invalid-payload',
      });
      expect(storeTouched).not.toHaveBeenCalled();
    }
  });

  it('reindex rejects an overlong new slot before storage', async () => {
    await expect(reindex('a'.repeat(257))).rejects.toMatchObject({ code: 'invalid-payload' });
    expect(storeTouched).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(256), null])('reindex compatibility: admits %s', async (slot) => {
    await expect(reindex(slot)).rejects.toMatchObject({ code: 'store-unavailable' });
    expect(storeTouched).toHaveBeenCalledOnce();
  });
});
