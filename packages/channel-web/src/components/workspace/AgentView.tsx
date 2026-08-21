/**
 * One agent: its current conversation, what it did, what it wrote, what it
 * remembers — plus the rail.
 *
 * The agent is the object you navigate to, and the conversation is one of its
 * properties. That inversion is the whole point of the refresh: chat stops
 * being the noun.
 */
import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowRight, ChevronLeft, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { workspaceApi, type AgentDetail, type Decision } from '@/lib/workspace-api';
import { ActivityFeed } from './ActivityFeed';
import { AgentConversation } from './AgentConversation';
import { AgentFiles } from './AgentFiles';
import { AgentMemory } from './AgentMemory';
import { AgentRail } from './AgentRail';
import { AgentStateLabel, AgentTile } from './bits';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';

export type AgentTab = 'chat' | 'did' | 'files' | 'memory';

interface Props {
  agentId: string;
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  decisions: Decision[];
  activity: ActivityEvent[];
  agents: WorkspaceAgent[];
  onBack: () => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  /** Bumped by the shell whenever the board changes, to re-pull detail. */
  version: number;
  onChanged: () => void;
}

export function AgentView({
  agentId,
  tab,
  onTab,
  decisions,
  activity,
  agents,
  onBack,
  onApprove,
  onDismiss,
  onUndo,
  version,
  onChanged,
}: Props) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [pastId, setPastId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDetail(await workspaceApi.agent(agentId));
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    setPastId(null);
  }, [agentId]);

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        loading…
      </div>
    );
  }

  const { agent } = detail;
  const past = detail.past.find((p) => p.id === pastId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-6 pt-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ChevronLeft size={16} />
          </Button>
          <AgentTile agent={agent} size={30} />
          <div>
            <div className="flex items-center gap-2.5">
              <span className="text-[15px] font-medium">{agent.name}</span>
              <AgentStateLabel agent={agent} />
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              {agent.role}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto gap-1.5"
            onClick={async () => {
              await workspaceApi.pause(agent.id, !agent.paused);
              onChanged();
              await load();
            }}
          >
            {agent.paused ? <Play size={12} /> : <Pause size={12} />}
            {agent.paused ? 'Resume' : 'Pause'}
          </Button>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => onTab(v as AgentTab)}
          className="mt-3"
        >
          <TabsList className="h-auto bg-transparent p-0">
            {(
              [
                ['chat', 'Conversation'],
                ['did', 'What it did'],
                ['files', 'Files'],
                ['memory', 'Memory'],
              ] as const
            ).map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-0 text-[13px] text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none [&:not(:first-child)]:ml-6"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === 'chat' && (
            <>
              {past && (
                <div className="flex items-center gap-2.5 border-b border-border bg-muted px-6 py-2.5">
                  <Archive size={13} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
                    {past.title} · {past.meta} · read-only
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPastId(null)}
                    className="h-7 gap-1.5 text-[12px] text-primary"
                  >
                    Back to current
                    <ArrowRight size={11} />
                  </Button>
                </div>
              )}
              <AgentConversation
                agent={agent}
                thread={
                  past
                    ? [
                        {
                          kind: 'fold',
                          id: 'past-fold',
                          text: `Earlier turns were summarised into memory · ${past.folded} messages folded`,
                        },
                        ...past.msgs,
                      ]
                    : detail.thread
                }
                decisions={decisions}
                suggestions={detail.suggestions}
                readOnly={past !== null}
                onSend={async (text) => {
                  await workspaceApi.send(agent.id, text);
                  await load();
                }}
                onApprove={onApprove}
                onDismiss={onDismiss}
                onUndo={onUndo}
              />
            </>
          )}

          {tab === 'did' && (
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <ActivityFeed
                events={activity}
                agents={agents}
                agentId={agent.id}
              />
            </div>
          )}

          {tab === 'files' && (
            <AgentFiles files={detail.files} agentName={agent.name} />
          )}

          {tab === 'memory' && (
            <AgentMemory
              docs={detail.memory}
              agentName={agent.name}
              onSave={async (name, body) => {
                await workspaceApi.saveMemory(agent.id, name, body);
                await load();
              }}
            />
          )}
        </div>

        {tab === 'chat' && (
          <AgentRail
            detail={detail}
            openPastId={pastId}
            onOpenPast={setPastId}
          />
        )}
      </div>
    </div>
  );
}
