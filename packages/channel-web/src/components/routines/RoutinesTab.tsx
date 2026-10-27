import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutinesList } from './RoutinesList';
import {
  AgentSelfImprovementSection,
  AgentDefaultControls,
} from './AgentSelfImprovementSection';
import { RoutineConsentSection } from './RoutineConsentSection';
import { DefaultRoutinesSection } from '@/components/admin/DefaultRoutinesSection';

export function RoutinesTab({
  isAdmin,
  agentId,
  agentName,
  onViewSkills,
}: {
  isAdmin: boolean;
  agentId?: string | undefined;
  agentName?: string | undefined;
  onViewSkills?: (() => void) | undefined;
}) {
  const [category, setCategory] = useState('scheduled');
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((n) => n + 1);
  if (!agentId) {
    return (
      <Tabs value={category} onValueChange={setCategory} className="settings-tabs">
        <TabsList aria-label="Routine categories">
          <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
          <TabsTrigger value="self-improvement">Self-improvement</TabsTrigger>
          {isAdmin && <TabsTrigger value="defaults">Workspace defaults</TabsTrigger>}
        </TabsList>
        <TabsContent value="scheduled" forceMount hidden={category !== 'scheduled'}>
          <RoutinesList refreshKey={refreshKey} isAdmin={isAdmin} onFired={refresh} />
        </TabsContent>
        <TabsContent value="self-improvement" forceMount hidden={category !== 'self-improvement'}>
          <AgentSelfImprovementSection onChanged={refresh} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="defaults" forceMount hidden={category !== 'defaults'}>
            <DefaultRoutinesSection />
          </TabsContent>
        )}
      </Tabs>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">Scheduled work you create lives in Tasks. Housekeeping keeps this agent’s built-in maintenance running.</p>
      <Button variant="outline" className="self-start" asChild><a href="/workspace/tasks">Open Tasks</a></Button>
      <RoutineConsentSection agentId={agentId} agentName={agentName ?? 'This agent'} />
      <AgentSelfImprovementSection agentId={agentId} agentName={agentName} onChanged={refresh} onViewSkills={onViewSkills} />
      <AgentDefaultControls agentId={agentId} onChanged={refresh} />
      <RoutinesList origin="default" agentId={agentId} agentName={agentName} refreshKey={refreshKey} onFired={refresh} />
    </div>
  );
}
