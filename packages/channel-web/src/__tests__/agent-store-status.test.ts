import { describe, it, expect, beforeEach } from 'vitest';
import {
  agentStoreActions,
  getAgentStoreSnapshot,
} from '../lib/agent-store';

describe('agent-store load status', () => {
  beforeEach(() => {
    // Reset to a known baseline (module singleton).
    agentStoreActions.resetForTest();
  });

  it('starts in loading status with no agents', () => {
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('loading');
    expect(s.agents).toEqual([]);
  });

  it('setAgents flips status to ready (even for an empty list)', () => {
    agentStoreActions.setAgents([]);
    expect(getAgentStoreSnapshot().agentsStatus).toBe('ready');
    expect(getAgentStoreSnapshot().agents).toEqual([]);
  });

  it('setAgentsError flips status to error without touching the agent list', () => {
    agentStoreActions.setAgents([
      { id: 'a1', name: 'Ada' } as never,
    ]);
    agentStoreActions.setAgentsError();
    const s = getAgentStoreSnapshot();
    expect(s.agentsStatus).toBe('error');
    expect(s.agents).toHaveLength(1);
  });
});
