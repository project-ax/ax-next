import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '@ax/test-harness';
import type { ChatOutcome } from '@ax/core';
import { auditLogPlugin } from '../plugin.js';

describe('@ax/audit-log', () => {
  it('subscribes to chat:end and writes the outcome to storage:set', async () => {
    const writes: Array<{ key: string; value: Uint8Array }> = [];
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:set': async (_ctx, input) => {
          writes.push(input as { key: string; value: Uint8Array });
        },
      },
      plugins: [auditLogPlugin()],
    });

    const ctx = h.ctx({ reqId: 'req-abc' });
    const outcome: ChatOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    await h.bus.fire('chat:end', ctx, { outcome });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toBe('chat:req-abc');
    const decoded = JSON.parse(new TextDecoder().decode(writes[0]!.value));
    expect(decoded).toMatchObject({
      reqId: 'req-abc',
      sessionId: 'test-session',
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
    });
    expect(typeof decoded.timestamp).toBe('string');
  });

  it('returns pass-through (undefined) — does not transform chat:end payload', async () => {
    const h = await createTestHarness({
      services: { ...MockServices.basics(), 'storage:set': async () => undefined },
      plugins: [auditLogPlugin()],
    });
    const ctx = h.ctx();
    const result = await h.bus.fire<{ outcome: ChatOutcome }>('chat:end', ctx, {
      outcome: { kind: 'complete', messages: [] },
    });
    expect(result).toMatchObject({
      rejected: false,
      payload: { outcome: { kind: 'complete', messages: [] } },
    });
  });

  it('declares the right manifest', () => {
    const p = auditLogPlugin();
    expect(p.manifest.name).toBe('@ax/audit-log');
    expect(p.manifest.registers).toEqual([]);
    expect(p.manifest.calls).toContain('storage:set');
    expect(p.manifest.subscribes).toContain('chat:end');
  });

  it('bootstrap fails with missing-service if storage:set is not registered', async () => {
    await expect(
      createTestHarness({ plugins: [auditLogPlugin()] }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'missing-service' });
  });
});
