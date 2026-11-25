import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { agentAccess, checkRights, managerAccess } from '../channels.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';

/*
  Who may manage an agent's Slack bot and its channels, and so whose account
  a bot channel's outsiders run as. Only a shared agent has a bot: a team
  agent, or a personal agent whose agents:resolve answer says `shared: true`
  exactly (TASK-1248; never its `audience`). The rules pinned here: someone
  who can't see the agent learns nothing (a missing agent and a forbidden one
  answer alike); only a team admin of a team agent's team manages it, and
  workspace-admin status never counts; only an owner of a shared personal
  agent manages that one, read from the same answer; a "Just me" personal
  agent is refused before anything else is asked. What a channel must be for
  a bot to bind it (`connectable`) is pinned with the turn-start check that
  shares it (channel-check.test.ts).
*/

// ── Fixtures ────────────────────────────────────────────────────────────────

const SUPPORT_TEAM = 'team_support';
const SALES_TEAM = 'team_sales';
const SUPPORT: FakeAgent = {
  id: 'agt_support',
  displayName: 'Support',
  visibility: 'team',
  ownerType: 'team',
  ownerId: SUPPORT_TEAM,
};
const SALES: FakeAgent = { id: 'agt_sales', displayName: 'Sales', visibility: 'team', ownerType: 'team', ownerId: SALES_TEAM };
const PATS: FakeAgent = { id: 'agt_pat', displayName: "Pat's agent", visibility: 'personal', ownerType: 'user', ownerId: 'usr_pat' };

const ADA = 'usr_ada'; // a team admin of the support team
const GRACE = 'usr_grace'; // another team admin of the support team
const MEL = 'usr_mel'; // a plain member of the support team
const WILL = 'usr_will'; // a workspace admin, and a plain member of the support team
const OTTO = 'usr_otto'; // in no team
const PAT = 'usr_pat'; // owns a personal agent
const SAM = 'usr_sam'; // a team admin of the sales team
const ALICE = 'usr_alice'; // made a personal agent and shared it with everyone
const CAROL = 'usr_carol'; // a co-owner of Alice's agent
const BOB = 'usr_bob'; // any other AX user: Alice's agent is shared with him

/** Alice's personal agent, shared with everyone; Carol co-owns it (TASK-1246). */
const ALICES: FakeAgent = {
  id: 'agt_alice',
  displayName: "Alice's agent",
  visibility: 'personal',
  ownerType: 'user',
  ownerId: ALICE,
  audience: 'everyone',
  coOwners: [CAROL],
};

const ctx = makeAgentContext({ sessionId: 'test', agentId: '', userId: 'system' });

/** A personal agent's resolve answer, as agents:resolve shapes it, about Alice's agent and someone it admits. */
const personalAnswer = (fields: Record<string, unknown>) => ({
  agent: {
    id: ALICES.id,
    ownerId: ALICE,
    ownerType: 'user',
    visibility: 'personal',
    displayName: "Alice's agent",
    // What a shared agent's answer also says: never read, so it can't make one shared.
    audience: 'everyone',
    ...fields,
  },
});

/** A bus whose agents:resolve answers `answer` about anyone, and records every can-set-shared-credential ask. */
function answering(answer: unknown) {
  const bus = new HookBus();
  const asked: unknown[] = [];
  bus.registerService('agents:resolve', '@ax/agents', async () => answer);
  bus.registerService('agents:can-set-shared-credential', '@ax/agents', async (_ctx, input) => {
    asked.push(input);
    return { allowed: true };
  });
  return { bus, asked };
}

// ── The world ───────────────────────────────────────────────────────────────

function world(o: { workspaceAdminsMayManage?: boolean } = {}) {
  const bus = new HookBus();
  const people = fakeAgents(bus, o);
  for (const agent of [SUPPORT, SALES, PATS, ALICES]) people.addAgent(agent);
  people.setRole(SUPPORT_TEAM, ADA, 'admin');
  people.setRole(SUPPORT_TEAM, GRACE, 'admin');
  people.setRole(SUPPORT_TEAM, MEL, 'member');
  people.setRole(SUPPORT_TEAM, WILL, 'member');
  people.setRole(SALES_TEAM, SAM, 'admin');
  return { bus, people };
}

