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
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="flex flex-col gap-5">
      <Tabs defaultValue="mine">
        <TabsList>
          <TabsTrigger value="mine">My routines</TabsTrigger>
          <TabsTrigger value="improvement">Self-improvement</TabsTrigger>
        </TabsList>
        <TabsContent value="mine" className="flex flex-col gap-5">
          {agentId && (
            <RoutineConsentSection
              agentId={agentId}
              agentName={agentName ?? 'This agent'}
            />
          )}
          <RoutinesList
            agentId={agentId}
            agentName={agentName}
            refreshKey={refreshKey}
            isAdmin={isAdmin}
            onFired={() => setRefreshKey((n) => n + 1)}
          />
        </TabsContent>
        <TabsContent value="improvement" className="flex flex-col gap-4">
          <AgentSelfImprovementSection
            agentId={agentId}
            agentName={agentName}
          />
          {agentId && <AgentDefaultControls agentId={agentId} />}
          {agentId && onViewSkills && (
            <Button
              variant="link"
              className="w-fit px-0"
              onClick={onViewSkills}
            >
              View skills
            </Button>
          )}
        </TabsContent>
      </Tabs>
      {!agentId && isAdmin && <DefaultRoutinesSection />}
    </div>
  );
}
