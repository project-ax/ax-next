import type { ChannelBinding, ChannelStore, ChannelThread } from '../channel-store.js';
import { cleanChannelName } from '../label.js';
import { THREAD_SPEAKER_NAMES_MAX } from '../limits.js';

/**
 * An in-memory ChannelStore with the real one's rules (channel-store.ts,
 * pinned against Postgres in channel-store.test.ts): one agent per (install,
 * channel); `upsert` answers `connected`, `reconnected` (the connector and
 * name replaced, createdAt kept) or `taken` (nothing changes); `remove` acts
 * only on the named agent's binding; a name is stored cleaned;
 * `listForAgent` is oldest first.
 * A thread is keyed by its conversation alone and written once: a later
 * `recordThread` changes only `external` and `speakerNames`. A new thread is
 * recorded remembered (TASK-1203), and one marked before keeps its mark
 * (a test marks one by setting `notRemembered` on `threads` directly, as the
 * database holds one from before). `external` comes from the turn's mode
 * (anything but `attended` is external) and never goes back to false.
 * `recordThread` answers `no-binding` (writing nothing) when there is no
 * binding, and `reconnected` (writing nothing) for an outsider's turn whose
 * `runAs` no longer connects the channel. A member's turn adds its
 * `speakerNames` to the thread's (TASK-1146): the union, each name once at
 * the place it was last seen, oldest first, the THREAD_SPEAKER_NAMES_MAX
 * most recent kept; an outsider's turn adds none, whatever it was handed.
 * `removeForAgent` takes the agent's threads too; nothing else does.
 * A binding's memory notice (TASK-1203): `claimNotice` answers a stamp only
 * for an existing binding of the named agent not claimed yet, and claims it
 * (each stamp new: `claim-1`, `claim-2`, …), else null; `releaseNotice`
 * gives back only the named agent's claim, and only when it names that
 * claim's stamp (review F7); a reconnect keeps
 * a claim, and a binding removed (`remove`, `removeForAgent`) takes its
 * claim with it, so a binding made again claims again.
 *
 * Each new binding is one second younger than the one before, so "oldest
 * first" never hangs on a clock. `calls` records every method, in order.
 */
export function memoryChannelStore() {
  const rows = new Map<string, ChannelBinding>();
  /** The thread map, by conversation id. */
  const threads = new Map<string, ChannelThread>();
  /** The bindings whose memory notice is claimed (TASK-1203), by `${installId}/${channelId}`, to the claim's stamp. */
  const notices = new Map<string, string>();
  let claims = 0;
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
      // A new binding: never told, whatever a test left behind.
      notices.delete(at);
      rows.set(at, {
        installId: b.installId,
        channelId: b.channelId,
        agentId: b.agentId,
        connectedByUserId: b.connectedByUserId,
        channelName,
        createdAt: new Date(created),
      });
      return 'connected';
    },
    async remove(installId, channelId, agentId) {
      calls.push('remove');
      const at = key(installId, channelId);
      if (rows.get(at)?.agentId !== agentId) return false;
      rows.delete(at);
      notices.delete(at);
      return true;
    },
    async claimNotice(installId, channelId, agentId) {
      calls.push('claimNotice');
      const at = key(installId, channelId);
      if (rows.get(at)?.agentId !== agentId || notices.has(at)) return null;
      claims += 1;
      const stamp = `claim-${claims}`;
      notices.set(at, stamp);
      return stamp;
    },
    async releaseNotice(installId, channelId, agentId, claimed) {
      calls.push('releaseNotice');
      const at = key(installId, channelId);
      if (rows.get(at)?.agentId === agentId && notices.get(at) === claimed) notices.delete(at);
    },
    async removeForAgent(agentId) {
      calls.push('removeForAgent');
      let removed = 0;
      for (const [at, row] of rows) {
        if (row.agentId !== agentId) continue;
        rows.delete(at);
        notices.delete(at);
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
      const external = t.mode !== 'attended';
      if (external && binding.connectedByUserId !== (t.mode === 'external' ? t.runAs : undefined)) return 'reconnected';
      const turnNames = t.mode === 'attended' ? t.speakerNames : [];
      const known = threads.get(t.conversationId);
      threads.set(
        t.conversationId,
        known === undefined
          ? {
              installId: t.installId,
              channelId: t.channelId,
              agentId: t.agentId,
              notRemembered: false,
              external,
              speakerNames: mostRecentNames(turnNames),
            }
          : {
              ...known,
              external: known.external || external,
              speakerNames: mostRecentNames([...known.speakerNames, ...turnNames]),
            },
      );
      return 'recorded';
    },
    async getThread(conversationId) {
      calls.push('getThread');
      const known = threads.get(conversationId);
      return known === undefined ? null : { ...known, speakerNames: [...known.speakerNames] };
    },
  };

  /** The binding as stored, without going through the store (no call recorded). */
  const row = (installId: string, channelId: string): ChannelBinding | undefined => {
    const found = rows.get(key(installId, channelId));
    return found === undefined ? undefined : copy(found);
  };

  return { store, rows, threads, notices, calls, row };
}

/** The real store's rule for a thread's names: each once at the place it was last seen, the most recent kept. */
function mostRecentNames(names: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = names.length - 1; i >= 0 && kept.length < THREAD_SPEAKER_NAMES_MAX; i -= 1) {
    const name = names[i]!;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept.reverse();
}
