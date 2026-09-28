/**
 * What memory has picked up from ONE conversation, kept live — the state
 * behind the rail's "What I learned in this chat" block (TASK-627).
 *
 * Two reads, one list:
 *
 *   - the FEED, `recallMemory({ conversationId })` — the rows, with their
 *     text, that this person may see (owner-scoped even on a team agent);
 *   - the STREAM, `memoryEvents(conversationId)` — between-turn signals
 *     (extracting / recorded / paused / failed) carrying ids only.
 *
 * A `recorded` frame is a cue to re-read the feed, never a row by itself.
 * Whatever the re-read has that the list does not is one BATCH: it goes on
 * top, counts as unseen, and is announced once.
 *
 * WHY THIS IS A HOOK THAT `AgentView` OWNS, and not state inside the rail:
 * below `md` the rail is a `Sheet`, and its content is unmounted while the
 * sheet is shut. The "N new" count on the rail toggle and the announcement
 * both have to work exactly then, so the stream cannot live in that tree.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workspaceApi,
  type FactMemoryStatement,
  type MemoryEventFrame,
} from './workspace-api';

/** One listed memory, and which read brought it in. */
export interface LearnedRow {
  row: FactMemoryStatement;
  /** 0 = the first read. Every later batch counts up from 1. */
  batch: number;
  /** When a live batch landed (`Date.now()`); null for the first read. */
  arrivedAt: number | null;
}

export type LearnedStatus =
  /** This workspace does not run facts memory (or the stream said 503). */
  | 'not-enabled'
  | 'loading'
  /** The list could not be read, or the live stream would not open. */
  | 'read-failed'
  | 'ready';

export interface ConversationMemory {
  status: LearnedStatus;
  /** Newest batch first. */
  rows: LearnedRow[];
  extraction: 'ok' | 'paused';
  pass: 'idle' | 'extracting' | 'failed';
  /** Rows from live batches the person has not had on screen yet. */
  unseen: number;
  /** The latest batch's sentence; `seq` changes with every batch. */
  announcement: { text: string; seq: number } | null;
  markSeen: () => void;
  /** Start over: re-read the list and re-open the stream. */
  retry: () => void;
  /**
   * Keep a row listed whatever the feed says next — a row mid-Forget (its
   * receipt is drawn in its place), or one a Fix replaced (the fixed row is
   * a person's write with no conversation, so the feed no longer has it).
   */
  pin: (id: string) => void;
  /** Swap a row for its fixed version, in place, and keep it listed. */
  replaceRow: (oldId: string, next: FactMemoryStatement) => void;
  /** Take a row off the list (a Forget whose receipt has run out). */
  removeRow: (id: string) => void;
}

/** First reconnect delay after the stream ends; doubles up to the cap. */
export const RECONNECT_BASE_MS = 2_000;
const RECONNECT_CAP_MS = 30_000;

function newestFirst(a: FactMemoryStatement, b: FactMemoryStatement): number {
  return b.when.localeCompare(a.when);
}

