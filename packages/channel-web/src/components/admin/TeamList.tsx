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
import { PaneStatus } from '../PaneStatus';
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
        {/* (TASK-343 / audit D6) This paragraph showed an admin a path to a
            planning document inside our own repository — a file they cannot
            open, naming a milestone that means nothing outside this team. */}
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Team management is coming soon. For now you can see the teams that
          exist here, but not create or change them.
        </p>
      </div>

      {error && <PaneStatus variant="error">{error}</PaneStatus>}

      {teams === null && !error && (
        <PaneStatus variant="loading">Loading teams…</PaneStatus>
      )}

      {teams !== null && teams.length === 0 && (
        <PaneStatus variant="empty">
          No teams yet. Teams will let you share agents and connectors with a
          group of people at once, instead of one person at a time.
        </PaneStatus>
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
