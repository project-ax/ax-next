/**
 * TeamList — read-only placeholder for the admin teams view.
 *
 * Hits `GET /admin/teams` so we know the wire is alive, then renders the
 * teams the caller belongs to, by `displayName`. There is no member count:
 * the list route carries no member list (members are the team-admin-gated
 * `GET /admin/teams/:id/members`), and TASK-571 found this card reading a
 * `members` field that never existed — it threw on the first real team.
 * Team management proper
 * (create / invite / membership) lands with the Week 9.5 multi-tenant slice
 * — see `docs/plans/2026-04-24-week-9.5-multi-tenant-handoff.md`.
 *
 * The deferred-feature note exists so a curious admin clicking around
 * doesn't think the panel is broken — it isn't, we just haven't shipped
 * the editor yet.
 */
import { useEffect, useState } from 'react';
import { listTeams, type Team } from '../../lib/admin';
import { PaneStatus } from '../PaneStatus';
import { SettingsRow } from '../settings/SettingsLayout';

/**
 * When the team was created, in the reader's own locale — the one fact on the
 * wire that means something to a person. An unparseable timestamp says
 * nothing rather than "Invalid Date".
 */
function teamCaption(t: Team): string {
  const created = new Date(t.createdAt);
  if (Number.isNaN(created.getTime())) return '';
  return `Created ${created.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
}

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
    <div className="font-sans">
      <p className="mb-6 text-sm text-muted-foreground">Teams are view-only for now.</p>

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

      <div className="flex flex-col">
        {teams?.map((t) => <SettingsRow key={t.id} label={t.displayName} detail={teamCaption(t)} />)}
      </div>
    </div>
  );
}
