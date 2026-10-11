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
  const [tab, setTab] = useState('mine');
  const [category, setCategory] = useState('scheduled');
  const [createRequest, setCreateRequest] = useState(0);
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
    <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList variant="quiet" aria-label="Routine views">
          <TabsTrigger variant="quiet" value="mine">My routines</TabsTrigger>
          <TabsTrigger variant="quiet" value="improvement">Self-improvement</TabsTrigger>
        </TabsList>
        {tab === 'mine' && (
          <Button onClick={() => setCreateRequest((n) => n + 1)}>New routine</Button>
        )}
      </div>
      <TabsContent value="mine" className="flex flex-col gap-5">
        <RoutineConsentSection agentId={agentId} agentName={agentName ?? 'This agent'} />
        <RoutinesList
          key={agentId}
          hideCreateAction
          createRequest={createRequest}
          agentId={agentId}
          agentName={agentName}
          refreshKey={refreshKey}
          isAdmin={isAdmin}
          onFired={refresh}
        />
      </TabsContent>
      <TabsContent value="improvement" className="flex flex-col gap-5">
        <AgentSelfImprovementSection
          agentId={agentId}
          agentName={agentName}
          onChanged={refresh}
          onViewSkills={onViewSkills}
        />
        <AgentDefaultControls agentId={agentId} onChanged={refresh} />
        <RoutinesList
          origin="default"
          agentId={agentId}
          agentName={agentName}
          refreshKey={refreshKey}
          onFired={refresh}
        />
      </TabsContent>
    </Tabs>
  );
}
