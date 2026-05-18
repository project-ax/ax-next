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

interface CapturedCall {
  hook: string;
  ctx: AgentContext;
  payload: ApplyCall;
}

interface FireCall {
  hook: string;
  ctx: AgentContext;
  payload: unknown;
}

function makeBus(opts: {
  applyOutcome?: { version: string; delta: unknown };
  applyThrows?: Error;
  fireThrows?: Error;
  fireResult?: { rejected: false; payload: unknown } | { rejected: true; reason: string };
} = {}) {
  const applies: CapturedCall[] = [];
  const fires: FireCall[] = [];
  const bus = {
    call: vi.fn(async (hook: string, ctx: AgentContext, payload: unknown) => {
      if (hook === 'workspace:apply') {
        if (opts.applyThrows) throw opts.applyThrows;
        applies.push({ hook, ctx, payload: payload as ApplyCall });
        return opts.applyOutcome ?? {
          version: 'v1',
          delta: { before: null, after: 'v1', changes: [] },
        };
      }
      throw new Error(`unexpected call: ${hook}`);
    }),
    fire: vi.fn(async (hook: string, ctx: AgentContext, payload: unknown) => {
      if (opts.fireThrows) throw opts.fireThrows;
      fires.push({ hook, ctx, payload });
      return opts.fireResult ?? { rejected: false, payload };
    }),
  };
  return { bus, applies, fires };
}

describe('seed-heartbeat subscriber', () => {
  it('calls workspace:apply with the heartbeat template and a ctx scoped to the new agent', async () => {
    const { bus, applies } = makeBus();
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    // Pass an "outer" ctx with a DIFFERENT agentId/userId — the agents
    // plugin's admin route would fire with its own plugin-name ctx. The
    // subscriber must rebuild a ctx scoped to the new agent before calling
    // workspace:apply, or the storage-tier routes to the wrong workspace.
    const outerCtx = makeAgentContext({
      sessionId: 'admin-route',
      agentId: '@ax/agents',
      userId: 'admin-actor',
    });
    await sub(outerCtx, { agentId: 'agt_new', ownerId: 'usr_owner', ownerType: 'user' });
    expect(applies).toHaveLength(1);
    const change = applies[0]!.payload.changes[0]!;
    expect(change.path).toBe(HEARTBEAT_PATH);
    expect(change.kind).toBe('put');
    expect(new TextDecoder().decode(change.content)).toBe(HEARTBEAT_TEMPLATE);
    expect(applies[0]!.payload.parent).toBeNull();
    expect(applies[0]!.payload.reason).toBe('seed heartbeat');
    // The seed ctx must point at the new agent, not the outer ctx's
    // `@ax/agents` plugin-name. Without this, the workspace-git-server
    // client plugin routes to the wrong (or no) workspace.
    expect(applies[0]!.ctx.agentId).toBe('agt_new');
    expect(applies[0]!.ctx.userId).toBe('usr_owner');
  });

  it('fires workspace:applied after a successful apply so the routine syncer indexes the new file', async () => {
    const delta = { before: null, after: 'v1', changes: [{ path: HEARTBEAT_PATH, kind: 'added' }] };
    const { bus, fires } = makeBus({ applyOutcome: { version: 'v1', delta } });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await sub(fakeCtx(), { agentId: 'agt_new', ownerId: 'u1', ownerType: 'user' });
    // workspace:apply doesn't trigger workspace:applied — that's the runner→host
    // IPC handler's job. The seed runs entirely host-side, so it must fire the
    // event itself or the routine syncer never sees the new file.
    expect(fires).toHaveLength(1);
    expect(fires[0]!.hook).toBe('workspace:applied');
    expect(fires[0]!.payload).toBe(delta);
    expect(fires[0]!.ctx.agentId).toBe('agt_new');
  });

  it('skips team-owned agents (no per-team userId for workspace routing yet)', async () => {
    const { bus } = makeBus();
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await sub(fakeCtx(), { agentId: 'agt_team', ownerId: 'team_x', ownerType: 'team' });
    expect(bus.call).not.toHaveBeenCalled();
    expect(bus.fire).not.toHaveBeenCalled();
  });

  it('does not fire workspace:applied when workspace:apply throws', async () => {
    const { bus, fires } = makeBus({ applyThrows: new Error('workspace gone') });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await expect(
      sub(fakeCtx(), { agentId: 'agt_a', ownerId: 'u1', ownerType: 'user' }),
    ).resolves.toBeUndefined();
    expect(fires).toHaveLength(0);
  });

  it('swallows parent-mismatch errors (L6: workspace may already have content)', async () => {
    const { bus } = makeBus({
      applyThrows: new Error('parent-mismatch: workspace has different parent'),
    });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await expect(
      sub(fakeCtx(), { agentId: 'agt_b', ownerId: 'u2', ownerType: 'user' }),
    ).resolves.toBeUndefined();
  });

  it('swallows fire-time failures so apply-already-landed never crashes', async () => {
    const { bus } = makeBus({ fireThrows: new Error('fire crashed') });
    const sub = createSeedHeartbeatSubscriber({ bus: bus as unknown as HookBus });
    await expect(
      sub(fakeCtx(), { agentId: 'agt_c', ownerId: 'u3', ownerType: 'user' }),
    ).resolves.toBeUndefined();
  });
});
