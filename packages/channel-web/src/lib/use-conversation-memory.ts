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
 *
 * FIXES ARE KEPT HERE TOO (TASK-643). A Fix can be saved from the rail or from
 * the "Used N memories" chip under an answer, and each surface has to show it
 * the moment it saves — the chip by saying the row changed since that answer,
 * the rail by swapping the row for its fixed form. Before this, each surface
 * kept its own overlay, so a fix from the chip left the rail showing the old
 * row until a reload. Now there is one ledger (`fixes`), written through
 * `recordFix` / `undoFix` by both surfaces, and the chip reads it through
 * `MemoryFixesContext`, which `AgentView` provides.
 */
import { createContext, useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * A saved Fix: the row it closed (`row`) and the row it wrote in its place
 * (`id`, `value`). The same shape as `MemoryCorrection`'s `MemoryFix`.
 */
export interface SavedFix {
  row: FactMemoryStatement;
  id: string;
  value: string;
}

/** What a Fix did to the row it closed, as the chip words it. */
export interface FixEntry {
  /** `retracted` = "It was never right"; `replaced` = "It changed". */
  kind: 'replaced' | 'retracted';
  /** The row written in its place. */
  id: string;
  value: string;
}

/** The fixes made on screen, and the only way to add or take one back. */
export interface MemoryFixes {
  /** Every row a Fix closed, by that row's id. */
  fixes: ReadonlyMap<string, FixEntry>;
  /** Settings Forget/Undo shares the same overlay without restarting the feed. */
  forgotten?: ReadonlySet<string> | undefined;
  recordForget?: ((row: FactMemoryStatement) => void) | undefined;
  undoForget?: ((row: FactMemoryStatement) => void) | undefined;
  recordFix: (fix: SavedFix, reason: 'changed' | 'never-right') => void;
  /** After a Fix's Undo worked: the closed row is back in effect. */
  undoFix: (fix: SavedFix) => void;
}

/**
 * The conversation's fixes, for a surface below `AgentView` (the chip). Null
 * outside it — a chip drawn on its own keeps a ledger of its own.
 */
export const MemoryFixesContext = createContext<MemoryFixes | null>(null);

/**
 * The ledger itself, with nothing else attached. `useConversationMemory`
 * builds on it; a chip with no `MemoryFixesContext` above it uses it alone.
 * It starts over whenever `resetKey` changes.
 */
export function useFixLedger(resetKey: string): MemoryFixes {
  const [fixes, setFixes] = useState<ReadonlyMap<string, FixEntry>>(() => new Map());
  const [forgotten, setForgotten] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setFixes(new Map());
    setForgotten(new Set());
  }, [resetKey]);
  const recordForget = useCallback((row: FactMemoryStatement) => {
    setForgotten((ids) => new Set(ids).add(row.id));
  }, []);
  const undoForget = useCallback((row: FactMemoryStatement) => {
    setForgotten((ids) => {
      const next = new Set(ids);
      next.delete(row.id);
      return next;
    });
  }, []);
  const recordFix = useCallback((fix: SavedFix, reason: 'changed' | 'never-right') => {
    setFixes((m) =>
      new Map(m).set(fix.row.id, {
        kind: reason === 'never-right' ? 'retracted' : 'replaced',
        id: fix.id,
        value: fix.value,
      }),
    );
  }, []);
  const undoFix = useCallback((fix: SavedFix) => {
    setFixes((m) => {
      if (!m.has(fix.row.id)) return m;
      const next = new Map(m);
      next.delete(fix.row.id);
      return next;
    });
  }, []);
  return { fixes, recordFix, undoFix, forgotten, recordForget, undoForget };
}

export interface ConversationMemory extends MemoryFixes {
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
  /**
   * Swap a row for its fixed version, in place, and keep it listed. The
   * primitive under `recordFix` / `undoFix`; a surface records a Fix through
   * those, so the other surfaces see it too.
   */
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
  /**
   * The conversation to follow. `null` = none yet (nothing said, so nothing
   * learned). `undefined` = not known yet: the block says it is checking.
   */
  conversationId: string | null | undefined;
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
  /** A listed row a Fix swapped out, by the fixed row's id — Undo puts it back. */
  const displaced = useRef(new Map<string, FactMemoryStatement>());
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
    displaced.current = new Map();
    batchSeq.current = 0;
    if (!enabled) {
      setStatus('not-enabled');
      return;
    }
    if (conversationId === undefined) {
      setStatus('loading');
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
          // Only the FIRST read can make the list unknown. A background
          // re-read that blips leaves the rows already shown exactly as true
          // as they were; hiding them behind "can't show" would throw away
          // known-good memories over a transient error. The next batch or
          // reconnect re-reads anyway.
          if (!asBatch) setStatus('read-failed');
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
          // A failed re-read here does NOT stop the loop: stream liveness is
          // not gated on one feed read, and the next recorded frame re-reads.
          await reread(true);
          if (!alive()) return;
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

  /*
    The ledger, plus what the rail does about it: a fixed row that is listed
    is swapped for its fixed form, and an Undo swaps it back. The rail's own
    copy of a row is what goes back (a chip hands in the copy the answer was
    given, which is not the feed's), so it is kept by the fixed row's id.
    The ledger lasts as long as the conversation on screen, a retry included:
    a retry re-reads the list, it does not take back a saved fix.
  */
  const ledger = useFixLedger(`${agentId}\u0000${conversationId ?? ''}`);
  const { recordFix: record, undoFix: unrecord } = ledger;
  const recordFix = useCallback(
    (fix: SavedFix, reason: 'changed' | 'never-right') => {
      record(fix, reason);
      const listed = rowsRef.current.find((r) => r.row.id === fix.row.id);
      if (listed === undefined) return;
      displaced.current.set(fix.id, listed.row);
      replaceRow(fix.row.id, { ...listed.row, id: fix.id, value: fix.value });
    },
    [record, replaceRow],
  );
  const undoFix = useCallback(
    (fix: SavedFix) => {
      unrecord(fix);
      if (!rowsRef.current.some((r) => r.row.id === fix.id)) return;
      const before = displaced.current.get(fix.id) ?? fix.row;
      displaced.current.delete(fix.id);
      replaceRow(fix.id, before);
    },
    [unrecord, replaceRow],
  );

  return {
    fixes: ledger.fixes,
    forgotten: ledger.forgotten,
    recordForget: ledger.recordForget,
    undoForget: ledger.undoForget,
    recordFix,
    undoFix,
    status,
    rows: rows.filter((r) => !ledger.forgotten?.has(r.row.id)),
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
