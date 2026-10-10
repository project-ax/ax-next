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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useState } from 'react';
import { RoutinesList } from './RoutinesList';
import { AgentSelfImprovementSection } from './AgentSelfImprovementSection';
import { DefaultRoutinesSection } from '@/components/admin/DefaultRoutinesSection';

export function RoutinesTab({ isAdmin }: { isAdmin: boolean }) {
  // Bumped after a Fire now call so RoutinesList re-fetches. Same refresh-key
  // idiom the modal used; create/edit/delete re-fetch on their own.
  const [category, setCategory] = useState('scheduled');
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <Tabs value={category} onValueChange={setCategory} className="settings-tabs">
      <TabsList aria-label="Routine categories">
        <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
        <TabsTrigger value="self-improvement">Self-improvement</TabsTrigger>
        {isAdmin && <TabsTrigger value="defaults">Workspace defaults</TabsTrigger>}
      </TabsList>
      <TabsContent value="scheduled" forceMount hidden={category !== 'scheduled'}>
        <RoutinesList showHeaderAction={category === 'scheduled'} refreshKey={refreshKey} isAdmin={isAdmin} onFired={() => setRefreshKey((n) => n + 1)} />
      </TabsContent>
      <TabsContent value="self-improvement" forceMount hidden={category !== 'self-improvement'}><AgentSelfImprovementSection /></TabsContent>
      {isAdmin && <TabsContent value="defaults" forceMount hidden={category !== 'defaults'}><DefaultRoutinesSection /></TabsContent>}
    </Tabs>
  );
}