export function useConversationMemory({
  agentId,
  conversationId,
  enabled,
  announce,
}: {
  agentId: string;
  conversationId: string | null;
  /** False when this workspace has no facts memory at all. */
  enabled: boolean;
  /** Builds the batch sentence — the words live in `memory-copy.ts`. */
  announce: (count: number) => string;
}): ConversationMemory {
  const [status, setStatus] = useState<LearnedStatus>(enabled ? 'loading' : 'not-enabled');
  const [rows, setRowsState] = useState<LearnedRow[]>([]);
  const [extraction, setExtraction] = useState<'ok' | 'paused'>('ok');
  const [pass, setPass] = useState<'idle' | 'extracting' | 'failed'>('idle');
  const [unseen, setUnseen] = useState(0);
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The list is reconciled against itself on every re-read, so it lives in a
  // ref as well; `setRows` keeps the two in step.
  const rowsRef = useRef<LearnedRow[]>([]);
  const pinned = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const batchSeq = useRef(0);
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const setRows = useCallback((next: LearnedRow[]) => {
    rowsRef.current = next;
    setRowsState(next);
  }, []);

  useEffect(() => {
    setRows([]);
    setUnseen(0);
    setAnnouncement(null);
    setExtraction('ok');
    setPass('idle');
    pinned.current = new Set();
    removed.current = new Set();
    batchSeq.current = 0;
    if (!enabled) {
      setStatus('not-enabled');
      return;
    }
    if (conversationId === null) {
      // Nothing said yet, so nothing learned yet: an honest empty list.
      setStatus('ready');
      return;
    }
    setStatus('loading');

    const abort = new AbortController();
    let live = true;
    const alive = () => live && !abort.signal.aborted;

    /** Re-reads are serialized: two at once would count one batch twice. */
    let chain: Promise<boolean> = Promise.resolve(true);
    const reread = (asBatch: boolean): Promise<boolean> => {
      chain = chain.then(async () => {
        if (!alive()) return false;
        let statements: FactMemoryStatement[];
        try {
          const page = await workspaceApi.recallMemory(agentId, { conversationId });
          statements = page.statements;
        } catch (e) {
          if (!alive()) return false;
          console.warn('[workspace] conversation memory read failed', e);
          setStatus('read-failed');
          return false;
        }
        if (!alive()) return false;
        const fetched = statements.filter((s) => !removed.current.has(s.id));
        const byId = new Map(fetched.map((s) => [s.id, s]));
        const current = rowsRef.current;
        const known = new Set(current.map((r) => r.row.id));
        // Keep what is still there (with its latest text), and what is pinned.
        const kept = current
          .filter((r) => byId.has(r.row.id) || pinned.current.has(r.row.id))
          .map((r) => {
            const latest = byId.get(r.row.id);
            return latest === undefined ? r : { ...r, row: latest };
          });
        const fresh = fetched.filter((s) => !known.has(s.id)).sort(newestFirst);
        // Any whole read makes the list whole again, including after a
        // re-read that failed in between.
        setStatus('ready');
        if (!asBatch) {
          setRows([...kept, ...fresh.map((row) => ({ row, batch: 0, arrivedAt: null }))]);
          return true;
        }
        if (fresh.length === 0) {
          setRows(kept);
          return true;
        }
        batchSeq.current += 1;
        const batch = batchSeq.current;
        const at = Date.now();
        setRows([...fresh.map((row) => ({ row, batch, arrivedAt: at })), ...kept]);
        setUnseen((n) => n + fresh.length);
        setAnnouncement({ text: announceRef.current(fresh.length), seq: batch });
        return true;
      });
      return chain;
    };

    const onFrame = (f: MemoryEventFrame) => {
      if (!alive()) return;
      if (f.kind === 'status-unknown') return; // the list is still the list
      if (f.kind === 'status') {
        setExtraction(f.extraction);
        setPass(f.conversation);
        return;
      }
      switch (f.state) {
        case 'extracting':
          setPass('extracting');
          return;
        case 'paused':
          setExtraction('paused');
          setPass('idle');
          return;
        case 'failed':
          setPass('failed');
          return;
        case 'idle':
          setPass('idle');
          return;
        case 'recorded':
          setPass('idle');
          setExtraction('ok');
          void reread(true);
          return;
      }
    };

    void (async () => {
      // A list we could not read is "unknown", and a live stream on top of
      // it would add rows to a list that is not the whole story.
      if (!(await reread(false))) return;
      let delay = RECONNECT_BASE_MS;
      let first = true;
      while (alive()) {
        if (!first) {
          // Anything recorded while we were disconnected arrives as a batch.
          if (!(await reread(true))) return;
        }
        first = false;
        const opened = Date.now();
        const end = await workspaceApi.memoryEvents(conversationId, onFrame, abort.signal);
        if (!alive() || end === 'aborted') return;
        if (end === 'unavailable') {
          setStatus('not-enabled');
          return;
        }
        if (end === 'failed') {
          setStatus('read-failed');
          return;
        }
        // A stream that stayed up a while earns a fresh backoff.
        if (Date.now() - opened > RECONNECT_CAP_MS) delay = RECONNECT_BASE_MS;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, RECONNECT_CAP_MS);
      }
    })();

    return () => {
      live = false;
      abort.abort();
    };
  }, [agentId, conversationId, enabled, attempt, setRows]);

  const markSeen = useCallback(() => setUnseen(0), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pin = useCallback((id: string) => {
    pinned.current.add(id);
  }, []);
  const replaceRow = useCallback(
    (oldId: string, next: FactMemoryStatement) => {
      pinned.current.add(next.id);
      removed.current.add(oldId);
      setRows(rowsRef.current.map((r) => (r.row.id === oldId ? { ...r, row: next } : r)));
    },
    [setRows],
  );
  const removeRow = useCallback(
    (id: string) => {
      pinned.current.delete(id);
      removed.current.add(id);
      setRows(rowsRef.current.filter((r) => r.row.id !== id));
    },
    [setRows],
  );

  return {
    status,
    rows,
    extraction,
    pass,
    unseen,
    announcement,
    markSeen,
    retry,
    pin,
    replaceRow,
    removeRow,
  };
}
