import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import { cleanLabel } from './label.js';
import { isRecord } from './slack-apps.js';
import type { BotRequest } from './store.js';

/**
 * A team agent, and its team's name, as one person sees them (TASK-1169,
 * TASK-1203): the agent as `agents:resolve` answers that person, and its
 * team by name as `teams:list-for-user` (optional: @ax/teams) lists that
 * person's own teams. Each name is cleaned to one line (label.ts) and read
 * when shown, never stored (invariant 4): Admin › Slack's list of bot
 * requests (bot-requests.ts), a bot request's DMs (bot-request-dms.ts), and
 * a team bot's memory notice (memory-notice.ts) name them from here.
 *
 * Every name here is from outside (a person typed it): cleaned, never
 * escaped, so a caller that shows one in Slack passes it through copy.ts
 * `shown`. None is ever logged. A lookup that fails reads as no name, and
 * hands its fault to the caller's `onFault`, which logs it its own way.
 */

/**
 * The agent as one requester sees it: its name, cleaned to one line, or null
 * when it can't be named. `teamId` is only ever used to find its team's name.
 */
export interface SeenAgent {
  name: string | null;
  teamId: string | null;
}

/**
 * The agent as its requester sees it (Admin › Slack's list, a bot request's
 * DMs, and a team bot's memory notice through `agentTeamName`): only an
 * answer about this agent, as a team agent, names it. One they can't see
 * (they left the team) or one that's gone has no name, quietly; nor does one
 * whose name has nothing printable, or any other fault, which is handed to
 * `onFault` first (each caller logs it its own way).
 */
export async function agentSeenBy(
  bus: HookBus,
  ctx: AgentContext,
  r: Pick<BotRequest, 'agentId' | 'requestedByUserId'>,
  onFault: (err: unknown) => void,
): Promise<SeenAgent> {
  const unnamed: SeenAgent = { name: null, teamId: null };
  let out: unknown;
  try {
    out = await bus.call<{ agentId: string; userId: string }, unknown>('agents:resolve', ctx, {
      agentId: r.agentId,
      userId: r.requestedByUserId,
    });
  } catch (err) {
    const code = err instanceof PluginError ? err.code : undefined;
    if (code !== 'forbidden' && code !== 'not-found') onFault(err);
    return unnamed;
  }
  const agent = isRecord(out) ? out['agent'] : undefined;
  if (!isRecord(agent) || agent['id'] !== r.agentId || agent['visibility'] !== 'team') return unnamed;
  const name = agent['displayName'];
  const owner = agent['ownerId'];
  return {
    name: (typeof name === 'string' ? cleanLabel(name) : '') || null,
    // A team agent's owner is its team (@ax/agents): only ever matched against the requester's teams.
    teamId: typeof owner === 'string' && owner !== '' ? owner : null,
  };
}

/**
 * The names of the teams `userId` is on, by team id, cleaned; an empty map
 * when the answer can't be read. A fault reads as no names, handed to
 * `onFault`. The caller checks that `teams:list-for-user` is there first.
 */
export async function teamNamesOf(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  onFault: (err: unknown) => void,
): Promise<ReadonlyMap<string, string>> {
  const names = new Map<string, string>();
  let out: unknown;
  try {
    out = await bus.call<{ userId: string }, unknown>('teams:list-for-user', ctx, { userId });
  } catch (err) {
    onFault(err);
    return names;
  }
  const teams = isRecord(out) ? out['teams'] : undefined;
  if (!Array.isArray(teams)) return names;
  for (const team of teams) {
    if (!isRecord(team)) continue;
    const id = team['id'];
    const name = team['displayName'];
    if (typeof id !== 'string' || typeof name !== 'string' || names.has(id)) continue;
    const label = cleanLabel(name);
    if (label !== '') names.set(id, label);
  }
  return names;
}

/**
 * The name of `agentId`'s team as `userId` sees it, cleaned to one line, or
 * null (TASK-1203: what a team bot's memory notice names). `userId` is
 * someone on the team, so their own team list names it: the person a
 * channel turn runs as (a member, or the bot's requester, checked a team
 * admin for an outsider's turn). Null without @ax/teams, and then nothing
 * is asked at all; null too for a personal agent or one they can't see, a
 * team their list doesn't name, or a name with nothing printable. A lookup
 * that fails is null, its fault handed to `onFault`; forbidden and
 * not-found are quiet. Never throws.
 */
export async function agentTeamName(
  bus: HookBus,
  ctx: AgentContext,
  i: { agentId: string; userId: string },
  onFault: (err: unknown) => void,
): Promise<string | null> {
  try {
    if (!bus.hasService('teams:list-for-user')) return null;
    const agent = await agentSeenBy(bus, ctx, { agentId: i.agentId, requestedByUserId: i.userId }, onFault);
    if (agent.teamId === null) return null;
    return (await teamNamesOf(bus, ctx, i.userId, onFault)).get(agent.teamId) ?? null;
  } catch {
    // Only an `onFault` that threw gets here (both lookups catch their own
    // faults): it was told already, and nothing is left to tell. No name.
    return null;
  }
}
