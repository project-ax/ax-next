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
 * requests (bot-requests.ts) and a bot request's DMs (bot-request-dms.ts)
 * name them from here.
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
 * DMs): only an
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
