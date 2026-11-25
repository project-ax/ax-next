import { PluginError, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import { checkAccess, isAgentOwner, isAxAccount } from '../acl.js';
import type { AgentStore } from '../store.js';
import type { Actor, Agent, AgentAudience, PersonView, SharingView } from '../types.js';
import type { SharingStore } from './store.js';

// ---------------------------------------------------------------------------
// TASK-1246 — a personal agent's sharing settings: who can use it (its
// audience) and who its owners are. Read by an owner's GET /admin/agents/:id,
// written by PUT /admin/agents/:id/audience and PUT /admin/agents/:id/owners
// (admin-routes.ts). Plain functions, not service hooks: the settings page is
// their only caller.
//
// Order inside a write. Each step answers before the next one runs, so a
// caller who isn't an owner learns nothing about the body they sent:
//   1. the agent exists, else 404 `not-found`;
//   2. a team agent has no sharing settings in phase 1: 403 `team-agent` for
//      a member of its team, 403 `forbidden` for anyone else;
//   3. a personal agent: the caller is one of its owners, else 403
//      `forbidden`. A workspace admin gets no override (design §7);
//   4. the body's shape, strict: else 400 `invalid-audience` / `invalid-owners`;
//   5. nobody named twice, else 400 `duplicate-person`;
//   6. owners only: the creator stays an owner, else 400 `creator-required`.
//      Phase 1 never lets anyone remove the creator, so an agent can't lose
//      its last owner and `ownerId` always names an owner;
//   7. every person named except the creator is an AX account (`isAxAccount`,
//      the rule `everyone` uses), else 400 `unknown-person` with the id. No
//      `auth:get-user` → 503 `accounts-unavailable`; any other throw
//      propagates (500), so an outage never reads as "unknown";
//   8. the write. A delete that won the race → 404;
//   9. one log line, counts only: never a name or an email;
//  10. 200 with the settings as they now read.
// ---------------------------------------------------------------------------

const PLUGIN_NAME = '@ax/agents';
const AUTH_GET_USER_HOOK = 'auth:get-user';

/** The most people one `list` audience names. "Everyone" covers more. */
export const AUDIENCE_MEMBERS_MAX = 50;
/** The most owners one agent has, its creator included. */
export const OWNERS_MAX = 10;

export type SharingWriteResult =
  | { status: 200; sharing: SharingView }
  | { status: 400 | 403 | 404 | 503; error: string; id?: string };

export interface SharingService {
  /**
   * The settings as an owner sees them, every person named. A failed name
   * lookup reads as nulls and never fails the read. For a personal agent only:
   * one without a valid audience throws `corrupt-row`.
   */
  view(ctx: AgentContext, agent: Agent): Promise<SharingView>;
  /** Replace who can use the agent. `body` is the parsed, unchecked JSON. */
  setAudience(
    ctx: AgentContext,
    actor: Actor,
    agentId: string,
    body: unknown,
  ): Promise<SharingWriteResult>;
  /** Make the agent's owners exactly `body.userIds` (the creator among them). */
  setOwners(
    ctx: AgentContext,
    actor: Actor,
    agentId: string,
    body: unknown,
  ): Promise<SharingWriteResult>;
}

export interface SharingServiceDeps {
  bus: HookBus;
  agents: Pick<AgentStore, 'getById'>;
  sharing: SharingStore;
}

const personIdSchema = z.string().min(1).max(128);

/** `members` holds people only in phase 1; phase 2 adds `{ type: 'group'; id }`. */
const audienceBodySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('just-me') }).strict(),
  z.object({ kind: z.literal('everyone') }).strict(),
  z
    .object({
      kind: z.literal('list'),
      members: z
        .array(z.object({ type: z.literal('user'), id: personIdSchema }).strict())
        .min(1)
        .max(AUDIENCE_MEMBERS_MAX),
    })
    .strict(),
]);

const ownersBodySchema = z
  .object({ userIds: z.array(personIdSchema).min(1).max(OWNERS_MAX) })
  .strict();

function refuse(
  status: 400 | 403 | 404 | 503,
  error: string,
  id?: string,
): SharingWriteResult {
  return id === undefined ? { status, error } : { status, error, id };
}

