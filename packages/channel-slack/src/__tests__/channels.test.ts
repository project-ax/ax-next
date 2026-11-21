import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { describe, expect, it } from 'vitest';
import { agentAccess, checkRights, teamAdminAccess } from '../channels.js';
import { fakeAgents, type FakeAgent } from './fake-agents.js';

/*
  Who may manage a team agent's Slack bot and its channels, and so whose
  account a bot channel's outsiders run as. The rules pinned here: someone
  who can't see the agent learns nothing (a missing agent and a forbidden one
  answer alike); only a team admin of the agent's team manages it, and
  workspace-admin status never counts; a personal agent is refused before
  anything else is asked. What a channel must be for a bot to bind it
  (`connectable`) is pinned with the turn-start check that shares it
  (channel-check.test.ts).
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

const ctx = makeAgentContext({ sessionId: 'test', agentId: '', userId: 'system' });

// ── The world ───────────────────────────────────────────────────────────────

function world(o: { workspaceAdminsMayManage?: boolean } = {}) {
  const bus = new HookBus();
  const people = fakeAgents(bus, o);
  for (const agent of [SUPPORT, SALES, PATS]) people.addAgent(agent);
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

  it("is not-team for a personal agent, its own owner's included", async () => {
    const w = world();
    expect(await agentAccess(w.bus, ctx, PATS.id, PAT)).toBe('not-team');
    expect(await agentAccess(w.bus, ctx, PATS.id, ADA)).toBe('no');
  });

  it('is not-team for an answer it cannot vouch for: another agent, or no readable visibility', async () => {
    const team = { id: SUPPORT.id, ownerId: SUPPORT_TEAM, ownerType: 'team', visibility: 'team', displayName: 'Support' };
    const answers: unknown[] = [
      { agent: { ...team, id: SALES.id } },
      { agent: { ...team, visibility: 'TEAM' } },
      { agent: { ...team, visibility: undefined } },
      { agent: null },
      {},
      null,
    ];
    for (const answer of answers) {
      const bus = new HookBus();
      bus.registerService('agents:resolve', '@ax/agents', async () => answer);
      expect(await agentAccess(bus, ctx, SUPPORT.id, MEL), JSON.stringify(answer)).toBe('not-team');
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

  it("refuses a personal agent as personal-agent to its owner and not-found to anyone else, asking nothing more", async () => {
    const w = world();
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'view')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, PAT, 'manage')).toEqual({ ok: false, reason: 'personal-agent' });
    expect(await checkRights(w.bus, ctx, PATS.id, ADA, 'manage')).toEqual({ ok: false, reason: 'not-found' });
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([]);
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

// ── teamAdminAccess ─────────────────────────────────────────────────────────

describe('teamAdminAccess', () => {
  // Whom a team agent's own bot (TASK-1167) runs its outsiders as: its
  // requester, and only while they are still a team admin of the agent's team.
  it('teamAdminAccess: yes for a team admin; no for a member, a stranger or a deleted user; agent-gone for a missing agent; not-team for a personal agent; an outage propagates', async () => {
    const w = world();
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, ADA)).toBe('yes');
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, MEL)).toBe('no');
    // A stranger, another team's admin, and an account that no longer exists: agents:resolve refuses each.
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, OTTO)).toBe('no');
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, SAM)).toBe('no');
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, 'usr_deleted')).toBe('no');
    expect(await teamAdminAccess(w.bus, ctx, 'agt_gone', ADA)).toBe('agent-gone');
    expect(await teamAdminAccess(w.bus, ctx, PATS.id, PAT)).toBe('not-team');
    // Only those who could see a team agent got the admin question, each about themselves.
    expect(w.people.inputs('agents:can-set-shared-credential')).toEqual([
      { agentId: SUPPORT.id, actor: { userId: ADA, isAdmin: false } },
      { agentId: SUPPORT.id, actor: { userId: MEL, isAdmin: false } },
    ]);

    const outage = new PluginError({ code: 'unavailable', plugin: '@ax/teams', message: 'db down' });
    for (const hook of ['agents:resolve', 'agents:can-set-shared-credential']) {
      const down = world();
      down.people.faults.set(hook, outage);
      await expect(teamAdminAccess(down.bus, ctx, SUPPORT.id, ADA), hook).rejects.toBe(outage);
    }
  });

  it('asks as a non-admin, so a workspace admin who is only a member is no; only an explicit true is yes; a delete between the two questions is agent-gone', async () => {
    const w = world({ workspaceAdminsMayManage: true });
    expect(await teamAdminAccess(w.bus, ctx, SUPPORT.id, WILL)).toBe('no');

    for (const answer of [{}, { allowed: 'true' }, null, true]) {
      const odd = world();
      odd.people.answers.set('agents:can-set-shared-credential', answer);
      expect(await teamAdminAccess(odd.bus, ctx, SUPPORT.id, ADA), JSON.stringify(answer)).toBe('no');
    }

    const gone = world();
    gone.people.faults.set(
      'agents:can-set-shared-credential',
      new PluginError({ code: 'not-found', plugin: '@ax/agents', message: 'gone' }),
    );
    expect(await teamAdminAccess(gone.bus, ctx, SUPPORT.id, ADA)).toBe('agent-gone');
  });
});
