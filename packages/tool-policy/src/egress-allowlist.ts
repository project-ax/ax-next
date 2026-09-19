/**
 * The egress allowlist — hosts a `web_extract`-style call may be pointed at
 * without stopping to ask (TASK-330).
 *
 * WHAT THIS IS NOT. It is not the sandbox's egress allowlist. That one lives in
 * `@ax/host-grants` and is unioned into the MITM proxy by the chat
 * orchestrator, so an entry there lets the agent open a raw connection to the
 * host. An entry HERE only stops a page read being held for approval. Keeping
 * them apart is the point: approving "read this page" must not quietly hand out
 * "open sockets to this host", which is what reusing that table would have
 * meant.
 *
 * It is also not `@ax/credential-proxy`'s `allowedHosts`. Those are declared by
 * a SKILL, for the hosts that skill needs. `web_extract` is a built-in tool and
 * belongs to no skill, so there was nothing there to reuse.
 */
import type { Kysely } from 'kysely';
import type { EgressAllowlistRow, ToolPolicyDatabase } from './migrations.js';
import type { EgressAllowlistEntry, EgressAllowlistSite, EgressScope } from './types.js';

/**
 * Exact-match allowlist hostnames only: no wildcards, no ports, no schemes, no
 * uppercase, no trailing dot. Re-implemented here rather than imported from
 * `@ax/host-grants` or `@ax/credential-proxy` — invariant 2, and the stated
 * convention at every other trust boundary in this repo, which is that each one
 * validates independently rather than inheriting somebody else's idea of a
 * hostname.
 */
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * A user id we are willing to own an entry. Same shape `@ax/credentials` uses
 * for a credential owner, re-declared locally for the same reason `HOST_RE` is.
 *
 * It matters here beyond hygiene: `''` is the GLOBAL sentinel in the table, so
 * a write that accepted an empty owner would file a personal entry as an
 * operator-curated one that applies to everybody.
 */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

/**
 * Ids that pass the shape check but do not name a person.
 *
 * `'system'` is this repo's sentinel for an init / canary / admin-probe context
 * — `makeAgentContext({ userId: 'system' })` appears in almost every plugin's
 * `init`. It is a well-formed id, so nothing above would stop an entry being
 * filed under it, and an entry owned by "not a person" is exactly the kind of
 * row a later reader mistakes for one that applies to everybody. Reserved here
 * as well as at the calling tool, deliberately: each trust boundary validates
 * independently, and this is the one that writes.
 */
const RESERVED_OWNER_IDS = new Set(['system']);

/**
 * A host we are willing to store, or `null`.
 *
 * TOTAL — every caller is on a path that must not throw over a malformed host
 * (the pre-call gate, or a tool call that has already succeeded), and every
 * `null` means "do not remember this", which costs an approval and grants
 * nothing.
 *
 * Lowercasing is the ONLY normalisation. In particular a trailing dot is
 * rejected rather than stripped: `example.com.` and `example.com` are the same
 * host to DNS, but treating them as the same here would be a second matching
 * rule to keep in step with `evaluate`'s exact comparison, and getting it wrong
 * fails OPEN. Rejecting costs one extra approval and cannot grant anything.
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

/** Whether a string is a user id this store will file an entry under. */
export function isOwnerId(raw: unknown): raw is string {
  return typeof raw === 'string' && USER_ID_RE.test(raw) && !RESERVED_OWNER_IDS.has(raw);
}

/**
 * At most this many remembered hosts per person. A cap and not a quota: the
 * list is read on every gated call, and an unbounded one is a slow read that
 * gets slower every time the agent visits a new site. Global entries are an
 * operator's deliberate list and are not capped by this.
 */
export const MAX_USER_HOSTS = 512;

