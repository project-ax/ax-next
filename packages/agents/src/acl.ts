import { isOwnerlessId, PluginError, type AgentContext, type HookBus } from '@ax/core';
import type { Agent, CallerFacts } from './types.js';

/**
 * The one "can `userId` use `agent`?" rule. `agents:resolve` and the identity
 * hooks run it; the admin endpoints DO NOT re-implement it, they call the hooks
 * that call it. `agents:list-for-user` mirrors it in SQL (`scope.ts`
 * `reachableAgents`, with the same account check), so a list never shows an
 * agent resolve would refuse, or hides one it would allow.
 *
 * A personal agent (TASK-1246):
 *   1. `ownerType !== 'user'`, or `userId` not a non-empty string → forbidden.
 *   2. An owner row for `userId` → allowed, `owner: true`. The creator is NOT
 *      special-cased: the owners table is the one source of truth, and the
 *      creator is in it (written at create, backfilled for older agents).
 *   3. Otherwise the audience decides, each allow with `owner: false`:
 *        `just-me`  → forbidden;
 *        `list`     → allowed iff a `user` member row names `userId`;
 *        `everyone` → allowed iff `userId` is an AX account (`isAxAccount`);
 *        any other value → forbidden (fail closed).
 *      A member row only counts under `list`: one that outlived its list
 *      grants nothing.
 *
 * A team agent: allowed (`owner: false`) iff `teams:is-member` says the user
 * is a member of the owning team (`agent.ownerId`); anything else → forbidden.
 * The sharing rows are never read for it.
 *
 * Two lookups go over the bus, and neither is a hard manifest dep, because
 * @ax/core's bootstrap `verifyCalls` enforces hard presence:
 *   - `teams:is-member` is not declared at all: declaring it would make
 *     @ax/teams a hard dep and break personal-only deployments.
 *   - `auth:get-user` is an `optionalCalls` entry (many harnesses boot this
 *     plugin without auth).
 * Each is called inside a try/catch:
 *   - hook present → its answer decides;
 *   - hook missing (`no-service`) → forbidden + warn-once for ops visibility;
 *   - any other throw → propagates, so an outage never masquerades as a
 *     routine authz denial.
 *
 * The warn-once is path-of-least-surprise: an operator who configured team
 * agents without loading @ax/teams (or shared an agent with everyone without
 * an auth plugin) gets ONE log line per process lifetime, not one per call.
 */
export type AclResult =
  | { allowed: true; owner: boolean }
  | { allowed: false; reason: 'forbidden' };

export interface AclDeps {
  /**
   * The sharing rows' facts about one person and one agent: an owner row, a
   * `user` member row (`SharingStore.callerFacts`). Read only for a personal
   * agent and a non-empty user id.
   */
  callerFacts: (agentId: string, userId: string) => Promise<CallerFacts>;
  /**
   * Test seam for the team check's warn-once. When undefined, defaults to a
   * process-wide flag so we warn at most once. Tests pass a fresh
   * `{ warned: false }` per case to assert log discipline.
   */
  warnState?: { warned: boolean };
  /** The same seam for the account check's warn-once (`isAxAccount`). */
  accountWarnState?: { warned: boolean };
}

const PLUGIN_NAME = '@ax/agents';
const AUTH_GET_USER_HOOK = 'auth:get-user';

const FORBIDDEN: AclResult = { allowed: false, reason: 'forbidden' };

interface IsMemberInput {
  teamId: string;
  userId: string;
}
interface IsMemberOutput {
  member: boolean;
}

const globalWarnState = { warned: false };
const globalAccountWarnState = { warned: false };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function checkAccess(
  agent: Agent,
  userId: string,
  bus: HookBus,
  ctx: AgentContext,
  deps: AclDeps,
): Promise<AclResult> {
  if (agent.visibility === 'personal') {
    return checkPersonalAccess(agent, userId, bus, ctx, deps);
  }

  // Team — defensive parity check. The DB CHECK constraint
  // (owner_type='team' AND visibility='team') should make this
  // impossible, but if the row was inserted bypassing the constraint
  // (e.g. raw SQL), refuse rather than fall through.
  if (agent.ownerType !== 'team') {
    return FORBIDDEN;
  }

  const warnState = deps.warnState ?? globalWarnState;
  let result: IsMemberOutput;
  try {
    result = await bus.call<IsMemberInput, IsMemberOutput>(
      'teams:is-member',
      ctx,
      { teamId: agent.ownerId, userId },
    );
  } catch (err) {
    // Only "no plugin loaded" (PluginError code 'no-service') degrades to
    // deny — anything else (handler threw, transient DB outage, validation
    // failed) propagates so a real outage doesn't masquerade as a routine
    // authz denial.
    if (!(err instanceof PluginError) || err.code !== 'no-service') {
      throw err;
    }
    if (!warnState.warned) {
      warnState.warned = true;
      ctx.logger.warn('agents_acl_team_check_unavailable', {
        plugin: PLUGIN_NAME,
        hook: 'teams:is-member',
        agentId: agent.id,
        reason: err.message,
      });
    }
    return FORBIDDEN;
  }

  // A team agent has no owners in phase 1: its members only use it.
  return result.member ? { allowed: true, owner: false } : FORBIDDEN;
}

