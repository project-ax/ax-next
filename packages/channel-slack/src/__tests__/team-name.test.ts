import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { logCode } from '../log-code.js';
import { agentTeamName } from '../team-name.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';

/*
  The agent's team, by name, as one person on it sees it (team-name.ts,
  TASK-1203): what a team bot's memory notice names. agents:resolve is
  answered as @ax/agents answers it (fake-agents.ts), teams:list-for-user as
  @ax/teams answers it: the teams a person has a role on, each with its
  display name, typed by an admin and so from outside.
*/

const CARE_TEAM = 'team_care';
const SALES_TEAM = 'team_sales';
const SUPPORT: FakeAgent = { id: 'agt_support', displayName: 'Support', visibility: 'team', ownerType: 'team', ownerId: CARE_TEAM };
/** A team admin of the care team. */
const ADA = 'usr_ada';
/** A plain member of the care team. */
const BOB = 'usr_bob';
/** On the sales team only: the support agent isn't hers to see. */
const SAM = 'usr_sam';
const RLO = String.fromCharCode(0x202e);
/** A zero-width space: invisible, so a name of only this has nothing printable. */
const ZWSP = String.fromCharCode(0x200b);

function world(o: { teams?: boolean } = {}) {
  const bus = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
  const agents = fakeAgents(bus);
  agents.addAgent(SUPPORT);
  agents.addAgent({ id: 'agt_ada_own', displayName: 'Ada Own', visibility: 'personal', ownerType: 'user', ownerId: ADA });
  agents.setRole(CARE_TEAM, ADA, 'admin');
  agents.setRole(CARE_TEAM, BOB, 'member');
  agents.setRole(SALES_TEAM, SAM, 'admin');

  /** @ax/teams, unless the world has none. `answer` replaces what it lists; `fault` makes it throw. */
  const names = new Map([
    [CARE_TEAM, 'Customer Care'],
    [SALES_TEAM, 'Sales'],
  ]);
  const teams: { asked: string[]; fault?: unknown; answer?: unknown } = { asked: [] };
  if (o.teams !== false) {
    bus.registerService('teams:list-for-user', '@ax/teams', async (_ctx, raw) => {
      const userId = (raw as { userId: string }).userId;
      teams.asked.push(userId);
      if (teams.fault !== undefined) throw teams.fault;
      if ('answer' in teams) return teams.answer;
      return {
        teams: agents.teamsOf(userId).map((id) => ({ id, displayName: names.get(id) ?? id, createdBy: ADA, createdAt: new Date(0) })),
      };
    });
  }

  const faults: unknown[] = [];
  const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: ADA });
  const nameFor = (agentId: string, userId = ADA) => agentTeamName(bus, ctx, { agentId, userId }, (err) => faults.push(err));
  return { bus, agents, names, teams, faults, nameFor };
}