export interface EgressAllowlistStore {
  /**
   * Every host this person may reach silently — the operator's global entries
   * UNIONED with their own. Never another person's.
   */
  allowedFor(userId: string): Promise<Set<string>>;
  /**
   * Record one entry. Returns false when the host or owner is malformed, or
   * when the person is already at the cap. Idempotent: re-remembering a host
   * already present is a no-op that returns false.
   */
  remember(entry: EgressAllowlistEntry): Promise<boolean>;
  /**
   * Every entry this person can SEE — the operator's global entries unioned
   * with their own, never another person's. Same answer `allowedFor` gives,
   * carrying the two facts a reader needs that a bare host does not: which list
   * it is on, and when it got there.
   *
   * ONE ROW PER HOST, and a host on both lists reports as `global`. See
   * `dedupeByHost` for why that is the honest answer and not a tidy-up.
   *
   * Sorted by host ascending, so the order is a property of the data rather
   * than of whatever the storage handed back.
   */
  listFor(userId: string): Promise<EgressAllowlistSite[]>;
  /**
   * Forget one host this person remembered.
   *
   * `scope: 'user'` IS HARD-CODED HERE, not taken as a parameter, and that is
   * the security decision rather than a simplification. A scope argument would
   * mean every caller — present and future — is one typo away from deleting an
   * operator's global entry, which is the deployment-wide list. Nothing above
   * this function can express that request, so nothing has to be trusted not to
   * make it.
   *
   * Returns false when the host is malformed, when the owner is not a person,
   * or when no row matched. The three are indistinguishable on purpose: the
   * caller is not entitled to learn that a host it cannot delete exists.
   */
  revoke(params: { ownerId: string; host: string }): Promise<boolean>;
}

/**
 * Sort by host, the one order that does not depend on the backend.
 *
 * `created_at DESC` was the obvious alternative and is worse: the memory store
 * stamps everything inside one process tick, so its "newest first" is really
 * insertion order, and the two stores would disagree about a list the tests
 * compare. Alphabetical is also what a reader scanning for a site wants.
 */
function byHost(a: EgressAllowlistSite, b: EgressAllowlistSite): number {
  return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
}

/**
 * One row per host, and a host on BOTH lists reports as `global`.
 *
 * THIS IS ROUTINE, not a corner case. `web_extract`'s executor calls
 * `egress-allowlist:remember` after every successful fetch — including one that
 * never prompted anybody because an operator's global entry already allowed it
 * — and `remember`'s existence check keys on `(scope, owner, host)`, so the
 * global row does not match and a personal row is written beside it. Any
 * deployment that sets `globalEgressHosts` accumulates these from the first
 * read onwards.
 *
 * Two rows for one host is not merely untidy. The panel keys its rows on the
 * host, so it collides; and the personal duplicate renders a revoke control
 * that deletes a row which was not the reason the site is silent. The person
 * is told "we'll ask about that one next time" and then we do not ask, which
 * is a false statement in the one surface whose whole job is to tell them what
 * they have agreed to.
 *
 * `global` WINS, deliberately. The question this list answers is "can this be
 * read without asking me, and can I stop that?" — and while a global entry
 * stands, the answer is yes and no, whatever else also happens to be stored.
 * Preferring `user` would keep exactly the lie above. The personal row is not
 * lost: it stays in the table, `revoke` still finds it by host, and if the
 * operator ever drops the global entry the host reappears here as `user` with
 * its control back — correct at every point in time rather than only now.
 */
function dedupeByHost(sites: EgressAllowlistSite[]): EgressAllowlistSite[] {
  const best = new Map<string, EgressAllowlistSite>();
  for (const site of sites) {
    const seen = best.get(site.host);
    if (seen === undefined || (seen.scope !== 'global' && site.scope === 'global')) {
      best.set(site.host, site);
    }
  }
  return [...best.values()].sort(byHost);
}

function ownerKey(entry: EgressAllowlistEntry): string | null {
  // The one place the `null` ↔ `''` conversion happens. See migrations.ts.
  if (entry.scope === 'global') return entry.ownerId === null ? '' : null;
  return isOwnerId(entry.ownerId) ? entry.ownerId : null;
}

/** The shape both stores share, so neither can drift on validation. */
function validate(entry: EgressAllowlistEntry): { owner: string; host: string } | null {
  const owner = ownerKey(entry);
  const host = normalizeHost(entry.host);
  if (owner === null || host === null) return null;
  return { owner, host };
}

