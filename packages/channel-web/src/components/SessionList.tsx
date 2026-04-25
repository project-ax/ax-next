/**
 * SessionList — fetches /api/chat/sessions, groups by local-TZ day,
 * renders inside `.sessions-scroll`.
 *
 * Re-fetches whenever the session-store's `version` counter bumps.
 * NewSessionButton + Task 14's rename/delete bump it. The version is
 * the only invalidation signal; we don't poll, we don't subscribe to
 * the mock-store JSON file. If the user opens two tabs, they'll need
 * to reload — acceptable for the dev mock.
 *
 * Day grouping uses *calendar* day comparison (not "within 24h"):
 * a session updated at 11pm yesterday and another at 1am today are
 * on different calendar days even though they're 2 hours apart. We
 * compare via `Date.toDateString()` which collapses to local-TZ day.
 *
 * Sort: newest-first by `updated_at` (the mock server already does
 * this; we re-sort defensively in case the wire shape changes).
 */
import { useEffect } from 'react';
import { useAgentStore } from '../lib/agent-store';
import {
  sessionStoreActions,
  useSessionStore,
  type SessionRow as SessionRowData,
} from '../lib/session-store';
import { SessionRow } from './SessionRow';

interface Group {
  label: 'today' | 'yesterday' | 'earlier';
  rows: SessionRowData[];
}

function groupByDay(rows: SessionRowData[]): Group[] {
  const today = new Date();
  const todayKey = today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toDateString();

  const todayRows: SessionRowData[] = [];
  const yesterdayRows: SessionRowData[] = [];
  const earlierRows: SessionRowData[] = [];

  for (const row of rows) {
    const dKey = new Date(row.updated_at).toDateString();
    if (dKey === todayKey) todayRows.push(row);
    else if (dKey === yesterdayKey) yesterdayRows.push(row);
    else earlierRows.push(row);
  }

  const groups: Group[] = [];
  if (todayRows.length) groups.push({ label: 'today', rows: todayRows });
  if (yesterdayRows.length)
    groups.push({ label: 'yesterday', rows: yesterdayRows });
  if (earlierRows.length) groups.push({ label: 'earlier', rows: earlierRows });
  return groups;
}

export function SessionList() {
  const { sessions, activeSessionId, version } = useSessionStore();
  const { agents } = useAgentStore();

  // Re-fetch on mount and on version bumps. The mock server returns
  // sessions newest-first already; we sort again defensively below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/chat/sessions', { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { sessions?: SessionRowData[] };
        if (cancelled) return;
        const rows = Array.isArray(body.sessions) ? body.sessions : [];
        sessionStoreActions.setSessions(rows);
      } catch (err) {
        console.warn('[session-list] fetch failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version]);

  const sorted = [...sessions].sort((a, b) => b.updated_at - a.updated_at);
  const groups = groupByDay(sorted);

  const handleSelect = (id: string): void => {
    // Pre-existing session: default `hasMessages` true (conservative —
    // see session-store for why). If we later track per-row metadata
    // we can refine this.
    sessionStoreActions.setActiveSession(id, true);
  };

  return (
    <>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="sessions-group-label">{g.label}</div>
          {g.rows.map((row) => {
            const agent = agents.find((a) => a.id === row.agent_id);
            const color = agent?.color ?? '#888';
            return (
              <SessionRow
                key={row.id}
                id={row.id}
                title={row.title}
                active={activeSessionId === row.id}
                agentColor={color}
                onSelect={handleSelect}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}