describe('agentTeamName', () => {
  it('without teams:list-for-user it is null and asks nothing', async () => {
    const w = world({ teams: false });
    expect(await w.nameFor(SUPPORT.id)).toBeNull();
    // Not even the agent: with no names to look in, there is nothing to look up.
    expect(w.agents.calls).toEqual([]);
    expect(w.faults).toEqual([]);
  });

  it("a team agent's team, as the person's own team list names it, cleaned", async () => {
    const w = world();
    expect(await w.nameFor(SUPPORT.id)).toBe('Customer Care');
    // Asked as the person: the agent as they see it, then their own teams.
    expect(w.agents.inputs('agents:resolve')).toEqual([{ agentId: SUPPORT.id, userId: ADA }]);
    expect(w.teams.asked).toEqual([ADA]);
    // A plain member of the team reads the same name.
    expect(await w.nameFor(SUPPORT.id, BOB)).toBe('Customer Care');
    expect(w.teams.asked).toEqual([ADA, BOB]);

    // Cleaned to one line: no control, bidi or invisible characters, single spaces.
    w.names.set(CARE_TEAM, `  Customer\n\t${RLO}Care  `);
    expect(await w.nameFor(SUPPORT.id)).toBe('Customer Care');
    // Cleaned, never escaped: whoever shows it in Slack escapes it there (copy.ts `shown`).
    w.names.set(CARE_TEAM, '<!channel> & <@U1>');
    expect(await w.nameFor(SUPPORT.id)).toBe('<!channel> & <@U1>');
    expect(w.faults).toEqual([]);
  });

  it('a personal agent, an answer about another agent, a team missing from the list, or a name blank after cleaning: null', async () => {
    const w = world();
    // A personal agent has no team: its team list isn't asked.
    expect(await w.nameFor('agt_ada_own')).toBeNull();
    expect(w.teams.asked).toEqual([]);

    // The person's list doesn't name the agent's team, or can't be read.
    for (const answer of [
      { teams: [{ id: SALES_TEAM, displayName: 'Sales' }] },
      { teams: [] },
      { teams: 'Customer Care' },
      { teams: [null, 5, 'team_care', { id: CARE_TEAM }, { id: 7, displayName: 'Customer Care' }, { displayName: 'Customer Care' }] },
      {},
      null,
    ]) {
      w.teams.answer = answer;
      expect(await w.nameFor(SUPPORT.id), JSON.stringify(answer)).toBeNull();
    }
    delete w.teams.answer;

    // A name with nothing printable in it.
    for (const blank of ['', '   ', `${RLO} ${ZWSP}`]) {
      w.names.set(CARE_TEAM, blank);
      expect(await w.nameFor(SUPPORT.id), JSON.stringify(blank)).toBeNull();
    }
    expect(w.faults).toEqual([]);

    // An answer about another agent than the one asked about names nothing.
    const other = new HookBus({ stallWarnMs: Number.POSITIVE_INFINITY });
    other.registerService('agents:resolve', '@ax/agents', async () => ({ agent: { ...SUPPORT, id: 'agt_other' } }));
    other.registerService('teams:list-for-user', '@ax/teams', async () => ({
      teams: [{ id: CARE_TEAM, displayName: 'Customer Care' }],
    }));
    const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: ADA });
    expect(await agentTeamName(other, ctx, { agentId: SUPPORT.id, userId: ADA }, (err) => w.faults.push(err))).toBeNull();
    expect(w.faults).toEqual([]);
  });

  it('a resolve or list that throws is null, and the fault goes to onFault; forbidden and not-found are quiet', async () => {
    const w = world();
    // Someone off the team (forbidden), or an agent that's gone (not-found): no name, quietly, no list asked.
    expect(await w.nameFor(SUPPORT.id, SAM)).toBeNull();
    expect(await w.nameFor('agt_gone')).toBeNull();
    expect(w.faults).toEqual([]);
    expect(w.teams.asked).toEqual([]);

    // agents:resolve down: no name, the fault handed on, no list asked.
    const reset = Object.assign(new Error('read ECONNRESET ada@canopyworks.com'), { code: 'ECONNRESET' });
    w.agents.faults.set('agents:resolve', reset);
    expect(await w.nameFor(SUPPORT.id)).toBeNull();
    expect(w.faults.map(logCode)).toEqual(['ECONNRESET']);
    expect(w.teams.asked).toEqual([]);
    w.agents.faults.delete('agents:resolve');

    // teams:list-for-user down: no name, the fault handed on.
    w.teams.fault = new PluginError({ code: 'store-unavailable', plugin: '@ax/teams', message: 'teams db down' });
    expect(await w.nameFor(SUPPORT.id)).toBeNull();
    expect(w.faults.map(logCode)).toEqual(['ECONNRESET', 'store-unavailable']);
  });

  it('never throws, even when the fault handler does', async () => {
    const w = world();
    w.teams.fault = new PluginError({ code: 'store-unavailable', plugin: '@ax/teams', message: 'teams db down' });
    const throwing = () => {
      throw new Error('log down');
    };
    const ctx = makeAgentContext({ sessionId: 'channel-slack', agentId: '', userId: ADA });
    await expect(agentTeamName(w.bus, ctx, { agentId: SUPPORT.id, userId: ADA }, throwing)).resolves.toBeNull();
    w.agents.faults.set('agents:resolve', new Error('agents down'));
    await expect(agentTeamName(w.bus, ctx, { agentId: SUPPORT.id, userId: ADA }, throwing)).resolves.toBeNull();
  });
});
