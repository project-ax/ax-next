// ---------------------------------------------------------------------------
// "Which agent did this person use most recently?" — one definition, shared by
// `POST /api/workspace/route` (who should hear what I typed) and
// `GET /api/workspace/projects/owner-candidates` (who owns a new project,
// W3 §15 Q5). Pure, so both callers rank by exactly the same clock.
// ---------------------------------------------------------------------------

/** The subset of a conversation row recency reads. */
export interface RecencyRow {
  agentId: string;
  lastActivityAt?: string | null;
  createdAt: string;
}

/** The instant a conversation was last touched, as a sortable epoch ms (0 if unreadable). */
export function activityStamp(c: Pick<RecencyRow, 'lastActivityAt' | 'createdAt'>): number {
  const raw = c.lastActivityAt ?? c.createdAt;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/** agentId → the newest activity stamp over that agent's conversations. */
export function latestActivityByAgent(rows: readonly RecencyRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const t = activityStamp(r);
    if (t > (out.get(r.agentId) ?? 0)) out.set(r.agentId, t);
  }
  return out;
}

/** An agent's creation instant, whatever shape the bus handed us (a `Date` in-process). */
export function createdStamp(raw: unknown): number {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? 0 : raw.getTime();
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Most recently used first. Agents with no conversations sort after every
 * used one, newest-created first; ties break on display name, then id, so the
 * same input always gives the same order.
 */
export function rankByRecentUse<A extends { id: string; displayName: string; createdAt?: unknown }>(
  agents: readonly A[],
  latest: ReadonlyMap<string, number>,
): A[] {
  return [...agents].sort((x, y) => {
    const lx = latest.get(x.id) ?? 0;
    const ly = latest.get(y.id) ?? 0;
    if (lx !== ly) return ly - lx;
    if (lx === 0) {
      const cx = createdStamp(x.createdAt);
      const cy = createdStamp(y.createdAt);
      if (cx !== cy) return cy - cx;
    }
    return x.displayName.localeCompare(y.displayName) || x.id.localeCompare(y.id);
  });
}