// ── agentAccess ─────────────────────────────────────────────────────────────

describe('agentAccess', () => {
  it("is yes for a team agent the person can reach, no for one they can't, agent-gone for one that doesn't exist", async () => {
    const w = world();
    expect(await agentAccess(w.bus, ctx, SUPPORT.id, MEL)).toBe('yes');
    expect(await agentAccess(w.bus, ctx, SUPPORT.id, OTTO)).toBe('no');
    expect(await agentAccess(w.bus, ctx, 'agt_gone', MEL)).toBe('agent-gone');
    // Asked about the person given, never whoever the ctx names.
    expect(w.people.inputs('agents:resolve')).toEqual([
      { agentId: SUPPORT.id, userId: MEL },
      { agentId: SUPPORT.id, userId: OTTO },
      { agentId: 'agt_gone', userId: MEL },
    ]);
  });

  it("a Just-me agent is still not-shared, its own creator's included", async () => {
    const w = world();
    expect(await agentAccess(w.bus, ctx, PATS.id, PAT)).toBe('not-shared');
    expect(await agentAccess(w.bus, ctx, PATS.id, ADA)).toBe('no');
    // A co-owner can use a Just-me agent too, and it is still nobody's shared agent.
    w.people.agents.set(PATS.id, { ...PATS, coOwners: [MEL] });
    expect(await agentAccess(w.bus, ctx, PATS.id, MEL)).toBe('not-shared');
  });

  it('is yes for a personal agent shared with everyone, for its owners and the people it is shared with', async () => {
    const w = world();
    // Its creator, its co-owner, and anyone else at all: everyone can use it.
    for (const person of [ALICE, CAROL, BOB, OTTO]) {
      expect(await agentAccess(w.bus, ctx, ALICES.id, person), person).toBe('yes');
    }
    // Shared with a list: yes for its owner and whoever is on it, no for anyone else.
    w.people.shareWith(PATS.id, MEL);
    expect(await agentAccess(w.bus, ctx, PATS.id, PAT)).toBe('yes');
    expect(await agentAccess(w.bus, ctx, PATS.id, MEL)).toBe('yes');
    expect(await agentAccess(w.bus, ctx, PATS.id, OTTO)).toBe('no');
    // Back to Just me: the very next question says so, for its owners too. Nothing was kept.
    w.people.agents.set(ALICES.id, { ...ALICES, audience: 'just-me' });
    expect(await agentAccess(w.bus, ctx, ALICES.id, ALICE)).toBe('not-shared');
    expect(await agentAccess(w.bus, ctx, ALICES.id, CAROL)).toBe('not-shared');
    expect(await agentAccess(w.bus, ctx, ALICES.id, BOB)).toBe('no');
    // Whether someone may use it is all agentAccess asks: never the manage question.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it.each([
    ['no shared at all', undefined],
    ['shared false', false],
    ["shared as the string 'true'", 'true'],
    ['shared as 1', 1],
    ['shared null', null],
  ])('a personal answer with %s is not-shared, whatever its audience says', async (_what, shared) => {
    const { bus, asked } = answering(personalAnswer({ isOwner: true, ...(shared === undefined ? {} : { shared }) }));
    expect(await agentAccess(bus, ctx, ALICES.id, ALICE)).toBe('not-shared');
    expect(await managerAccess(bus, ctx, ALICES.id, ALICE)).toBe('not-shared');
    for (const need of ['view', 'manage'] as const) {
      expect(await checkRights(bus, ctx, ALICES.id, ALICE, need)).toEqual({ ok: false, reason: 'personal-agent' });
    }
    expect(asked).toEqual([]);
  });

  it('is not-shared for an answer it cannot vouch for: another agent, or no readable visibility', async () => {
    const team = { id: SUPPORT.id, ownerId: SUPPORT_TEAM, ownerType: 'team', visibility: 'team', displayName: 'Support' };
    const shared = personalAnswer({ shared: true, isOwner: true }).agent;
    const answers: Array<[unknown, string]> = [
      [{ agent: { ...team, id: SALES.id } }, SUPPORT.id],
      [{ agent: { ...team, visibility: 'TEAM' } }, SUPPORT.id],
      [{ agent: { ...team, visibility: undefined } }, SUPPORT.id],
      // A shared personal agent's answer, but about another agent.
      [{ agent: { ...shared, id: SALES.id } }, ALICES.id],
      // Shared, but with no visibility it can read.
      [{ agent: { ...shared, visibility: 'PERSONAL' } }, ALICES.id],
      [{ agent: { ...shared, visibility: undefined } }, ALICES.id],
      [{ agent: null }, SUPPORT.id],
      [{}, SUPPORT.id],
      [null, SUPPORT.id],
    ];
    for (const [answer, agentId] of answers) {
      const bus = new HookBus();
      bus.registerService('agents:resolve', '@ax/agents', async () => answer);
      expect(await agentAccess(bus, ctx, agentId, MEL), JSON.stringify(answer)).toBe('not-shared');
    }
  });

  it('lets any other failure through: an outage is not a refusal', async () => {
    const w = world();
    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    w.people.faults.set('agents:resolve', outage);
    await expect(agentAccess(w.bus, ctx, SUPPORT.id, MEL)).rejects.toBe(outage);
  });
});

