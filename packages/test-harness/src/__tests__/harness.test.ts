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

  it('override a single service', async () => {
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:get': async () => 'mocked-value',
      },
    });
    const v = await h.bus.call('storage:get', h.ctx(), { key: 'anything' });
    expect(v).toBe('mocked-value');
  });

  it('chat:run returns terminated:no-service:llm:call when no llm plugin is loaded (Week 1-2 goal)', async () => {
    const h = await createTestHarness({ withChatLoop: true });
    const outcome = await h.bus.call('chat:run', h.ctx(), {
      message: { role: 'user', content: 'hi' },
    });
    expect(outcome).toMatchObject({ kind: 'terminated', reason: 'no-service:llm:call' });
  });
});
