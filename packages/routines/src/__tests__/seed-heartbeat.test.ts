import { describe, it, expect, vi } from 'vitest';
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { createSeedHeartbeatSubscriber } from '../seed-heartbeat.js';
import { HEARTBEAT_TEMPLATE, HEARTBEAT_PATH } from '../heartbeat-template.js';

function fakeCtx(): AgentContext {
  return makeAgentContext({ sessionId: 'test', agentId: 'agt_a', userId: 'u1' });
}

interface ApplyCall {
  changes: Array<{ path: string; kind: string; content: Uint8Array }>;
  parent: unknown;
  reason?: string;
}

describe('seed-heartbeat subscriber', () => {
  it('calls workspace:apply with the heartbeat template on agents:created', async () => {
    const applies: ApplyCall[] = [];
    const bus = {
      call: vi.fn(async (hook: string, _ctx: unknown, payload: unknown) => {
        if (hook === 'workspace:apply') {
          applies.push(payload as ApplyCall);
          return { version: 'v1', delta: { before: null, after: 'v1', changes: [] } };
        }
        throw new Error(`unexpected: ${hook}`);
      }),
    };
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await sub(fakeCtx(), { agentId: 'agt_a', ownerId: 'u1', ownerType: 'user' });
    expect(applies).toHaveLength(1);
    const change = applies[0]!.changes[0]!;
    expect(change.path).toBe(HEARTBEAT_PATH);
    expect(change.kind).toBe('put');
    expect(new TextDecoder().decode(change.content)).toBe(HEARTBEAT_TEMPLATE);
    expect(applies[0]!.parent).toBeNull();
    expect(applies[0]!.reason).toBe('seed heartbeat');
  });

  it('swallows workspace:apply failures (L6)', async () => {
    const bus = {
      call: vi.fn(async () => { throw new Error('workspace gone'); }),
    };
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    // Must NOT throw.
    await expect(
      sub(fakeCtx(), { agentId: 'agt_a', ownerId: 'u1', ownerType: 'user' }),
    ).resolves.toBeUndefined();
  });

  it('swallows parent-mismatch errors (L6: workspace may already have content)', async () => {
    const bus = {
      call: vi.fn(async () => {
        throw new Error('parent-mismatch: workspace has different parent');
      }),
    };
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await expect(
      sub(fakeCtx(), { agentId: 'agt_b', ownerId: 'u2', ownerType: 'team' }),
    ).resolves.toBeUndefined();
  });
});
