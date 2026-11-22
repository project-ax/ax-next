import type { AppMode } from '@ax/apps-bridge-contract';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  AppsBridgeDatabase,
  AppsBridgeGrantsTable,
  AppsBridgeLinksTable,
  AppsBridgeViewerApprovalsTable,
} from './migrations.js';

/**
 * Every query against the `apps_bridge_v1_` tables lives in this file
 * (eslint-rules/no-bare-tenant-tables.js). The store takes ids as given: the
 * callers (the bridge's claim/call/grants logic and the settings routes)
 * check them against their grammars and check who may act before they get
 * here. What the store does decide is atomicity: a code links once, an app id
 * is linked to one agent, and a removal names the agent it acts on.
 */

/** An outside app linked to an agent. The code that made it is never handed out. */
export interface AppLink {
  platformId: string;
  appId: string;
  agentId: string;
  linkedByUserId: string;
  appName: string;
  createdAt: Date;
}

/** Which of the linked agent's connectors an app may call, how, and which tools. */
export interface AppGrant {
  platformId: string;
  appId: string;
  connectorId: string;
  mode: AppMode;
  toolKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** A viewer's consent to a viewer-mode grant, and the personal agent it borrows. */
export interface ViewerApproval {
  viewerUserId: string;
  platformId: string;
  appId: string;
  connectorId: string;
  agentId: string;
  toolKeys: string[];
  createdAt: Date;
}

/** At most this many open link codes per agent; minting more drops the oldest. */
export const MAX_OPEN_LINK_CODES_PER_AGENT = 10;

export type ClaimLinkCodeResult =
  | { result: 'linked'; link: AppLink }
  | { result: 'invalid' }
  | { result: 'already-linked' };

export interface AppsBridgeStore {
  /**
   * One transaction: delete every code (any agent's) with `expires_at <= now`;
   * insert this one with `created_at = now`; delete this agent's codes beyond
   * the newest {@link MAX_OPEN_LINK_CODES_PER_AGENT} (by `created_at DESC,
   * code_hash`). Mints for one agent are serialized, so racing mints can't
   * leave more than the cap open.
   */
  mintLinkCode(c: { codeHash: string; userId: string; agentId: string; expiresAt: Date; now: Date }): Promise<void>;
  /** Who minted an unexpired code, and for which agent. Null when unknown or expired. */
  peekLinkCode(codeHash: string, now: Date): Promise<{ userId: string; agentId: string } | null>;
  /**
   * One transaction, in this order:
   *  1. lock the unexpired code (`FOR UPDATE`); none → `'invalid'`;
   *  2. a link for (platformId, appId) exists → `'already-linked'`, the code kept;
   *  3. insert the link (user and agent from the code); losing a race to
   *     another code for the same app id → `'already-linked'`, the code kept;
   *  4. delete the code → `'linked'`.
   * One code claimed twice at once: the second waits on the lock, finds the
   * code gone and answers `'invalid'` (look the link up with
   * {@link getLinkByCode} to tell a retry from a stranger).
   */
  claimLinkCode(c: { codeHash: string; platformId: string; appId: string; appName: string; now: Date }): Promise<ClaimLinkCodeResult>;
  /** The link for this app id, only if this code made it (a retried claim). */
  getLinkByCode(platformId: string, appId: string, codeHash: string): Promise<AppLink | null>;
  getLink(platformId: string, appId: string): Promise<AppLink | null>;
  /** Oldest first. */
  listLinksForAgent(platformId: string, agentId: string): Promise<AppLink[]>;
  /** Removes the link only when it is to `agentId`; its grants and approvals cascade. */
  deleteLink(platformId: string, appId: string, agentId: string): Promise<boolean>;
  getGrant(platformId: string, appId: string, connectorId: string): Promise<AppGrant | null>;
  /** Ordered by connector id. */
  listGrants(platformId: string, appId: string): Promise<AppGrant[]>;
  /** Upsert: replaces mode and tool keys (order kept), moves `updatedAt`. No link → `'no-link'`. */
  putGrant(g: Pick<AppGrant, 'platformId' | 'appId' | 'connectorId' | 'mode' | 'toolKeys'>): Promise<AppGrant | 'no-link'>;
  /** Its approvals cascade. */
  deleteGrant(platformId: string, appId: string, connectorId: string): Promise<boolean>;
  getApproval(viewerUserId: string, platformId: string, appId: string, connectorId: string): Promise<ViewerApproval | null>;
  /** Ordered by app id, then connector id. */
  listApprovalsForViewerAgent(viewerUserId: string, platformId: string, agentId: string): Promise<ViewerApproval[]>;
  /** Upsert: replaces the agent and the tool snapshot; `createdAt` stays the first approval's. No grant → `'no-grant'`. */
  putApproval(a: Omit<ViewerApproval, 'createdAt'>): Promise<'saved' | 'no-grant'>;
  /** Removes the approval only when it borrows `agentId`. */
  deleteApproval(viewerUserId: string, platformId: string, appId: string, connectorId: string, agentId: string): Promise<boolean>;
  /**
   * One transaction: the agent's link codes, the links to it (their grants
   * and approvals cascade, and aren't counted), then the approvals that
   * borrow it on other agents' apps. Idempotent.
   */
  deleteForAgent(agentId: string): Promise<{ codes: number; links: number; approvals: number }>;
  /** That connector's grants on every app, on every platform; their approvals cascade. */
  deleteGrantsForConnector(connectorId: string): Promise<number>;
}

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function pgCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** Kysely reports an affected-row count as a bigint. */
function rows(n: bigint | undefined): number {
  return Number(n ?? 0n);
}

/**
 * The mode column has a CHECK, so anything else is a corrupt row: refuse to
 * hand it out as a grant rather than guess which mode it meant.
 */
function toMode(mode: string): AppMode {
  if (mode === 'builder' || mode === 'viewer') return mode;
  throw new Error('apps_bridge_v1_grants holds an unknown mode');
}

function toLink(r: Omit<Selectable<AppsBridgeLinksTable>, 'link_code_hash'>): AppLink {
  return {
    platformId: r.platform_id,
    appId: r.app_id,
    agentId: r.agent_id,
    linkedByUserId: r.linked_by_user_id,
    appName: r.app_name,
    createdAt: r.created_at,
  };
}

function toGrant(r: Selectable<AppsBridgeGrantsTable>): AppGrant {
  return {
    platformId: r.platform_id,
    appId: r.app_id,
    connectorId: r.connector_id,
    mode: toMode(r.mode),
    toolKeys: r.tool_keys,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toApproval(r: Selectable<AppsBridgeViewerApprovalsTable>): ViewerApproval {
  return {
    viewerUserId: r.viewer_user_id,
    platformId: r.platform_id,
    appId: r.app_id,
    connectorId: r.connector_id,
    agentId: r.agent_id,
    toolKeys: r.tool_keys,
    createdAt: r.created_at,
  };
}

const LINK_COLUMNS = ['platform_id', 'app_id', 'agent_id', 'linked_by_user_id', 'app_name', 'created_at'] as const;

export function createAppsBridgeStore(db: Kysely<AppsBridgeDatabase>): AppsBridgeStore {
  return {
    async mintLinkCode(c) {
      await db.transaction().execute(async (trx) => {
        // Serialize mints per agent: two racing mints would otherwise each
        // trim against a table without the other's row and leave 11 open.
        // The key is namespaced so it can't collide with another plugin's lock
        // on the same agent id by design (a hash collision only costs a wait).
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`apps_bridge_v1_link_codes:${c.agentId}`}, 0))`.execute(trx);
        await trx.deleteFrom('apps_bridge_v1_link_codes').where('expires_at', '<=', c.now).execute();
        await trx
          .insertInto('apps_bridge_v1_link_codes')
          .values({ code_hash: c.codeHash, user_id: c.userId, agent_id: c.agentId, expires_at: c.expiresAt, created_at: c.now })
          .execute();
        await trx
          .deleteFrom('apps_bridge_v1_link_codes')
          .where('agent_id', '=', c.agentId)
          .where('code_hash', 'not in', (q) =>
            q
              .selectFrom('apps_bridge_v1_link_codes')
              .select('code_hash')
              .where('agent_id', '=', c.agentId)
              .orderBy('created_at', 'desc')
              .orderBy('code_hash')
              .limit(MAX_OPEN_LINK_CODES_PER_AGENT),
          )
          .execute();
      });
    },

    async peekLinkCode(codeHash, now) {
      const row = await db
        .selectFrom('apps_bridge_v1_link_codes')
        .select(['user_id', 'agent_id'])
        .where('code_hash', '=', codeHash)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      return row === undefined ? null : { userId: row.user_id, agentId: row.agent_id };
    },

    async claimLinkCode(c) {
      try {
        return await db.transaction().execute(async (trx): Promise<ClaimLinkCodeResult> => {
          // 1. Lock the code. A second claim of the same code waits here, then
          //    re-reads the row after the first commits: gone, so 'invalid'.
          const code = await trx
            .selectFrom('apps_bridge_v1_link_codes')
            .select(['user_id', 'agent_id'])
            .where('code_hash', '=', c.codeHash)
            .where('expires_at', '>', c.now)
            .forUpdate()
            .executeTakeFirst();
          if (code === undefined) return { result: 'invalid' };

          // 2. Already linked: nothing has been written, so returning commits
          //    nothing and the code stays usable.
          const existing = await trx
            .selectFrom('apps_bridge_v1_links')
            .select('app_id')
            .where('platform_id', '=', c.platformId)
            .where('app_id', '=', c.appId)
            .executeTakeFirst();
          if (existing !== undefined) return { result: 'already-linked' };

          // 3. A racing claim with another code for the same app id passed
          //    step 2 too. Its insert waits on the primary key and fails
          //    with 23505 once this one commits; the catch below answers it.
          const inserted = await trx
            .insertInto('apps_bridge_v1_links')
            .values({
              platform_id: c.platformId,
              app_id: c.appId,
              agent_id: code.agent_id,
              linked_by_user_id: code.user_id,
              app_name: c.appName,
              link_code_hash: c.codeHash,
              created_at: c.now,
            })
            .returning(LINK_COLUMNS)
            .executeTakeFirstOrThrow();

          // 4. Burn the code.
          await trx.deleteFrom('apps_bridge_v1_link_codes').where('code_hash', '=', c.codeHash).execute();
          return { result: 'linked', link: toLink(inserted) };
        });
      } catch (err) {
        // The transaction rolled back, so the losing code is still there.
        if (pgCode(err) === PG_UNIQUE_VIOLATION) return { result: 'already-linked' };
        throw err;
      }
    },

    async getLinkByCode(platformId, appId, codeHash) {
      const row = await db
        .selectFrom('apps_bridge_v1_links')
        .select(LINK_COLUMNS)
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('link_code_hash', '=', codeHash)
        .executeTakeFirst();
      return row === undefined ? null : toLink(row);
    },

    async getLink(platformId, appId) {
      const row = await db
        .selectFrom('apps_bridge_v1_links')
        .select(LINK_COLUMNS)
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .executeTakeFirst();
      return row === undefined ? null : toLink(row);
    },

    async listLinksForAgent(platformId, agentId) {
      const found = await db
        .selectFrom('apps_bridge_v1_links')
        .select(LINK_COLUMNS)
        .where('platform_id', '=', platformId)
        .where('agent_id', '=', agentId)
        .orderBy('created_at')
        .orderBy('app_id')
        .execute();
      return found.map(toLink);
    },

    async deleteLink(platformId, appId, agentId) {
      const r = await db
        .deleteFrom('apps_bridge_v1_links')
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return rows(r.numDeletedRows) > 0;
    },

    async getGrant(platformId, appId, connectorId) {
      const row = await db
        .selectFrom('apps_bridge_v1_grants')
        .selectAll()
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return row === undefined ? null : toGrant(row);
    },

    async listGrants(platformId, appId) {
      const found = await db
        .selectFrom('apps_bridge_v1_grants')
        .selectAll()
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .orderBy('connector_id')
        .execute();
      return found.map(toGrant);
    },

    async putGrant(g) {
      try {
        const row = await db
          .insertInto('apps_bridge_v1_grants')
          .values({
            platform_id: g.platformId,
            app_id: g.appId,
            connector_id: g.connectorId,
            mode: g.mode,
            tool_keys: g.toolKeys,
          })
          .onConflict((oc) =>
            oc.columns(['platform_id', 'app_id', 'connector_id']).doUpdateSet({
              mode: g.mode,
              tool_keys: g.toolKeys,
              updated_at: sql<Date>`now()`,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        return toGrant(row);
      } catch (err) {
        if (pgCode(err) === PG_FOREIGN_KEY_VIOLATION) return 'no-link';
        throw err;
      }
    },

    async deleteGrant(platformId, appId, connectorId) {
      const r = await db
        .deleteFrom('apps_bridge_v1_grants')
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return rows(r.numDeletedRows) > 0;
    },

    async getApproval(viewerUserId, platformId, appId, connectorId) {
      const row = await db
        .selectFrom('apps_bridge_v1_viewer_approvals')
        .selectAll()
        .where('viewer_user_id', '=', viewerUserId)
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('connector_id', '=', connectorId)
        .executeTakeFirst();
      return row === undefined ? null : toApproval(row);
    },

    async listApprovalsForViewerAgent(viewerUserId, platformId, agentId) {
      const found = await db
        .selectFrom('apps_bridge_v1_viewer_approvals')
        .selectAll()
        .where('viewer_user_id', '=', viewerUserId)
        .where('platform_id', '=', platformId)
        .where('agent_id', '=', agentId)
        .orderBy('app_id')
        .orderBy('connector_id')
        .execute();
      return found.map(toApproval);
    },

    async putApproval(a) {
      try {
        await db
          .insertInto('apps_bridge_v1_viewer_approvals')
          .values({
            viewer_user_id: a.viewerUserId,
            platform_id: a.platformId,
            app_id: a.appId,
            connector_id: a.connectorId,
            agent_id: a.agentId,
            tool_keys: a.toolKeys,
          })
          .onConflict((oc) =>
            oc
              .columns(['viewer_user_id', 'platform_id', 'app_id', 'connector_id'])
              .doUpdateSet({ agent_id: a.agentId, tool_keys: a.toolKeys }),
          )
          .execute();
        return 'saved';
      } catch (err) {
        if (pgCode(err) === PG_FOREIGN_KEY_VIOLATION) return 'no-grant';
        throw err;
      }
    },

    async deleteApproval(viewerUserId, platformId, appId, connectorId, agentId) {
      const r = await db
        .deleteFrom('apps_bridge_v1_viewer_approvals')
        .where('viewer_user_id', '=', viewerUserId)
        .where('platform_id', '=', platformId)
        .where('app_id', '=', appId)
        .where('connector_id', '=', connectorId)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      return rows(r.numDeletedRows) > 0;
    },

    async deleteForAgent(agentId) {
      return db.transaction().execute(async (trx) => {
        const codes = await trx.deleteFrom('apps_bridge_v1_link_codes').where('agent_id', '=', agentId).executeTakeFirst();
        const links = await trx.deleteFrom('apps_bridge_v1_links').where('agent_id', '=', agentId).executeTakeFirst();
        const approvals = await trx
          .deleteFrom('apps_bridge_v1_viewer_approvals')
          .where('agent_id', '=', agentId)
          .executeTakeFirst();
        return { codes: rows(codes.numDeletedRows), links: rows(links.numDeletedRows), approvals: rows(approvals.numDeletedRows) };
      });
    },

    async deleteGrantsForConnector(connectorId) {
      const r = await db.deleteFrom('apps_bridge_v1_grants').where('connector_id', '=', connectorId).executeTakeFirst();
      return rows(r.numDeletedRows);
    },
  };
}