/** Rules 1–3 of the header, for an agent whose visibility is `personal`. */
async function checkPersonalAccess(
  agent: Agent,
  userId: string,
  bus: HookBus,
  ctx: AgentContext,
  deps: AclDeps,
): Promise<AclResult> {
  // Rule 1. The pairing CHECK makes a non-user owner impossible; deny it if a
  // raw write ever made one. An empty id is nobody, whatever a row says.
  if (agent.ownerType !== 'user' || !isNonEmptyString(userId)) return FORBIDDEN;

  // Rule 2. One query answers both facts; only a real `true` counts.
  const facts = await deps.callerFacts(agent.id, userId);
  if (facts.owner === true) return { allowed: true, owner: true };

  // Rule 3. Unknown values (a corrupt row read past the store's guard, a
  // future audience this build doesn't know) fall to `default`.
  switch (agent.audience) {
    case 'just-me':
      return FORBIDDEN;
    case 'list':
      return facts.listed === true ? { allowed: true, owner: false } : FORBIDDEN;
    case 'everyone': {
      const accountDeps = deps.accountWarnState !== undefined ? { warnState: deps.accountWarnState } : {};
      return (await isAxAccount(bus, ctx, userId, accountDeps))
        ? { allowed: true, owner: false }
        : FORBIDDEN;
    }
    default:
      return FORBIDDEN;
  }
}

/**
 * Is `userId` an AX account, the people an `everyone` audience admits?
 *
 *   - `''` or an owner-less stand-in (`isOwnerlessId`) → false, with no call:
 *     neither is anybody, so neither may ever pool into "everyone".
 *   - No `auth:get-user` registered → false, warned once as
 *     `agents_acl_account_check_unavailable`.
 *   - Any other throw propagates, so an outage is not a quiet deny. That
 *     includes a `no-service` from a hook `auth:get-user` itself calls: auth is
 *     loaded but broken.
 *   - Otherwise true iff the answer is an object whose `id` is `userId`. A
 *     null answer (an id auth doesn't know, such as `'system'`) is false.
 */
export async function isAxAccount(
  bus: HookBus,
  ctx: AgentContext,
  userId: string,
  deps: { warnState?: { warned: boolean } } = {},
): Promise<boolean> {
  if (!isNonEmptyString(userId) || isOwnerlessId(userId)) return false;
  let answer: unknown;
  try {
    answer = await bus.call<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, ctx, { userId });
  } catch (err) {
    if (
      !(err instanceof PluginError) ||
      err.code !== 'no-service' ||
      err.hookName !== AUTH_GET_USER_HOOK
    ) {
      throw err;
    }
    const warnState = deps.warnState ?? globalAccountWarnState;
    if (!warnState.warned) {
      warnState.warned = true;
      ctx.logger.warn('agents_acl_account_check_unavailable', {
        plugin: PLUGIN_NAME,
        hook: AUTH_GET_USER_HOOK,
        reason: err.message,
      });
    }
    return false;
  }
  return (
    typeof answer === 'object' &&
    answer !== null &&
    (answer as { id?: unknown }).id === userId
  );
}

/**
 * Is `userId` one of `agent`'s owners? True only for a personal agent with an
 * owner row for a non-empty `userId`; always false on a team agent (it has no
 * owners in phase 1), whatever the rows say. The owner half of
 * {@link checkAccess}, for the writes only owners may make.
 */
export async function isAgentOwner(
  agent: Agent,
  userId: string,
  callerFacts: AclDeps['callerFacts'],
): Promise<boolean> {
  if (agent.visibility !== 'personal' || agent.ownerType !== 'user') return false;
  if (!isNonEmptyString(userId)) return false;
  return (await callerFacts(agent.id, userId)).owner === true;
}
