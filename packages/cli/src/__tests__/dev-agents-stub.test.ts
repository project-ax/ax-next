// Tests for the dev-agents-stub. The stub already supports config-time
// override of allowedHosts + requiredCredentials; this test pins the
// behavior so a future refactor can't silently regress the OAuth path.

import { describe, it, expect } from 'vitest';
import { HookBus, bootstrap, makeAgentContext } from '@ax/core';
import { createDevAgentsStubPlugin } from '../dev-agents-stub.js';

interface AgentRecord {
  id: string;
  ownerId: string;
  allowedHosts?: string[];
  requiredCredentials?: Record<string, { ref: string; kind: string }>;
}

async function resolve(
  cfg: Parameters<typeof createDevAgentsStubPlugin>[0],
): Promise<AgentRecord> {
  const bus = new HookBus();
  await bootstrap({
    bus,
    plugins: [createDevAgentsStubPlugin(cfg)],
    config: {},
  });
  const out = await bus.call<{ agentId: string; userId: string }, { agent: AgentRecord }>(
    'agents:resolve',
    makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' }),
    { agentId: 'a', userId: 'u' },
  );
  return out.agent;
}

describe('dev-agents-stub', () => {
  it('default returns ANTHROPIC_API_KEY with kind=api-key (Phase 2 canary path)', async () => {
    const agent = await resolve({});
    expect(agent.allowedHosts).toEqual(['api.anthropic.com']);
    expect(agent.requiredCredentials).toEqual({
      ANTHROPIC_API_KEY: { ref: 'anthropic-api', kind: 'api-key' },
    });
  });

  it('OAuth override returns CLAUDE_CODE_OAUTH_TOKEN with kind=anthropic-oauth (Phase 3 rotation path)', async () => {
    const agent = await resolve({
      requiredCredentials: {
        CLAUDE_CODE_OAUTH_TOKEN: {
          ref: 'anthropic-personal',
          kind: 'anthropic-oauth',
        },
      },
    });
    expect(agent.requiredCredentials).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: {
        ref: 'anthropic-personal',
        kind: 'anthropic-oauth',
      },
    });
  });

  it('overriding requiredCredentials does not silently inherit the api-key default', async () => {
    // Regression guard: if a future refactor merges instead of replaces,
    // OAuth users would unexpectedly carry an api-key credential too.
    const agent = await resolve({
      requiredCredentials: {
        CLAUDE_CODE_OAUTH_TOKEN: {
          ref: 'anthropic-personal',
          kind: 'anthropic-oauth',
        },
      },
    });
    expect(agent.requiredCredentials).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});
