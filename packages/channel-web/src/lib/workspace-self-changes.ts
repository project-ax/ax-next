/**
 * What an agent changed about ITSELF, for Today (TASK-990): the host's words,
 * the rows Today draws, and the read.
 *
 * The wire carries three fields (`agentId`, `section`, `changedAt`) and nothing
 * the agent wrote. Everything a person reads here is authored in this file or
 * comes from their own roster: the sentence is picked by `section`, a closed
 * set, so the model cannot word, add or hide a row.
 *
 * It is an FYI. Nothing here feeds `waitingOnYou`, the headline or the Needs
 * you count.
 */
import { useEffect, useRef, useState } from 'react';
import { workspaceApi } from './workspace-api';
import type { SelfChange, SelfChangeSection } from './workspace-types';

/** The host's sentence for each section an agent can change about itself. */
export const SELF_CHANGE_WORDS: Readonly<Record<SelfChangeSection, string>> = {
  identity: 'changed how it describes itself',
  soul: 'changed its personality',
};

export interface SelfChangeRow {
  /** Stable per (agent, section): the server keeps one item for each. */
  key: string;
  agentId: string;
  agentName: string;
  words: string;
  changedAt: string;
}

/** An unparseable instant sorts last rather than first. */
function instant(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Today's rows: newest first, each named from the roster. A change whose agent
 * the roster does not have (deleted, unshared, or the roster is not loaded yet)
 * is dropped, never drawn nameless. It does not dedupe: the server guarantees
 * one item per (agent, section).
 */
export function selfChangeRows(
  changes: readonly SelfChange[],
  agents: readonly { id: string; name: string }[],
): SelfChangeRow[] {
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const rows: SelfChangeRow[] = [];
  for (const c of changes) {
    const agentName = names.get(c.agentId);
    if (agentName === undefined) continue;
    rows.push({
      key: JSON.stringify([c.agentId, c.section]),
      agentId: c.agentId,
      agentName,
      words: SELF_CHANGE_WORDS[c.section],
      changedAt: c.changedAt,
    });
  }
  // Array#sort is stable, so equal instants keep the server's order.
  return rows.sort((a, b) => instant(b.changedAt) - instant(a.changedAt));
}

const NONE: readonly SelfChange[] = [];

/**
 * Reads `GET /api/workspace/self-changes` each time `active` becomes true (the
 * shell passes "Today is showing"). Only the newest read that is still active
 * may answer: a slow first read cannot overwrite a faster second one, and a
 * read that lands after the person left Today is dropped.
 *
 * A failed read keeps what was there and warns once. It never throws and never
 * shows an error: an absent section makes no claim, so there is nothing a
 * failure could make look false.
 */
export function useSelfChanges(active: boolean): readonly SelfChange[] {
  const [changes, setChanges] = useState<readonly SelfChange[]>(NONE);
  const latest = useRef(0);

  useEffect(() => {
    if (!active) return;
    const mine = ++latest.current;
    let current = true;
    void (async () => {
      try {
        const page = await workspaceApi.selfChanges();
        if (current && latest.current === mine) setChanges(page.changes);
      } catch (err) {
        if (current && latest.current === mine) {
          console.warn('[workspace] could not read agent self-changes', err);
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [active]);

  return changes;
}
