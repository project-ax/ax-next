import { HookBus, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { decideTier, runsAsConnector, type SenderFacts, type SenderTier } from '../channel-route.js';
import { agentAccess, managerAccess, type AgentAccess } from '../channels.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';

/*
  Who a channel mention runs as (the plan's sender tiers):
    A  an AX user who can use the agent          → attended, as themselves
    B  an AX user who can't                       → external, as the connector
    C  no AX account, email on an approved domain → external, as the connector
    D  no AX account, any other email             → refused: silence
    E  A/B/C, but the binding is broken           → unavailable: a private line
  Guests, bots, strangers and Slack Connect are refused before this (admission).
*/

const SENDER = 'usr_sender';
const CONNECTOR = 'usr_connector';

const mapped = (access: AgentAccess): SenderFacts => ({ mappedUserId: SENDER, access, approved: null });
const unmapped = (approved: boolean): SenderFacts => ({ mappedUserId: null, access: null, approved });

const attended: SenderTier = { tier: 'attended', userId: SENDER };
const external: SenderTier = { tier: 'external', userId: CONNECTOR };
const offDomain: SenderTier = { tier: 'refused', reason: 'off-domain' };
const unavailable = (reason: 'connector-no-access' | 'agent-gone' | 'not-team-agent'): SenderTier => ({
  tier: 'unavailable',
  reason,
});

const CONNECTOR_ANSWERS: ReadonlyArray<AgentAccess | null> = ['yes', 'no', 'agent-gone', 'not-shared', null];

describe('decideTier: who a channel mention runs as', () => {
  it.each([
    // B and C run as the connector, so the connector must still be able to use the agent.
    ['B: an AX user without access', mapped('no'), 'yes', external],
    ['B', mapped('no'), 'no', unavailable('connector-no-access')],
    ['B', mapped('no'), 'agent-gone', unavailable('agent-gone')],
    ['B', mapped('no'), 'not-shared', unavailable('not-team-agent')],
    ['C: no account, approved domain', unmapped(true), 'yes', external],
    ['C', unmapped(true), 'no', unavailable('connector-no-access')],
    ['C', unmapped(true), 'agent-gone', unavailable('agent-gone')],
    ['C', unmapped(true), 'not-shared', unavailable('not-team-agent')],
    // The connector's access not asked: never run as someone nobody checked.
    ['B, connector not asked', mapped('no'), null, unavailable('connector-no-access')],
    ['C, connector not asked', unmapped(true), null, unavailable('connector-no-access')],
  ] as const)('%s, connector %s → %o', (_name, sender, connectorAccess, want) => {
    expect(decideTier({ sender, connector: { userId: CONNECTOR, access: connectorAccess } })).toEqual(want);
  });

  it.each(CONNECTOR_ANSWERS)('A: an AX user who can use the agent is attended, whatever the connector (%s)', (access) => {
    expect(decideTier({ sender: mapped('yes'), connector: { userId: CONNECTOR, access } })).toEqual(attended);
  });

  it.each(CONNECTOR_ANSWERS)(
    "a sender whose own lookup says the agent is gone, or isn't a shared agent, is never attended (connector %s)",
    (access) => {
      const connector = { userId: CONNECTOR, access };
      expect(decideTier({ sender: mapped('agent-gone'), connector })).toEqual(unavailable('agent-gone'));
      expect(decideTier({ sender: mapped('not-shared'), connector })).toEqual(unavailable('not-team-agent'));
    },
  );

  it.each(CONNECTOR_ANSWERS)(
    'D: no account and an email off every approved domain is refused, and learns nothing about the binding (connector %s)',
    (access) => {
      expect(decideTier({ sender: unmapped(false), connector: { userId: CONNECTOR, access } })).toEqual(offDomain);
    },
  );

  it('an empty user id is never a person: never attended, never run as', () => {
    // A mapped sender whose id is empty is no AX user: only an approved email could admit them.
    expect(decideTier({ sender: { mappedUserId: '', access: 'yes', approved: null }, connector: { userId: CONNECTOR, access: 'yes' } })).toEqual(
      offDomain,
    );
    // A binding whose connector id is empty has nobody to run as.
    expect(decideTier({ sender: mapped('no'), connector: { userId: '', access: 'yes' } })).toEqual(
      unavailable('connector-no-access'),
    );
    expect(decideTier({ sender: unmapped(true), connector: { userId: '', access: 'yes' } })).toEqual(
      unavailable('connector-no-access'),
    );
  });

  it('answers it cannot read admit nobody', () => {
    const connector = { userId: CONNECTOR, access: 'yes' as const };
    // Only a literal true approves; only the four known answers count.
    for (const approved of ['true', 1, null, undefined]) {
      const sender = { mappedUserId: null, access: null, approved } as unknown as SenderFacts;
      expect(decideTier({ sender, connector }), String(approved)).toEqual(offDomain);
    }
    for (const access of ['YES', 'maybe', null, undefined]) {
      const sender = { mappedUserId: SENDER, access, approved: null } as unknown as SenderFacts;
      expect(decideTier({ sender, connector }), String(access)).toEqual(offDomain);
    }
    const garbled = { userId: CONNECTOR, access: 'YES' } as unknown as { userId: string; access: AgentAccess };
    expect(decideTier({ sender: mapped('no'), connector: garbled })).toEqual(unavailable('connector-no-access'));
  });
});

describe("runsAsConnector: the senders whose turn would run as the channel's connector", () => {
  it.each([
    [mapped('no'), true],
    [unmapped(true), true],
    [mapped('yes'), false],
    [mapped('agent-gone'), false],
    [mapped('not-shared'), false],
    [unmapped(false), false],
    [{ mappedUserId: '', access: 'no', approved: null } as SenderFacts, false],
  ] as const)('%o → %s', (sender, want) => {
    expect(runsAsConnector(sender)).toBe(want);
  });

  it('decideTier asks for the connector exactly when runsAsConnector says so', () => {
    const senders: SenderFacts[] = [
      mapped('yes'),
      mapped('no'),
      mapped('agent-gone'),
      mapped('not-shared'),
      unmapped(true),
      unmapped(false),
    ];
    for (const sender of senders) {
      // With the connector unasked, only a sender who needs it lands on "connector-no-access".
      const tier = decideTier({ sender, connector: { userId: CONNECTOR, access: null } });
      const needed = tier.tier === 'unavailable' && tier.reason === 'connector-no-access';
      expect(needed, JSON.stringify(sender)).toBe(runsAsConnector(sender));
    }
  });
});

// ── A personal agent shared with other people (TASK-1248) ───────────────────

/*
  Its channel's tiers, from the facts the router gathers (router.ts step 5):
  agents:resolve for a sender with an AX account (`agentAccess`), then, only
  for a turn that would run as the connector, whether the connector still
  manages the agent (`managerAccess`: an owner of a shared personal agent).
*/
describe("a shared personal agent's channel: who a mention runs as", () => {
  const ALICE = 'usr_alice'; // made the agent, and set its bot up: the connector
  const CAROL = 'usr_carol'; // a co-owner
  const BOB = 'usr_bob'; // someone it is shared with
  const DAN = 'usr_dan'; // an AX user it is not shared with
  /** Alice's agent, co-owned by Carol and shared with Bob alone. */
  const SHARED: FakeAgent = {
    id: 'agt_alice',
    displayName: "Alice's agent",
    visibility: 'personal',
    ownerType: 'user',
    ownerId: ALICE,
    coOwners: [CAROL],
  };
  /** The same people's agent, never shared: Just me. */
  const JUST_ME: FakeAgent = { ...SHARED, id: 'agt_alice_just_me' };
  const ctx = makeAgentContext({ sessionId: 'test', agentId: '', userId: 'system' });

  function world() {
    const bus = new HookBus();
    const people = fakeAgents(bus);
    people.addAgent(SHARED);
    people.addAgent(JUST_ME);
    people.shareWith(SHARED.id, BOB);
    return { bus, people };
  }

  /** The tier, as the router decides it. `sender` null: no AX account, an email on an approved domain. */
  async function tierOf(
    w: ReturnType<typeof world>,
    agentId: string,
    sender: string | null,
    connector: string,
  ): Promise<SenderTier> {
    const facts: SenderFacts =
      sender === null
        ? { mappedUserId: null, access: null, approved: true }
        : { mappedUserId: sender, access: await agentAccess(w.bus, ctx, agentId, sender), approved: null };
    const access = runsAsConnector(facts) ? await managerAccess(w.bus, ctx, agentId, connector) : null;
    return decideTier({ sender: facts, connector: { userId: connector, access } });
  }

  it('A: its owners and anyone it is shared with are attended, as themselves, whoever set the bot up', async () => {
    const w = world();
    for (const sender of [ALICE, CAROL, BOB]) {
      expect(await tierOf(w, SHARED.id, sender, ALICE), sender).toEqual({ tier: 'attended', userId: sender });
      // Even with a connector who manages nothing: a member never depends on the connector.
      expect(await tierOf(w, SHARED.id, sender, BOB), sender).toEqual({ tier: 'attended', userId: sender });
    }
  });

  it('B and C: an AX user it is not shared with, or no account on an approved domain, runs external as the connector, an owner', async () => {
    const w = world();
    expect(await tierOf(w, SHARED.id, DAN, ALICE)).toEqual({ tier: 'external', userId: ALICE });
    expect(await tierOf(w, SHARED.id, null, ALICE)).toEqual({ tier: 'external', userId: ALICE });
    // A co-owner who took the bot over vouches the same way.
    expect(await tierOf(w, SHARED.id, DAN, CAROL)).toEqual({ tier: 'external', userId: CAROL });
  });

  it('a connector who no longer manages it, though it is still shared with them, runs nobody: connector-no-access', async () => {
    const w = world();
    // Bob can use the agent, but he isn't one of its owners.
    expect(await tierOf(w, SHARED.id, DAN, BOB)).toEqual({ tier: 'unavailable', reason: 'connector-no-access' });
    // Carol stops being a co-owner: on the very next mention, nobody runs as her.
    expect(await tierOf(w, SHARED.id, null, CAROL)).toEqual({ tier: 'external', userId: CAROL });
    w.people.agents.set(SHARED.id, { ...SHARED, coOwners: [] });
    expect(await tierOf(w, SHARED.id, null, CAROL)).toEqual({ tier: 'unavailable', reason: 'connector-no-access' });
  });

  it('not-shared is unavailable: on a Just-me agent no mention runs, its owners included', async () => {
    const w = world();
    for (const sender of [ALICE, CAROL, DAN, null]) {
      expect(await tierOf(w, JUST_ME.id, sender, ALICE), String(sender)).toEqual({
        tier: 'unavailable',
        reason: 'not-team-agent',
      });
    }
  });
});
