import {
  MAX_OPEN_LINK_CODES_PER_AGENT,
  TOOL_NAMESPACE_RE,
  type AppGrant,
  type AppLink,
  type AppsBridgeStore,
  type ClaimLinkCodeResult,
  type ViewerApproval,
} from '../../store.js';

/**
 * An in-memory AppsBridgeStore with the real store's rules (store.ts):
 * code hashes must be 64 lowercase hex; a code expires at `expires_at <= now`;
 * minting sweeps expired codes and keeps an agent's newest ten; a claim links
 * once and burns the code, keeps it on `already-linked`, and answers
 * `invalid` for a gone or expired code; a link's grants and a grant's
 * approvals cascade; `putGrant` needs a link (to `agentId`, when given) and
 * clears the grant's approvals when its mode changes; `putApproval` needs a
 * viewer-mode grant.
 *
 * Every method is async and copies what it hands out, so a test can't edit
 * the store through a returned object. Tests replace a method (vi.spyOn) to
 * make it throw.
 */

const CODE_HASH_RE = /^[0-9a-f]{64}$/;

function assertCodeHash(codeHash: string): void {
  if (typeof codeHash !== 'string' || !CODE_HASH_RE.test(codeHash)) {
    throw new Error('fake store: a link code hash must be 64 lowercase hex characters');
  }
}

interface CodeRow { codeHash: string; userId: string; agentId: string; expiresAt: Date; createdAt: Date }

const k = (...parts: string[]) => JSON.stringify(parts);

const copyLink = (l: AppLink): AppLink => ({ ...l });
const copyGrant = (g: AppGrant): AppGrant => ({ ...g, toolKeys: [...g.toolKeys] });
const copyApproval = (a: ViewerApproval): ViewerApproval => ({ ...a, toolKeys: [...a.toolKeys] });

function namesNamespace(keys: readonly string[], namespaces: ReadonlySet<string>): boolean {
  return keys.some((key) => key.startsWith('mcp.') && namespaces.has(key.split('.')[1] ?? ''));
}

export interface FakeStore extends AppsBridgeStore {
  /** Test-only: how many links exist (any platform). */
  linkCount(): number;
}

