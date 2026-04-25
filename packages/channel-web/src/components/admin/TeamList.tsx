/**
 * TeamList — read-only placeholder for the admin teams view (Task 24).
 *
 * Hits `GET /api/admin/teams` so we know the wire is alive, then renders
 * a simple list of seeded teams + a member count. Team management proper
 * (create / invite / membership) lands with the Week 9.5 multi-tenant
 * slice — see `docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md`.
 *
 * The deferred-feature note exists so a curious admin clicking around
 * doesn't think the panel is broken — it isn't, we just haven't shipped
 * the editor yet.
 */
import { useEffect, useState } from 'react';
import { listTeams } from '../../lib/admin';
import type { Team } from '../../../mock/admin/teams';

export function TeamList() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listTeams();
        if (!cancelled) setTeams(result);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="admin-error">{error}</div>;
  if (teams === null) return <div className="admin-empty">Loading teams…</div>;

  return (
    <div className="admin-teams">
      <p className="admin-teams-note">
        Read-only. Team management (create / invite / membership) ships with
        Week 9.5 multi-tenant — see{' '}
        <code>docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md</code>.
      </p>
      {teams.length === 0 ? (
        <div className="admin-empty">No teams yet.</div>
      ) : (
        <ul className="admin-list">
          {teams.map((t) => (
            <li key={t.id} className="admin-list-row">
              <span className="admin-list-name">{t.name}</span>
              <span className="admin-list-meta">
                {t.members.length} member{t.members.length === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
