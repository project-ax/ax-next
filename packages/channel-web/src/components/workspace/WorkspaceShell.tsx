/**
 * The agent workspace — the shell.
 *
 * Mounted at `/workspace` behind the `agentWorkspacePreview` feature flag, on
 * the real host: `App.tsx` supplies the signed-in user, `/api/workspace/*`
 * supplies the board, and sending a message goes to the shipped chat wire.
 *
 * The demo strip that used to sit along the top — three canned scenarios and a
 * global stop — went with the mock backend it drove. So did the "New agent"
 * view. What is left renders what the host actually reports, and shows an
 * honest empty state everywhere the host has nothing yet. A surface with three
 * convincing fake panels is worse than one with three honest empty ones,
 * because only the second tells you what still has to be built.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/lib/workspace-api';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { hydrateTheme } from '@/lib/theme';
import { ActivityFeed } from './ActivityFeed';
import { AgentView, type AgentTab } from './AgentView';
import { HomeComposer } from './HomeComposer';
import { TodayView } from './TodayView';
import { Segmented, WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';

type Route =
  | { kind: 'today' }
  | { kind: 'activity' }
  | { kind: 'agent'; id: string; tab: AgentTab };

/** "Friday, August 21" — the date the queue is describing. */
function today(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <Inner />
    </WorkspaceProvider>
  );
}

function Inner() {
  const { board, error, loading, refresh } = useWorkspace();
  const [route, setRoute] = useState<Route>({ kind: 'today' });
  const [filter, setFilter] = useState<'needs' | 'working'>('needs');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(true);
  const [version, setVersion] = useState(0);
  /**
   * A turn the home composer started. `AgentView` picks it up on mount and
   * streams the reply, so the message the user typed on Today does not vanish
   * on the way to the agent's tab.
   */
  const [pendingReply, setPendingReply] = useState<{
    agentId: string;
    reqId: string;
    text: string;
  } | null>(null);

  useEffect(() => {
    hydrateTheme();
  }, []);

  const bump = () => setVersion((v) => v + 1);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6">
        <div className="flex max-w-[440px] flex-col items-center gap-4 text-center">
          <h1 className="text-[17px] font-medium">
            We could not load your workspace.
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The server did not answer when we asked what your agents are up to.
            It is usually a blip. Nothing is lost — your agents keep whatever
            they were doing, and this page only reads.
          </p>
          <Button onClick={() => void refresh()}>Try again</Button>
          <p className="font-mono text-[11.5px] text-muted-foreground">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (loading && !board) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-[13px] text-muted-foreground">
        Loading your workspace…
      </div>
    );
  }

  if (!board) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-[13px] text-muted-foreground">
        We have nothing to show yet.
      </div>
    );
  }

  const pending = board.decisions.filter(
    (d) => d.status === 'pending' || d.status === 'stale',
  ).length;
  const workingCount = board.agents.filter((a) => a.state === 'working').length;

  const openAgent = (id: string) =>
    setRoute({ kind: 'agent', id, tab: 'chat' });

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar
          agents={board.agents}
          route={route.kind}
          activeAgentId={route.kind === 'agent' ? route.id : null}
          pendingCount={pending}
          rosterOpen={rosterOpen}
          onRoster={setRosterOpen}
          onToday={() => setRoute({ kind: 'today' })}
          onActivity={() => setRoute({ kind: 'activity' })}
          onAgent={openAgent}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {route.kind === 'today' && (
            <>
              <WorkspaceHeader title="Today" subtitle={today()}>
                <Segmented
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: 'needs', label: 'Needs you', count: pending },
                    { value: 'working', label: 'Working', count: workingCount },
                  ]}
                />
              </WorkspaceHeader>
              <div className="flex-1 overflow-y-auto">
                {/*
                  No onApprove/onDismiss/onUndo: `/api/workspace/state` returns
                  `decisions: []` and nothing serves the three actions yet, so
                  TodayView renders no decision rows at all. AW-11 supplies both
                  halves together.
                */}
                <TodayView
                  decisions={board.decisions}
                  agents={board.agents}
                  filter={filter}
                  expandedId={expandedId}
                  onExpand={setExpandedId}
                  onOpenAgent={openAgent}
                  onSeeActivity={() => setRoute({ kind: 'activity' })}
                />
              </div>
              <HomeComposer
                agents={board.agents}
                onSend={async (agentId, text) => {
                  const { reqId } = await workspaceApi.sendMessage({
                    agentId,
                    conversationId: null,
                    text,
                  });
                  setPendingReply({ agentId, reqId, text });
                  setRoute({ kind: 'agent', id: agentId, tab: 'chat' });
                }}
              />
            </>
          )}

          {route.kind === 'activity' && (
            <>
              <WorkspaceHeader
                title="Activity"
                subtitle={`${board.activity.length} entries`}
              />
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[900px] px-6 pb-6">
                  <ActivityFeed
                    events={board.activity}
                    agents={board.agents}
                    onOpenAgent={openAgent}
                  />
                </div>
              </div>
            </>
          )}

          {route.kind === 'agent' && (
            <AgentView
              agentId={route.id}
              tab={route.tab}
              onTab={(t) => setRoute({ ...route, tab: t })}
              decisions={board.decisions}
              activity={board.activity}
              agents={board.agents}
              onBack={() => setRoute({ kind: 'today' })}
              version={version}
              pendingReply={
                pendingReply && pendingReply.agentId === route.id
                  ? { reqId: pendingReply.reqId, text: pendingReply.text }
                  : null
              }
              onPendingReplyConsumed={() => setPendingReply(null)}
              onChanged={async () => {
                await refresh();
                bump();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
