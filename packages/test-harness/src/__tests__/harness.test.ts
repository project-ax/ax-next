import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '../index.js';
import type { Plugin } from '@ax/core';

describe('createTestHarness', () => {
  it('provides a bus and a ctx factory', async () => {
    const h = await createTestHarness({});
    expect(h.bus).toBeDefined();
    const ctx = h.ctx();
    expect(ctx.reqId).toMatch(/^req-/);
  });

  it('loads additional plugins passed in', async () => {
    let initCalled = false;
    const p: Plugin = {
      manifest: { name: 'p', version: '0.0.0', registers: [], calls: [], subscribes: [] },
      init: () => { initCalled = true; },
    };
    const h = await createTestHarness({ plugins: [p] });
    expect(initCalled).toBe(true);
    expect(h.bus).toBeDefined();
  });

  it('registers MockServices.basics when requested', async () => {
    const h = await createTestHarness({ services: MockServices.basics() });
    expect(h.bus.hasService('storage:get')).toBe(true);
    expect(h.bus.hasService('storage:set')).toBe(true);
    expect(h.bus.hasService('audit:write')).toBe(true);
    expect(h.bus.hasService('eventbus:emit')).toBe(true);
  });

  it('overrides a single service', async () => {
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:get': async () => 'mocked-value',
      },
    });
    const v = await h.bus.call('storage:get', h.ctx(), { key: 'anything' });
    expect(v).toBe('mocked-value');
  });

  it('does not register chat:run by default (orchestrator is an explicit plugin in 6.5a)', async () => {
    const h = await createTestHarness({});
    expect(h.bus.hasService('chat:run')).toBe(false);
  });
});
