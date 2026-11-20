import { LEFTOVER_APPS_MAX } from '../limits.js';
import { InstallStoreError, type InstallRow, type InstallStore, type LeftoverApp } from '../store.js';

// ── An in-memory InstallStore, with the real one's rules ────────────────────

export interface Row extends InstallRow {
  stateHash: string | null;
  stateUserId: string | null;
  stateExpiresAt: Date | null;
}
export type StoreMethod = keyof InstallStore;

export function memoryStore(clock: () => number, trail: string[]) {
  const rows = new Map<string, Row>();
  /** The Slack apps Disconnect couldn't delete, by the removed install's id. */
  const leftovers = new Map<string, LeftoverApp>();
  const calls: Array<{ method: StoreMethod; args: unknown[] }> = [];
  /** A method listed here throws this, every time, until it is deleted. */
  const failures = new Map<StoreMethod, unknown>();

  async function enter(method: StoreMethod, args: unknown[]): Promise<void> {
    calls.push({ method, args });
    trail.push(`store:${method}`);
    await Promise.resolve(); // a real store answers later
    if (failures.has(method)) throw failures.get(method);
  }
  function view(r: Row): InstallRow {
    return {
      installId: r.installId,
      status: r.status,
      appId: r.appId,
      clientId: r.clientId,
      botName: r.botName,
      teamId: r.teamId,
      teamName: r.teamName,
      botUserId: r.botUserId,
      connectedByUserId: r.connectedByUserId,
      createdAt: r.createdAt,
      configTokenAddedAt: r.configTokenAddedAt,
      installedAt: r.installedAt,
    };
  }
  function holding(stateHash: string): Row | undefined {
    for (const r of rows.values()) if (r.stateHash === stateHash) return r;
    return undefined;
  }

  const store: InstallStore = {
    async current() {
      await enter('current', []);
      const oldest = [...rows.values()].sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.installId.localeCompare(b.installId),
      )[0];
      return oldest === undefined ? null : view(oldest);
    },
    async get(installId) {
      await enter('get', [installId]);
      const r = rows.get(installId);
      return r === undefined ? null : view(r);
    },
    async insertPending(r) {
      await enter('insertPending', [r]);
      if (rows.has(r.installId)) throw new Error('duplicate key value violates unique constraint');
      // One INSERT in the real store: both dates are its now().
      const at = clock();
      rows.set(r.installId, {
        ...r,
        status: 'pending',
        teamId: null,
        teamName: null,
        botUserId: null,
        createdAt: new Date(at),
        configTokenAddedAt: new Date(at),
        installedAt: null,
        stateHash: null,
        stateUserId: null,
        stateExpiresAt: null,
      });
    },
    async setOAuthState(installId, s) {
      await enter('setOAuthState', [installId, s]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'pending') throw new InstallStoreError('install-not-pending');
      r.stateHash = s.stateHash;
      r.stateUserId = s.userId;
      r.stateExpiresAt = s.expiresAt;
    },
    async peekOAuthState(stateHash) {
      await enter('peekOAuthState', [stateHash]);
      const r = holding(stateHash);
      if (r === undefined || r.stateUserId === null || r.stateExpiresAt === null) return null;
      return { installId: r.installId, userId: r.stateUserId, expiresAt: r.stateExpiresAt };
    },
    async consumeOAuthState(stateHash) {
      await enter('consumeOAuthState', [stateHash]);
      const r = holding(stateHash);
      if (r === undefined || r.stateUserId === null || r.stateExpiresAt === null) return null;
      const spent = { installId: r.installId, userId: r.stateUserId, expiresAt: r.stateExpiresAt };
      r.stateHash = null;
      r.stateUserId = null;
      r.stateExpiresAt = null;
      return spent;
    },
    async activate(installId, a) {
      await enter('activate', [installId, a]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'pending') throw new InstallStoreError('install-not-pending');
      r.status = 'active';
      r.teamId = a.teamId;
      r.teamName = a.teamName;
      r.botUserId = a.botUserId;
      r.installedAt = a.installedAt;
    },
    async setBotName(installId, botName) {
      await enter('setBotName', [installId, botName]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'active') throw new InstallStoreError('install-not-active');
      r.botName = botName;
    },
    async setConfigTokenAddedAt(installId, addedAt) {
      await enter('setConfigTokenAddedAt', [installId, addedAt]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'active') throw new InstallStoreError('install-not-active');
      // Only the date: the row's person never moves (TASK-1175).
      r.configTokenAddedAt = new Date(addedAt.getTime());
    },
    async remove(installId, o) {
      await enter('remove', [installId, o]);
      // One statement in the real store: the app is remembered only with its
      // row's own delete, with the row's own person (TASK-1175), and an id
      // already remembered keeps its first app.
      const r = rows.get(installId);
      if (r !== undefined && o?.appLeft === true && !leftovers.has(installId)) {
        leftovers.set(installId, {
          installId,
          appId: r.appId,
          botName: r.botName,
          leftAt: new Date(clock()),
          connectedByUserId: r.connectedByUserId,
        });
      }
      rows.delete(installId);
    },
    async removeAll() {
      await enter('removeAll', []);
      const removed = [...rows.values()].map((r) => ({
        installId: r.installId,
        appId: r.appId,
        teamId: r.teamId,
        connectedByUserId: r.connectedByUserId,
      }));
      rows.clear();
      return removed;
    },
    async list() {
      await enter('list', []);
      return [...rows.values()]
        .sort(
          (a, b) =>
            b.configTokenAddedAt.getTime() - a.configTokenAddedAt.getTime() ||
            a.installId.localeCompare(b.installId),
        )
        .map(view);
    },
    async personHasApps(userId) {
      await enter('personHasApps', [userId]);
      return (
        [...rows.values()].some((r) => r.connectedByUserId === userId) ||
        [...leftovers.values()].some((l) => l.connectedByUserId === userId)
      );
    },
    async leftoverApps() {
      await enter('leftoverApps', []);
      return [...leftovers.values()]
        .sort((a, b) => a.leftAt.getTime() - b.leftAt.getTime() || a.installId.localeCompare(b.installId))
        .slice(0, LEFTOVER_APPS_MAX)
        .map((l) => ({ ...l }));
    },
    async rememberLeftoverApp(a) {
      await enter('rememberLeftoverApp', [a]);
      if (!leftovers.has(a.installId)) {
        leftovers.set(a.installId, {
          installId: a.installId,
          appId: a.appId,
          botName: a.botName,
          leftAt: new Date(clock()),
          connectedByUserId: a.connectedByUserId,
        });
      }
    },
    async forgetLeftoverApp(installId) {
      await enter('forgetLeftoverApp', [installId]);
      leftovers.delete(installId);
    },
  };
  return { store, rows, leftovers, calls, failures };
}
