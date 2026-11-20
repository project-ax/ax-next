import { LEFTOVER_APPS_MAX } from '../limits.js';
import {
  InstallStoreError,
  type BotRequest,
  type InstallKind,
  type InstallRow,
  type InstallStore,
  type LeftoverApp,
} from '../store.js';

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
  /** Open bot requests waiting for an AX admin (TASK-1169), by request id. */
  const requests = new Map<string, BotRequest>();
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
      kind: r.kind,
      status: r.status,
      appId: r.appId,
      clientId: r.clientId,
      botName: r.botName,
      teamId: r.teamId,
      teamName: r.teamName,
      botUserId: r.botUserId,
      connectedByUserId: r.connectedByUserId,
      agentId: r.agentId,
      requestedByUserId: r.requestedByUserId,
      botHandle: r.botHandle,
      createdAt: r.createdAt,
      configTokenAddedAt: r.configTokenAddedAt,
      installedAt: r.installedAt,
    };
  }
  /** The install of this kind holding the state: another kind's never matches (TASK-1167). */
  function holding(stateHash: string, kind: InstallKind): Row | undefined {
    for (const r of rows.values()) if (r.stateHash === stateHash && r.kind === kind) return r;
    return undefined;
  }
  const oldestFirst = (a: Row, b: Row): number =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.installId.localeCompare(b.installId);
  /** A new pending row, as the real store's one INSERT writes it: both dates are its now(). */
  function pendingRow(
    r: Pick<InstallRow, 'installId' | 'appId' | 'clientId' | 'botName' | 'connectedByUserId' | 'kind'> &
      Pick<InstallRow, 'agentId' | 'requestedByUserId'>,
  ): Row {
    const at = clock();
    return {
      ...r,
      status: 'pending',
      teamId: null,
      teamName: null,
      botUserId: null,
      botHandle: null,
      createdAt: new Date(at),
      configTokenAddedAt: new Date(at),
      installedAt: null,
      stateHash: null,
      stateUserId: null,
      stateExpiresAt: null,
    };
  }

  const store: InstallStore = {
    async current() {
      await enter('current', []);
      // The shared app only: never a team agent's bot.
      const oldest = [...rows.values()].filter((r) => r.kind === 'shared').sort(oldestFirst)[0];
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
      rows.set(r.installId, pendingRow({ ...r, kind: 'shared', agentId: null, requestedByUserId: null }));
    },
    async insertPendingBot(r) {
      await enter('insertPendingBot', [r]);
      if (rows.has(r.installId)) throw new Error('duplicate key value violates unique constraint');
      // The real store's unique index: one bot per agent, pending or active.
      if ([...rows.values()].some((x) => x.kind === 'bot' && x.agentId === r.agentId)) {
        throw new InstallStoreError('bot-exists');
      }
      rows.set(r.installId, pendingRow({ ...r, kind: 'bot' }));
    },
    async botForAgent(agentId) {
      await enter('botForAgent', [agentId]);
      const r = [...rows.values()].find((x) => x.kind === 'bot' && x.agentId === agentId);
      return r === undefined ? null : view(r);
    },
    async listBots() {
      await enter('listBots', []);
      return [...rows.values()].filter((r) => r.kind === 'bot').sort(oldestFirst).map(view);
    },
    async setBotHandle(installId, handle) {
      await enter('setBotHandle', [installId, handle]);
      const r = rows.get(installId);
      if (r === undefined || r.kind !== 'bot' || r.status !== 'active') {
        throw new InstallStoreError('install-not-active');
      }
      r.botHandle = handle;
    },
    async insertBotRequest(r) {
      await enter('insertBotRequest', [r]);
      if (requests.has(r.requestId)) throw new Error('duplicate key value violates unique constraint');
      // The real store's unique index: one open request per agent.
      if ([...requests.values()].some((x) => x.agentId === r.agentId)) {
        throw new InstallStoreError('request-exists');
      }
      requests.set(r.requestId, {
        requestId: r.requestId,
        agentId: r.agentId,
        requestedByUserId: r.requestedByUserId,
        botName: r.botName,
        createdAt: new Date(clock()),
      });
    },
    async getBotRequest(requestId) {
      await enter('getBotRequest', [requestId]);
      const r = requests.get(requestId);
      return r === undefined ? null : { ...r };
    },
    async botRequestForAgent(agentId) {
      await enter('botRequestForAgent', [agentId]);
      const r = [...requests.values()].find((x) => x.agentId === agentId);
      return r === undefined ? null : { ...r };
    },
    async listBotRequests() {
      await enter('listBotRequests', []);
      return [...requests.values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.requestId.localeCompare(b.requestId))
        .map((r) => ({ ...r }));
    },
    async removeBotRequest(requestId) {
      await enter('removeBotRequest', [requestId]);
      return requests.delete(requestId);
    },
    async removeBotRequestForAgent(agentId) {
      await enter('removeBotRequestForAgent', [agentId]);
      const r = [...requests.values()].find((x) => x.agentId === agentId);
      if (r === undefined) return null;
      requests.delete(r.requestId);
      return r.requestId;
    },
    async setOAuthState(installId, s) {
      await enter('setOAuthState', [installId, s]);
      const r = rows.get(installId);
      if (r === undefined || r.status !== 'pending') throw new InstallStoreError('install-not-pending');
      r.stateHash = s.stateHash;
      r.stateUserId = s.userId;
      r.stateExpiresAt = s.expiresAt;
    },
    async peekOAuthState(stateHash, kind) {
      await enter('peekOAuthState', [stateHash, kind]);
      const r = holding(stateHash, kind);
      if (r === undefined || r.stateUserId === null || r.stateExpiresAt === null) return null;
      return { installId: r.installId, userId: r.stateUserId, expiresAt: r.stateExpiresAt };
    },
    async consumeOAuthState(stateHash, kind) {
      await enter('consumeOAuthState', [stateHash, kind]);
      const r = holding(stateHash, kind);
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
      // Every kind, and every open request, as the real one: its one caller
      // is the bootstrap reset.
      const removed = [...rows.values()].map((r) => ({
        installId: r.installId,
        appId: r.appId,
        teamId: r.teamId,
        connectedByUserId: r.connectedByUserId,
        kind: r.kind,
      }));
      rows.clear();
      requests.clear();
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
  return { store, rows, leftovers, requests, calls, failures };
}
