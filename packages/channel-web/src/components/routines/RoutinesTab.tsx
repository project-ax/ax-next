/**
 * RoutinesTab — the Routines surface inside Settings (AdminShell).
 *
 * Every user sees their own routines (create / edit / delete + observability);
 * admins additionally get the Default Routines management section at the top,
 * mirroring how the Skills tab folds in admin curation. The server enforces the
 * same admin gate on every /admin/routines/defaults* route, so hiding the
 * section client-side is a UX nicety, not the boundary.
 *
 * Replaces the former top-of-sidebar "Routines" modal (RoutinesPanel).
 */
import { useState } from 'react';
import { RoutinesList } from './RoutinesList';
import { AgentSelfImprovementSection } from './AgentSelfImprovementSection';
import { DefaultRoutinesSection } from '@/components/admin/DefaultRoutinesSection';

export function RoutinesTab({ isAdmin }: { isAdmin: boolean }) {
  // Bumped after a Fire now call so RoutinesList re-fetches. Same refresh-key
  // idiom the modal used; create/edit/delete re-fetch on their own.
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <AgentSelfImprovementSection />
      {isAdmin && <DefaultRoutinesSection />}
      <RoutinesList refreshKey={refreshKey} onFired={() => setRefreshKey((n) => n + 1)} />
    </div>
  );
}