// ── checkRights ─────────────────────────────────────────────────────────────

describe('checkRights', () => {
  it("lets any member of the agent's team view, and only a team admin manage", async () => {
    const w = world();
    const ok = { ok: true, agentId: SUPPORT.id, agentName: 'Support' };
    expect(await checkRights(w.bus, ctx, SUPPORT.id, MEL, 'view')).toEqual(ok);
    expect(await checkRights(w.bus, ctx, SUPPORT.id, MEL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual(ok);
    // A team admin of ANOTHER team can't even see it.
    expect(await checkRights(w.bus, ctx, SUPPORT.id, SAM, 'manage')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('answers someone outside the team exactly as it answers for an agent that does not exist', async () => {
    const w = world();
    for (const need of ['view', 'manage'] as const) {
      const outsider = await checkRights(w.bus, ctx, SUPPORT.id, OTTO, need);
      expect(outsider).toEqual({ ok: false, reason: 'not-found' });
      expect(await checkRights(w.bus, ctx, 'agt_gone', OTTO, need)).toEqual(outsider);
    }
    // Neither got as far as the manage question.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it('asks agents as a non-admin, always: workspace-admin status never manages a channel', async () => {
    // Even under an agents rule that WOULD let a workspace admin through.
    const w = world({ workspaceAdminsMayManage: true });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, WILL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toMatchObject({ ok: true });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: WILL, isAdmin: false } },
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
    ]);
  });

  it("refuses a Just-me personal agent as personal-agent to its owner and not-found to anyone else, asking nothing more", async () => {
    const w = world();
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'view')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'manage')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, ADA, 'manage')).toEqual({ ok: false, reason: 'not-found' });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
  });

  it('lets anyone a shared agent is shared with view, and only its owners manage', async () => {
    const w = world();
    const ok = { ok: true, agentId: ALICES.id, agentName: "Alice's agent" };
    // Its creator and its co-owner manage it.
    for (const owner of [ALICE, CAROL]) {
      expect(await checkRights(w.bus, ctx, ALICES.id, owner, 'view'), owner).toEqual(ok);
      expect(await checkRights(w.bus, ctx, ALICES.id, owner, 'manage'), owner).toEqual(ok);
    }
    // Anyone else it is shared with sees it, and may not manage it.
    for (const user of [BOB, OTTO]) {
      expect(await checkRights(w.bus, ctx, ALICES.id, user, 'view'), user).toEqual(ok);
      expect(await checkRights(w.bus, ctx, ALICES.id, user, 'manage'), user).toEqual({ ok: false, reason: 'forbidden' });
    }
    // Shared with a list: someone off it learns nothing, as for a missing agent.
    w.people.shareWith(PATS.id, MEL);
    expect(await checkRights(w.bus, ctx, PATS.id, MEL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'manage')).toMatchObject({ ok: true });
    for (const need of ['view', 'manage'] as const) {
      expect(await checkRights(w.bus, ctx, PATS.id, OTTO, need)).toEqual({ ok: false, reason: 'not-found' });
    }
    // Carol is no longer an owner but it is still shared with her: she sees it, and manages nothing.
    w.people.agents.set(ALICES.id, { ...ALICES, coOwners: [] });
    expect(await checkRights(w.bus, ctx, ALICES.id, CAROL, 'view')).toEqual(ok);
    expect(await checkRights(w.bus, ctx, ALICES.id, CAROL, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('never asks agents:can-set-shared-credential about a personal agent: owners manage from the resolve answer alone', async () => {
    // An answer that WOULD let anyone manage, if it were ever asked.
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', { allowed: true });
    expect(await checkRights(w.bus, ctx, ALICES.id, ALICE, 'manage')).toMatchObject({ ok: true });
    expect(await checkRights(w.bus, ctx, ALICES.id, BOB, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'manage')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await managerAccess(w.bus, ctx, ALICES.id, BOB)).toBe('no');
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
    // One question each: who the person is to the agent.
    expect(w.people.inputs('agents:resolve')).toEqual([
      { agentId: ALICES.id, userId: ALICE },
      { agentId: ALICES.id, userId: BOB },
      { agentId: PATS.id, userId: PAT },
      { agentId: ALICES.id, userId: BOB },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ["the string 'true'", 'true'],
    ['1', 1],
    ['null', null],
  ])("a shared agent's owner question answered %s is no owner: view, never manage", async (_what, isOwner) => {
    const { bus, asked } = answering(personalAnswer({ shared: true, ...(isOwner === undefined ? {} : { isOwner }) }));
    expect(await checkRights(bus, ctx, ALICES.id, ALICE, 'view')).toMatchObject({ ok: true });
    expect(await checkRights(bus, ctx, ALICES.id, ALICE, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await managerAccess(bus, ctx, ALICES.id, ALICE)).toBe('no');
    // Not even an answer that would grant it stands in for the owner question.
    expect(asked).toEqual([]);
  });

  it.each([
    ['an empty object', {}],
    ['allowed as a string', { allowed: 'true' }],
    ['allowed as a number', { allowed: 1 }],
    ['null', null],
    ['a bare true', true],
    ['allowed missing beside other keys', { ok: true }],
  ])('refuses manage when the allowed answer is %s: only an explicit true passes', async (_what, answer) => {
    const w = world();
    w.people.answers.set('agents:can-set-shared-credential', answer);
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual({ ok: false, reason: 'forbidden' });
    // Viewing doesn't ask the manage question at all.
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'view')).toMatchObject({ ok: true });
  });

  it('answers not-found for an agent deleted between the two questions', async () => {
    const w = world();
    w.people.faults.set(
      'agents:can-set-shared-credential',
      new PluginError({ code: 'not-found', plugin: '@ax/agents', message: 'gone' }),
    );
    expect(await checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('lets any other failure of either question through', async () => {
    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    for (const hook of ['agents:resolve', 'agents:can-set-shared-credential']) {
      const w = world();
      w.people.faults.set(hook, outage);
      await expect(checkRights(w.bus, ctx, SUPPORT.id, ADA, 'manage'), hook).rejects.toBe(outage);
    }
  });
});

// ── managerAccess ───────────────────────────────────────────────────────────

describe('managerAccess', () => {
  // Whom an agent's own bot (TASK-1167) runs its outsiders as: its requester,
  // and only while they still manage the agent.
  it('managerAccess: yes for a team admin; no for a member, a stranger or a deleted user; agent-gone for a missing agent; not-shared for a Just-me agent; an outage propagates', async () => {
    const w = world();
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, ADA)).toBe('yes');
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, MEL)).toBe('no');
    // A stranger, another team's admin, and an account that no longer exists: agents:resolve refuses each.
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, OTTO)).toBe('no');
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, SAM)).toBe('no');
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, 'usr_deleted')).toBe('no');
    expect(await managerAccess(w.bus, ctx, 'agt_gone', ADA)).toBe('agent-gone');
    expect(await managerAccess(w.bus, ctx, PATS.id, PAT)).toBe('not-shared');
    // Only those who could see a team agent got the admin question, each about themselves.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
      { agentId: SUPPORT.id, actor: { userId: MEL, isAdmin: false } },
    ]);

    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    for (const hook of ['agents:resolve', 'agents:can-set-shared-credential']) {
      const down = world();
      down.people.faults.set(hook, outage);
      await expect(managerAccess(down.bus, ctx, SUPPORT.id, ADA), hook).rejects.toBe(outage);
    }
  });

  it('asks as a non-admin, so a workspace admin who is only a member is no; only an explicit true is yes; a delete between the two questions is agent-gone', async () => {
    const w = world({ workspaceAdminsMayManage: true });
    expect(await managerAccess(w.bus, ctx, SUPPORT.id, WILL)).toBe('no');

    for (const answer of [{}, { allowed: 'true' }, null, true]) {
      const odd = world();
      odd.people.answers.set('agents:can-set-shared-credential', answer);
      expect(await managerAccess(odd.bus, ctx, SUPPORT.id, ADA), JSON.stringify(answer)).toBe('no');
    }

    const gone = world();
    gone.people.faults.set(
      'agents:can-set-shared-credential',
      new PluginError({ code: 'not-found', plugin: '@ax/agents', message: 'gone' }),
    );
    expect(await managerAccess(gone.bus, ctx, SUPPORT.id, ADA)).toBe('agent-gone');
  });

  it('managerAccess is yes for an owner of a shared agent and no for anyone else it is shared with', async () => {
    const w = world();
    expect(await managerAccess(w.bus, ctx, ALICES.id, ALICE)).toBe('yes');
    expect(await managerAccess(w.bus, ctx, ALICES.id, CAROL)).toBe('yes');
    expect(await managerAccess(w.bus, ctx, ALICES.id, BOB)).toBe('no');
    // Shared with a list: someone off it is refused by agents:resolve, so no as well.
    w.people.shareWith(PATS.id, MEL);
    expect(await managerAccess(w.bus, ctx, PATS.id, PAT)).toBe('yes');
    expect(await managerAccess(w.bus, ctx, PATS.id, MEL)).toBe('no');
    expect(await managerAccess(w.bus, ctx, PATS.id, OTTO)).toBe('no');
    // Asked again each time, nothing kept: no longer an owner is no on the very next question,
    expect(await managerAccess(w.bus, ctx, ALICES.id, CAROL)).toBe('yes');
    w.people.agents.set(ALICES.id, { ...ALICES, coOwners: [] });
    expect(await managerAccess(w.bus, ctx, ALICES.id, CAROL)).toBe('no');
    // and back to Just me is not-shared, its creator's included.
    w.people.agents.set(ALICES.id, { ...ALICES, audience: 'just-me' });
    expect(await managerAccess(w.bus, ctx, ALICES.id, ALICE)).toBe('not-shared');
    // A personal agent's owner is never asked the team-admin question.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);

    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/agents', message: 'db down' });
    const down = world();
    down.people.faults.set('agents:resolve', outage);
    await expect(managerAccess(down.bus, ctx, ALICES.id, ALICE)).rejects.toBe(outage);
  });
});