export function createFakeStore(): FakeStore {
  const codes = new Map<string, CodeRow>();
  const links = new Map<string, AppLink & { codeHash: string }>();
  const grants = new Map<string, AppGrant>();
  const approvals = new Map<string, ViewerApproval>();

  const linkKey = (p: string, a: string) => k(p, a);
  const grantKey = (p: string, a: string, c: string) => k(p, a, c);
  const approvalKey = (v: string, p: string, a: string, c: string) => k(v, p, a, c);

  function dropApprovalsWhere(pred: (a: ViewerApproval) => boolean): number {
    let n = 0;
    for (const [key, a] of approvals) if (pred(a)) { approvals.delete(key); n++; }
    return n;
  }
  function dropGrantsWhere(pred: (g: AppGrant) => boolean): number {
    let n = 0;
    for (const [key, g] of grants) {
      if (!pred(g)) continue;
      grants.delete(key);
      dropApprovalsWhere((a) => a.platformId === g.platformId && a.appId === g.appId && a.connectorId === g.connectorId);
      n++;
    }
    return n;
  }
  function dropLink(key: string, l: AppLink): void {
    links.delete(key);
    dropGrantsWhere((g) => g.platformId === l.platformId && g.appId === l.appId);
  }

  return {
    linkCount: () => links.size,

    async mintLinkCode(c) {
      assertCodeHash(c.codeHash);
      for (const [h, row] of codes) if (row.expiresAt.getTime() <= c.now.getTime()) codes.delete(h);
      codes.set(c.codeHash, { codeHash: c.codeHash, userId: c.userId, agentId: c.agentId, expiresAt: c.expiresAt, createdAt: c.now });
      const mine = [...codes.values()]
        .filter((r) => r.agentId === c.agentId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.codeHash < b.codeHash ? -1 : 1));
      for (const r of mine.slice(MAX_OPEN_LINK_CODES_PER_AGENT)) codes.delete(r.codeHash);
    },

    async peekLinkCode(codeHash, now) {
      assertCodeHash(codeHash);
      const row = codes.get(codeHash);
      return row !== undefined && row.expiresAt.getTime() > now.getTime() ? { userId: row.userId, agentId: row.agentId } : null;
    },

    async claimLinkCode(c): Promise<ClaimLinkCodeResult> {
      assertCodeHash(c.codeHash);
      const code = codes.get(c.codeHash);
      if (code === undefined || code.expiresAt.getTime() <= c.now.getTime()) return { result: 'invalid' };
      if (links.has(linkKey(c.platformId, c.appId))) return { result: 'already-linked' };
      const link: AppLink & { codeHash: string } = {
        platformId: c.platformId,
        appId: c.appId,
        agentId: code.agentId,
        linkedByUserId: code.userId,
        appName: c.appName,
        createdAt: c.now,
        codeHash: c.codeHash,
      };
      links.set(linkKey(c.platformId, c.appId), link);
      codes.delete(c.codeHash);
      const { codeHash: _drop, ...out } = link;
      return { result: 'linked', link: out };
    },

    async getLinkByCode(platformId, appId, codeHash) {
      assertCodeHash(codeHash);
      const l = links.get(linkKey(platformId, appId));
      if (l === undefined || l.codeHash !== codeHash) return null;
      const { codeHash: _drop, ...out } = l;
      return out;
    },

    async getLink(platformId, appId) {
      const l = links.get(linkKey(platformId, appId));
      if (l === undefined) return null;
      const { codeHash: _drop, ...out } = l;
      return out;
    },

    async listLinksForAgent(platformId, agentId) {
      return [...links.values()]
        .filter((l) => l.platformId === platformId && l.agentId === agentId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.appId < b.appId ? -1 : 1))
        .map(({ codeHash: _drop, ...l }) => copyLink(l));
    },

    async deleteLink(platformId, appId, agentId) {
      const key = linkKey(platformId, appId);
      const l = links.get(key);
      if (l === undefined || l.agentId !== agentId) return false;
      dropLink(key, l);
      return true;
    },

    async getGrant(platformId, appId, connectorId) {
      const g = grants.get(grantKey(platformId, appId, connectorId));
      return g === undefined ? null : copyGrant(g);
    },

    async listGrants(platformId, appId) {
      return [...grants.values()]
        .filter((g) => g.platformId === platformId && g.appId === appId)
        .sort((a, b) => (a.connectorId < b.connectorId ? -1 : a.connectorId > b.connectorId ? 1 : 0))
        .map(copyGrant);
    },

    async putGrant(g) {
      const l = links.get(linkKey(g.platformId, g.appId));
      if (l === undefined || (g.agentId !== undefined && l.agentId !== g.agentId)) return 'no-link';
      const key = grantKey(g.platformId, g.appId, g.connectorId);
      const existing = grants.get(key);
      if (existing !== undefined && existing.mode !== g.mode) {
        dropApprovalsWhere((a) => a.platformId === g.platformId && a.appId === g.appId && a.connectorId === g.connectorId);
      }
      const at = new Date();
      const row: AppGrant = {
        platformId: g.platformId,
        appId: g.appId,
        connectorId: g.connectorId,
        mode: g.mode,
        toolKeys: [...g.toolKeys],
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      grants.set(key, row);
      return copyGrant(row);
    },

    async deleteGrant(platformId, appId, connectorId, agentId) {
      if (agentId !== undefined && links.get(linkKey(platformId, appId))?.agentId !== agentId) return false;
      return (
        dropGrantsWhere((g) => g.platformId === platformId && g.appId === appId && g.connectorId === connectorId) > 0
      );
    },

    async getApproval(viewerUserId, platformId, appId, connectorId) {
      const a = approvals.get(approvalKey(viewerUserId, platformId, appId, connectorId));
      return a === undefined ? null : copyApproval(a);
    },

    async listApprovalsForViewerAgent(viewerUserId, platformId, agentId) {
      return [...approvals.values()]
        .filter((a) => a.viewerUserId === viewerUserId && a.platformId === platformId && a.agentId === agentId)
        .sort((a, b) => (a.appId === b.appId ? (a.connectorId < b.connectorId ? -1 : 1) : a.appId < b.appId ? -1 : 1))
        .map(copyApproval);
    },

    async putApproval(a) {
      if (grants.get(grantKey(a.platformId, a.appId, a.connectorId))?.mode !== 'viewer') return 'no-grant';
      const key = approvalKey(a.viewerUserId, a.platformId, a.appId, a.connectorId);
      const existing = approvals.get(key);
      approvals.set(key, { ...a, toolKeys: [...a.toolKeys], createdAt: existing?.createdAt ?? new Date() });
      return 'saved';
    },

    async deleteApproval(viewerUserId, platformId, appId, connectorId, agentId) {
      const key = approvalKey(viewerUserId, platformId, appId, connectorId);
      const a = approvals.get(key);
      if (a === undefined || a.agentId !== agentId) return false;
      approvals.delete(key);
      return true;
    },

    async deleteForAgent(agentId) {
      let codeCount = 0;
      for (const [h, row] of codes) if (row.agentId === agentId) { codes.delete(h); codeCount++; }
      let linkCount = 0;
      for (const [key, l] of links) if (l.agentId === agentId) { dropLink(key, l); linkCount++; }
      const approvalCount = dropApprovalsWhere((a) => a.agentId === agentId);
      return { codes: codeCount, links: linkCount, approvals: approvalCount };
    },

    async deleteGrantsForConnector(connectorId) {
      return dropGrantsWhere((g) => g.connectorId === connectorId);
    },

    async deleteForToolNamespaces(namespaces) {
      for (const ns of namespaces) {
        if (typeof ns !== 'string' || !TOOL_NAMESPACE_RE.test(ns)) throw new Error('fake store: not a tool namespace');
      }
      const set = new Set(namespaces);
      const grantCount = dropGrantsWhere((g) => namesNamespace(g.toolKeys, set));
      const approvalCount = dropApprovalsWhere((a) => namesNamespace(a.toolKeys, set));
      return { grants: grantCount, approvals: approvalCount };
    },
  };
}
