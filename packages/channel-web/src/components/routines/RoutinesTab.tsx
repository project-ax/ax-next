import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { RoutinesList } from './RoutinesList';
import { AgentSelfImprovementSection } from './AgentSelfImprovementSection';
import { DefaultRoutinesSection } from '@/components/admin/DefaultRoutinesSection';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export function RoutinesTab({ isAdmin, agentId, agentName, onViewSkills }: {
  isAdmin: boolean; agentId?: string; agentName?: string | undefined; onViewSkills?: (() => void) | undefined;
}) {
  const [tab, setTab] = useState('mine');
  const [createRequest, setCreateRequest] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  if (!agentId) return <div className="flex flex-col gap-4">
    <AgentSelfImprovementSection />
    {isAdmin && <DefaultRoutinesSection />}
    <RoutinesList refreshKey={refreshKey} isAdmin={isAdmin} onFired={() => setRefreshKey((n) => n + 1)} />
  </div>;
  return <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
    <TabsList variant="quiet" aria-label="Routine views">
      <TabsTrigger variant="quiet" value="mine">My routines</TabsTrigger>
      <TabsTrigger variant="quiet" value="improvement">Self-improvement</TabsTrigger>
    </TabsList>
    {tab === 'mine' && <Button onClick={() => setCreateRequest(n => n + 1)}>New routine</Button>}
    </div>
    <TabsContent value="mine">
      <RoutinesList key={agentId} hideCreateAction createRequest={createRequest} agentId={agentId} agentName={agentName} refreshKey={refreshKey} isAdmin={isAdmin} onFired={() => setRefreshKey((n) => n + 1)} />
    </TabsContent>
    <TabsContent value="improvement">
      <AgentSelfImprovementSection agentId={agentId} agentName={agentName} onViewSkills={onViewSkills} />
    </TabsContent>
  </Tabs>;
}
