/**
 * TeamList — read-only placeholder for the admin teams view.
 *
 * Hits `GET /api/admin/teams` so we know the wire is alive, then renders a
 * simple list of seeded teams + a member count. Team management proper
 * (create / invite / membership) lands with the Week 9.5 multi-tenant slice
 * — see `docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md`.
 *
 * The deferred-feature note exists so a curious admin clicking around
 * doesn't think the panel is broken — it isn't, we just haven't shipped
 * the editor yet.
 */
import { useEffect, useState } from 'react';
import { listTeams } from '../../lib/admin';
import type { Team } from '../../../mock/admin/teams';
import { RoleCard } from './RoleCard';

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

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">Teams</h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Read-only. Team management (create / invite / membership) ships with
          Week&nbsp;9.5 multi-tenant — see{' '}
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md
          </code>
          .
        </p>
      </div>

      {error && (
        <div role="alert" className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive">
          {error}
        </div>
      )}

      {teams === null && !error && (
        <div className="text-sm text-muted-foreground">Loading teams…</div>
      )}

      {teams !== null && teams.length === 0 && (
        <div className="text-sm text-muted-foreground">No teams yet.</div>
      )}

      <div className="flex flex-col gap-3.5">
        {teams?.map((t) => (
          <RoleCard
            key={t.id}
            pill="team"
            title={t.name}
            caption={`${t.members.length} ${t.members.length === 1 ? 'member' : 'members'}`}
          >
            <span aria-hidden="true" />
          </RoleCard>
        ))}
      </div>
    </div>
  );
}