function hasDuplicate(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

/** The person `auth:get-user` answered for `id`, or nulls for anything else. */
function personFrom(id: string, answer: unknown): PersonView {
  if (typeof answer !== 'object' || answer === null || (answer as { id?: unknown }).id !== id) {
    return { id, displayName: null, email: null };
  }
  const { displayName, email } = answer as { displayName?: unknown; email?: unknown };
  return {
    id,
    displayName: typeof displayName === 'string' ? displayName : null,
    email: typeof email === 'string' ? email : null,
  };
}

export function createSharingService(deps: SharingServiceDeps): SharingService {
  const { bus } = deps;
  const callerFacts = deps.sharing.callerFacts;

  /** Steps 1–3: the agent, when `actor` is one of its owners. */
  async function admit(
    ctx: AgentContext,
    actor: Actor,
    agentId: string,
  ): Promise<{ ok: true; agent: Agent } | { ok: false; result: SharingWriteResult }> {
    const agent = await deps.agents.getById(agentId);
    if (agent === null) return { ok: false, result: refuse(404, 'not-found') };
    if (agent.visibility === 'team') {
      // Its members learn why; anyone else learns no more than "forbidden".
      const acl = await checkAccess(agent, actor.userId, bus, ctx, { callerFacts });
      return { ok: false, result: refuse(403, acl.allowed ? 'team-agent' : 'forbidden') };
    }
    // `actor.isAdmin` is deliberately never read: only owners share.
    if (!(await isAgentOwner(agent, actor.userId, callerFacts))) {
      return { ok: false, result: refuse(403, 'forbidden') };
    }
    return { ok: true, agent };
  }

  /** Step 7: null when every id is an AX account, else the refusal. */
  async function refuseUnknownPeople(
    ctx: AgentContext,
    ids: readonly string[],
  ): Promise<SharingWriteResult | null> {
    if (ids.length === 0) return null;
    if (!bus.hasService(AUTH_GET_USER_HOOK)) return refuse(503, 'accounts-unavailable');
    for (const id of ids) {
      if (!(await isAxAccount(bus, ctx, id))) return refuse(400, 'unknown-person', id);
    }
    return null;
  }

  /** Step 8: the store write, with the not-found of a raced delete as a 404. */
  async function write(run: () => Promise<void>): Promise<SharingWriteResult | null> {
    try {
      await run();
      return null;
    } catch (err) {
      if (err instanceof PluginError && err.code === 'not-found') return refuse(404, 'not-found');
      throw err;
    }
  }

  /** Step 10: the settings as they read now. */
  async function answer(ctx: AgentContext, agentId: string): Promise<SharingWriteResult> {
    const agent = await deps.agents.getById(agentId);
    if (agent === null) return refuse(404, 'not-found');
    return { status: 200, sharing: await view(ctx, agent) };
  }

  /**
   * `auth:get-user` for each id, in parallel, as a person. A null answer, a
   * missing hook or a throw reads as null names: one warn line per read, by
   * error name and code only (a message can carry an id or an address).
   */
  async function lookUpPeople(
    ctx: AgentContext,
    agentId: string,
    ids: readonly string[],
  ): Promise<Map<string, PersonView>> {
    const errors: string[] = [];
    const people = await Promise.all(
      [...new Set(ids)].map(async (id): Promise<PersonView> => {
        try {
          return personFrom(id, await bus.call<{ userId: string }, unknown>(AUTH_GET_USER_HOOK, ctx, { userId: id }));
        } catch (err) {
          errors.push(
            err instanceof PluginError
              ? `${err.name}:${err.code}`
              : err instanceof Error
                ? err.name
                : typeof err,
          );
          return { id, displayName: null, email: null };
        }
      }),
    );
    if (errors.length > 0) {
      ctx.logger.warn('agents_sharing_names_unavailable', {
        agentId,
        failed: errors.length,
        errors: [...new Set(errors)],
      });
    }
    return new Map(people.map((p) => [p.id, p]));
  }

  async function view(ctx: AgentContext, agent: Agent): Promise<SharingView> {
    const kind = agent.audience;
    if (agent.visibility !== 'personal' || (kind !== 'just-me' && kind !== 'everyone' && kind !== 'list')) {
      // Fail closed, like the store's read of an unknown audience.
      throw new PluginError({
        code: 'corrupt-row',
        plugin: PLUGIN_NAME,
        message: `agent '${agent.id}' has no audience its owners can set`,
      });
    }
    const [ownerIds, members] = await Promise.all([
      deps.sharing.listOwners(agent.id),
      kind === 'list' ? deps.sharing.listMembers(agent.id) : Promise.resolve([]),
    ]);
    const people = await lookUpPeople(ctx, agent.id, [...ownerIds, ...members.map((m) => m.id)]);
    const person = (id: string): PersonView => people.get(id) ?? { id, displayName: null, email: null };
    // The creator leads whatever order the rows come back in.
    const creatorFirst = [
      ...ownerIds.filter((id) => id === agent.ownerId),
      ...ownerIds.filter((id) => id !== agent.ownerId),
    ];
    return {
      audience:
        kind === 'list'
          ? { kind, members: members.map((m) => ({ type: 'user' as const, ...person(m.id) })) }
          : { kind },
      owners: creatorFirst.map((id) => ({ ...person(id), creator: id === agent.ownerId })),
    };
  }

  return {
    view,

    async setAudience(ctx, actor, agentId, body) {
      const gate = await admit(ctx, actor, agentId);
      if (!gate.ok) return gate.result;
      const parsed = audienceBodySchema.safeParse(body);
      if (!parsed.success) return refuse(400, 'invalid-audience');
      const audience: AgentAudience = parsed.data;
      const named = audience.kind === 'list' ? audience.members.map((m) => m.id) : [];
      if (hasDuplicate(named)) return refuse(400, 'duplicate-person');
      const unknown = await refuseUnknownPeople(
        ctx,
        named.filter((id) => id !== gate.agent.ownerId),
      );
      if (unknown !== null) return unknown;
      const raced = await write(() => deps.sharing.setAudience(agentId, audience));
      if (raced !== null) return raced;
      ctx.logger.info('agents_sharing_audience_set', {
        agentId,
        kind: audience.kind,
        members: named.length,
        by: actor.userId,
      });
      return answer(ctx, agentId);
    },

    async setOwners(ctx, actor, agentId, body) {
      const gate = await admit(ctx, actor, agentId);
      if (!gate.ok) return gate.result;
      const parsed = ownersBodySchema.safeParse(body);
      if (!parsed.success) return refuse(400, 'invalid-owners');
      const { userIds } = parsed.data;
      if (hasDuplicate(userIds)) return refuse(400, 'duplicate-person');
      const creator = gate.agent.ownerId;
      if (!userIds.includes(creator)) return refuse(400, 'creator-required');
      const unknown = await refuseUnknownPeople(
        ctx,
        userIds.filter((id) => id !== creator),
      );
      if (unknown !== null) return unknown;
      const raced = await write(() => deps.sharing.setOwners(agentId, userIds));
      if (raced !== null) return raced;
      ctx.logger.info('agents_sharing_owners_set', {
        agentId,
        owners: userIds.length,
        by: actor.userId,
      });
      return answer(ctx, agentId);
    },
  };
}
