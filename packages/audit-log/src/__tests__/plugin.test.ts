import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '@ax/test-harness';
import type { AgentOutcome } from '@ax/core';
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
    const outcome: AgentOutcome = {
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
    const result = await h.bus.fire<{ outcome: AgentOutcome }>('chat:end', ctx, {
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
    expect(p.manifest.subscribes).toContain('event.http-egress');
  });

  it('subscribes to event.http-egress and persists one row per egress', async () => {
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
    const ctx = h.ctx();
    await h.bus.fire('event.http-egress', ctx, {
      sessionId: 's1',
      userId: 'u1',
      method: 'CONNECT',
      host: 'api.anthropic.com',
      path: '/',
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 12,
      credentialInjected: true,
      classification: 'llm',
      timestamp: 1700000000000,
    });
    expect(writes).toHaveLength(1);
    // Key shape: egress:<scope>:<timestamp>:<uuid>. UUID suffix breaks
    // ms-resolution collisions; the timestamp prefix preserves sort order.
    expect(writes[0]!.key).toMatch(
      /^egress:s1:1700000000000:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const decoded = JSON.parse(new TextDecoder().decode(writes[0]!.value));
    expect(decoded).toMatchObject({
      sessionId: 's1',
      host: 'api.anthropic.com',
      classification: 'llm',
      credentialInjected: true,
    });
  });

  it('keys allowlist-miss events under "unscoped" when sessionId is empty', async () => {
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
    const ctx = h.ctx();
    await h.bus.fire('event.http-egress', ctx, {
      sessionId: '',
      userId: '',
      method: 'CONNECT',
      host: 'evil.example.com',
      path: '/',
      status: 403,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
      credentialInjected: false,
      classification: 'other',
      blockedReason: 'allowlist',
      timestamp: 1700000001000,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toMatch(
      /^egress:unscoped:1700000001000:[0-9a-f-]{36}$/,
    );
  });

  it('writes distinct keys for two egress events in the same millisecond', async () => {
    // ms-resolution timestamps will collide under load (LLM + MCP fired
    // concurrently, async I/O bursts, etc.). Without the UUID suffix the
    // second write would overwrite the first via storage:set's overwrite-
    // on-key semantics. Verify both rows persist.
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
    const ctx = h.ctx();
    const samePayload = {
      sessionId: 's1',
      userId: 'u1',
      method: 'CONNECT',
      host: 'api.anthropic.com',
      path: '/',
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
      credentialInjected: true,
      classification: 'llm' as const,
      timestamp: 1700000002000,
    };
    await h.bus.fire('event.http-egress', ctx, samePayload);
    await h.bus.fire('event.http-egress', ctx, samePayload);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).not.toBe(writes[1]!.key);
    // Both keys share the same timestamp prefix so storage iteration in
    // key order keeps a coherent chronological window even under collisions.
    expect(writes[0]!.key.startsWith('egress:s1:1700000002000:')).toBe(true);
    expect(writes[1]!.key.startsWith('egress:s1:1700000002000:')).toBe(true);
  });

  it('bootstrap fails with missing-service if storage:set is not registered', async () => {
    await expect(
      createTestHarness({ plugins: [auditLogPlugin()] }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'missing-service' });
  });
});