export function createDbEgressAllowlistStore(
  db: Kysely<ToolPolicyDatabase>,
): EgressAllowlistStore {
  return {
    async allowedFor(userId) {
      // Two exact keys rather than an OR over a scope column with a wildcard:
      // the PK is (scope, owner_user_id, host), so both halves are index reads,
      // and — more importantly — a query that could not name the owner is one
      // that could return somebody else's rows.
      //
      // The personal half is DROPPED ENTIRELY for an id this store would never
      // have written under, rather than queried with a sentinel that cannot
      // match. Same answer, and it is the honest shape: there is no question to
      // ask the database about an identity we do not accept. (The sentinel
      // version was also a literal NUL byte, which Postgres rejects in a text
      // parameter — so the read would have THROWN and been caught as "we do not
      // know what is allowed". Fail-closed, but by accident.)
      const personal = isOwnerId(userId);
      const rows = await db
        .selectFrom('tool_policy_v1_egress_allowlist')
        .select(['host'])
        .where((eb) => {
          const global = eb.and([
            eb('scope', '=', 'global'),
            eb('owner_user_id', '=', ''),
          ]);
          if (!personal) return global;
          return eb.or([
            global,
            eb.and([eb('scope', '=', 'user'), eb('owner_user_id', '=', userId)]),
          ]);
        })
        .execute();
      return new Set(rows.map((r: Pick<EgressAllowlistRow, 'host'>) => r.host));
    },

    async listFor(userId) {
      // THE SAME QUERY SHAPE AS `allowedFor`, deliberately: two exact keys,
      // never an OR with a wildcard, and the personal half DROPPED ENTIRELY
      // when the id is one this store would never have written under. The
      // reasoning is on `allowedFor` above and it applies unchanged here — a
      // read that could not name its owner is a read that can return somebody
      // else's rows, and this one puts them on a screen.
      //
      // Two methods rather than `listFor().map(host)`: `allowedFor` runs on the
      // `tool:pre-call` path under a 10 s ceiling and wants the narrowest
      // possible select. This one is a settings read and can afford the rest.
      const personal = isOwnerId(userId);
      const rows = await db
        .selectFrom('tool_policy_v1_egress_allowlist')
        .select(['host', 'scope', 'created_at'])
        .where((eb) => {
          const global = eb.and([
            eb('scope', '=', 'global'),
            eb('owner_user_id', '=', ''),
          ]);
          if (!personal) return global;
          return eb.or([
            global,
            eb.and([eb('scope', '=', 'user'), eb('owner_user_id', '=', userId)]),
          ]);
        })
        .execute();
      const sites = rows.map(
        (r: Pick<EgressAllowlistRow, 'host' | 'scope' | 'created_at'>): EgressAllowlistSite => ({
          host: r.host,
          // The column is TEXT, so the row's scope is whatever was written.
          // Narrowed rather than asserted: only this store writes the table,
          // and it writes exactly these two — but an unexpected value reaching
          // the bus's `returns` enum would throw the whole read away, and a
          // settings panel that shows nothing because one row is odd is worse
          // than one that shows the row as the personal entry it is.
          scope: r.scope === 'global' ? 'global' : 'user',
          rememberedAt: r.created_at.toISOString(),
        }),
      );
      // Deduped here rather than in SQL: the rule ("global wins") is one both
      // stores have to obey identically, and a `DISTINCT ON` the memory store
      // cannot express is a rule that only one of them enforces.
      return dedupeByHost(sites);
    },

    async revoke({ ownerId, host: rawHost }) {
      // Validated here and not only at the hook: this is the trust boundary
      // that owns the table. `scope` is never a parameter — see the interface.
      const host = normalizeHost(rawHost);
      if (host === null || !isOwnerId(ownerId)) return false;
      const res = await db
        .deleteFrom('tool_policy_v1_egress_allowlist')
        .where('scope', '=', 'user')
        .where('owner_user_id', '=', ownerId)
        .where('host', '=', host)
        .executeTakeFirst();
      // `numDeletedRows` is a bigint, so `res.numDeletedRows > 0` would be a
      // comparison against a number literal — legal, but `?? 0n` then mixes the
      // two types. `Number(... ?? 0n) > 0` is the shape every other store in
      // this repo uses (`@ax/host-grants`, `@ax/agents`), and the canary is
      // what proves the delete actually reached Postgres rather than this
      // returning a cheerful `true` over an untouched table.
      return Number(res.numDeletedRows ?? 0n) > 0;
    },

    async remember(entry) {
      const checked = validate(entry);
      if (checked === null) return false;
      const { owner, host } = checked;

      const existing = await db
        .selectFrom('tool_policy_v1_egress_allowlist')
        .select('host')
        .where('scope', '=', entry.scope)
        .where('owner_user_id', '=', owner)
        .where('host', '=', host)
        .executeTakeFirst();
      if (existing !== undefined) return false;

      if (entry.scope === 'user') {
        const { count } = await db
          .selectFrom('tool_policy_v1_egress_allowlist')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('scope', '=', 'user')
          .where('owner_user_id', '=', owner)
          .executeTakeFirstOrThrow();
        if (Number(count) >= MAX_USER_HOSTS) return false;
      }

      // Accepted race, same posture as @ax/host-grants: two concurrent
      // remembers of one host surface as a PK violation. The caller treats a
      // throw as "not remembered", which costs an approval and grants nothing.
      await db
        .insertInto('tool_policy_v1_egress_allowlist')
        .values({
          scope: entry.scope,
          owner_user_id: owner,
          host,
          created_at: new Date(),
        })
        .execute();
      return true;
    },
  };
}

