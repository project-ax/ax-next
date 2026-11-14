import type { ChannelBinding, ChannelStore, ChannelThread } from '../channel-store.js';
import { cleanChannelName } from '../label.js';

/**
 * An in-memory ChannelStore with the real one's rules (channel-store.ts,
 * pinned against Postgres in channel-store.test.ts): one agent per (install,
 * channel); `upsert` answers `connected` (remember on), `reconnected` (the
 * connector and name replaced, remember and createdAt kept) or `taken`
 * (nothing changes); `remove` and `setRemember` act only on the named
 * agent's binding; a name is stored cleaned; `listForAgent` is oldest first.
 * A thread is keyed by its conversation alone and written once: a later
 * `recordThread` changes only `notRemembered` and `external`, neither of
 * which ever goes back to false. `recordThread` takes `notRemembered` from
 * the named agent's binding as it is at the write and `external` from the
 * turn's mode (anything but `attended` is external), and answers
 * `no-binding` (writing nothing) when there is no binding.
 * `removeForAgent` takes the agent's threads too; nothing else does.
 *
 * Each new binding is one second younger than the one before, so "oldest
 * first" never hangs on a clock. `calls` records every method, in order.
 */
export function memoryChannelStore() {
  const rows = new Map<string, ChannelBinding>();
  /** The thread map, by conversation id. */
  const threads = new Map<string, ChannelThread>();
  const calls: Array<keyof ChannelStore> = [];
  let created = Date.parse('2026-11-13T09:00:00.000Z');
  const key = (installId: string, channelId: string): string => `${installId}/${channelId}`;
  const copy = (b: ChannelBinding): ChannelBinding => ({ ...b, createdAt: new Date(b.createdAt) });

  const store: ChannelStore = {
    async get(installId, channelId) {
      calls.push('get');
      const row = rows.get(key(installId, channelId));
      return row === undefined ? null : copy(row);
    },
    async listForAgent(installId, agentId) {
      calls.push('listForAgent');
      return [...rows.values()]
        .filter((b) => b.installId === installId && b.agentId === agentId)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0),
        )
        .map(copy);
    },
    async listAll(installId) {
      calls.push('listAll');
      return [...rows.values()]
        .filter((b) => b.installId === installId)
        .map((b) => ({ channelId: b.channelId, agentId: b.agentId }));
    },
    async upsert(b) {
      calls.push('upsert');
      const at = key(b.installId, b.channelId);
      const row = rows.get(at);
      if (row !== undefined && row.agentId !== b.agentId) return 'taken';
      const channelName = cleanChannelName(b.channelName);
      if (row !== undefined) {
        rows.set(at, { ...row, connectedByUserId: b.connectedByUserId, channelName });
        return 'reconnected';
      }
      created += 1000;
      rows.set(at, {
        installId: b.installId,
        channelId: b.channelId,
        agentId: b.agentId,
        connectedByUserId: b.connectedByUserId,
        channelName,
        remember: true,
        createdAt: new Date(created),
      });
      return 'connected';
    },
    async remove(installId, channelId, agentId) {
      calls.push('remove');
      const at = key(installId, channelId);
      if (rows.get(at)?.agentId !== agentId) return false;
      rows.delete(at);
      return true;
    },
    async setRemember(installId, channelId, agentId, remember) {
      calls.push('setRemember');
      const row = rows.get(key(installId, channelId));
      if (row === undefined || row.agentId !== agentId) return false;
      row.remember = remember;
      return true;
    },
    async removeForAgent(agentId) {
      calls.push('removeForAgent');
      let removed = 0;
      for (const [at, row] of rows) {
        if (row.agentId !== agentId) continue;
        rows.delete(at);
        removed += 1;
      }
      let threadsRemoved = 0;
      for (const [conversationId, thread] of threads) {
        if (thread.agentId !== agentId) continue;
        threads.delete(conversationId);
        threadsRemoved += 1;
      }
      return { channels: removed, threads: threadsRemoved };
    },
    async recordThread(t) {
      calls.push('recordThread');
      const binding = rows.get(key(t.installId, t.channelId));
      if (binding === undefined || binding.agentId !== t.agentId) return 'no-binding';
      const notRemembered = !binding.remember;
      const external = t.mode !== 'attended';
      const known = threads.get(t.conversationId);
      threads.set(
        t.conversationId,
        known === undefined
          ? { installId: t.installId, channelId: t.channelId, agentId: t.agentId, notRemembered, external }
          : { ...known, notRemembered: known.notRemembered || notRemembered, external: known.external || external },
      );
      return 'recorded';
    },
    async getThread(conversationId) {
      calls.push('getThread');
      const known = threads.get(conversationId);
      return known === undefined ? null : { ...known };
    },
  };

  /** The binding as stored, without going through the store (no call recorded). */
  const row = (installId: string, channelId: string): ChannelBinding | undefined => {
    const found = rows.get(key(installId, channelId));
    return found === undefined ? undefined : copy(found);
  };

  return { store, rows, threads, calls, row };
}
