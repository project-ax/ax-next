import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext, PluginError, type AgentContext } from '@ax/core';
import { skillProposeHandler } from '../handlers/skill-propose.js';

const emptyCaps = { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } };

const validPayload = {
  manifestYaml: 'name: commit-style\ndescription: how we write commits\nversion: 1',
  bodyMd: '# body',
  files: [],
  capabilityProposal: emptyCaps,
  origin: 'authored' as const,
};

function boundCtx(): AgentContext {
  return makeAgentContext({ sessionId: 's1', agentId: 'a1', userId: 'u1' });
}

function busWithPropose(
  impl: (ctx: AgentContext, input: unknown) => Promise<unknown>,
): HookBus {
  const bus = new HookBus();
  bus.registerService('skills:propose', '@test/skills', impl as never);
  return bus;
}

describe('skill.propose handler (TASK-74)', () => {
  it('forwards a valid proposal to skills:propose with ctx-derived scope, returns the verdict', async () => {
    let seen: { ownerUserId: string; agentId: string; origin: string } | undefined;
    const bus = busWithPropose(async (_ctx, input) => {
      seen = input as never;
      return { skillId: 'commit-style', status: 'active' };
    });
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect(r.status).toBe(200);
    expect((r as { body: unknown }).body).toEqual({ skillId: 'commit-style', status: 'active' });
    // Scope comes from ctx (the session), not the wire body.
    expect(seen).toMatchObject({ ownerUserId: 'u1', agentId: 'a1', origin: 'authored' });
  });

  it('passes a quarantine reason through', async () => {
    const bus = busWithPropose(async () => ({
      skillId: 'evil',
      status: 'quarantined',
      reason: 'flagged',
    }));
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect((r as { body: unknown }).body).toEqual({
      skillId: 'evil',
      status: 'quarantined',
      reason: 'flagged',
    });
  });

  it('400s a malformed payload (no skills:propose call)', async () => {
    let called = false;
    const bus = busWithPropose(async () => {
      called = true;
      return { skillId: 'x', status: 'active' };
    });
    const r = await skillProposeHandler({ origin: 'authored' }, boundCtx(), bus);
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });

  it("rejects a runner-supplied origin other than 'authored' at the wire", async () => {
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    const r = await skillProposeHandler(
      { ...validPayload, origin: 'attached' },
      boundCtx(),
      bus,
    );
    expect(r.status).toBe(400);
  });

  it('rejects an unbound (placeholder-owner) session — cannot author into a foreign scope', async () => {
    const bus = busWithPropose(async () => ({ skillId: 'x', status: 'active' }));
    const unbound = makeAgentContext({ sessionId: 's', agentId: 'ipc-server', userId: 'ipc-server' });
    const r = await skillProposeHandler(validPayload, unbound, bus);
    expect(r.status).toBe(400);
  });

  it('maps a PluginError from the hook (invalid manifest) to its HTTP status', async () => {
    const bus = busWithPropose(async () => {
      throw new PluginError({ code: 'invalid-manifest', plugin: '@ax/skills', message: 'bad' });
    });
    const r = await skillProposeHandler(validPayload, boundCtx(), bus);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });
});