/**
 * The store a deployment with no database gets.
 *
 * Not a stub: it is what makes the plugin loadable where `database:get-instance`
 * is absent, and it is honest about the consequence — operator-seeded global
 * hosts still apply, remembered ones do not outlive the process, so after a
 * restart the host is held again. That is the safe direction, which is why the
 * degradation is acceptable rather than a boot failure.
 */
export function createMemoryEgressAllowlistStore(): EgressAllowlistStore {
  // host -> when it was remembered. It was a bare `Set` until `listFor` needed
  // to say WHEN, and the map is the smallest thing that answers that without a
  // second structure to keep in step with the first.
  const byOwner = new Map<string, Map<string, Date>>();
  const key = (scope: EgressScope, owner: string): string => `${scope}:${owner}`;
  return {
    async allowedFor(userId) {
      const out = new Set<string>((byOwner.get(key('global', '')) ?? new Map()).keys());
      if (isOwnerId(userId)) {
        for (const h of (byOwner.get(key('user', userId)) ?? new Map<string, Date>()).keys()) {
          out.add(h);
        }
      }
      return out;
    },
    async listFor(userId) {
      // Same union, same drop of the personal half for an id this store would
      // never have written under — see the db store, which carries the why.
      const sites: EgressAllowlistSite[] = [];
      const push = (scope: EgressScope, owner: string): void => {
        for (const [host, at] of byOwner.get(key(scope, owner)) ?? []) {
          sites.push({ host, scope, rememberedAt: at.toISOString() });
        }
      };
      push('global', '');
      if (isOwnerId(userId)) push('user', userId);
      // Same "global wins, one row per host" rule as the db store, through the
      // same function — a duplicate a person can see must not depend on which
      // backend this deployment happens to have.
      return dedupeByHost(sites);
    },
    async revoke({ ownerId, host: rawHost }) {
      const host = normalizeHost(rawHost);
      if (host === null || !isOwnerId(ownerId)) return false;
      // `key('user', ...)` and never the caller's scope: the memory store has
      // to refuse an operator entry for the same reason the db one does, and
      // the only global bucket lives under a key this line cannot produce.
      return byOwner.get(key('user', ownerId))?.delete(host) ?? false;
    },
    async remember(entry) {
      const checked = validate(entry);
      if (checked === null) return false;
      const { owner, host } = checked;
      const k = key(entry.scope, owner);
      const hosts = byOwner.get(k) ?? new Map<string, Date>();
      if (hosts.has(host)) return false;
      if (entry.scope === 'user' && hosts.size >= MAX_USER_HOSTS) return false;
      hosts.set(host, new Date());
      byOwner.set(k, hosts);
      return true;
    },
  };
}
