/**
 * Agent-workspace prototype — the shell.
 *
 * Dev-only surface at `/workspace`. It is real client code (shadcn primitives,
 * semantic tokens, lucide, HTTP fetches) standing on a mock backend, so the
 * path from here to the real thing is deleting `mock/workspace.ts` and pointing
 * `workspace-api.ts` at the host — not a rewrite.
 *
 * The demo strip along the top is deliberate. The three scenarios it switches
 * between are the whole reason the prototype is worth reviewing: a happy-path
 * mockup cannot answer what an approvals queue feels like when the world moved
 * underneath a decision, or when an agent halts itself at 9am.
 */
import { useEffect, useState } from 'react';
import { Moon, Sun, OctagonX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { workspaceApi, type DemoScenario } from '@/lib/workspace-api';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { hydrateTheme, setTheme, useResolvedTheme } from '@/lib/theme';
import { ActivityFeed } from './ActivityFeed';
import { AgentView, type AgentTab } from './AgentView';
import { TodayView } from './TodayView';
import { WorkspaceSidebar } from './WorkspaceSidebar';

type Route =
  | { kind: 'today' }
  | { kind: 'activity' }
  | { kind: 'agent'; id: string; tab: AgentTab };

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <Inner />
    </WorkspaceProvider>
  );
}

function Inner() {
  const { board, error, refresh, approve, dismiss, undo, stopAll, setScenario } =
    useWorkspace();
  const [route, setRoute] = useState<Route>({ kind: 'today' });
  const [filter, setFilter] = useState<'needs' | 'working'>('needs');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(true);
  const [version, setVersion] = useState(0);
  const theme = useResolvedTheme();

  useEffect(() => {
    hydrateTheme();
  }, []);

  const bump = () => setVersion((v) => v + 1);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-center text-[13.5px] text-destructive">
        The prototype backend is not answering ({error}). It only runs under
        `pnpm --filter @ax/channel-web dev` with no AX_BACKEND_URL set.
      </div>
    );
  }

  if (!board) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-[13px] text-muted-foreground">
        loading the board…
      </div>
    );
  }

  const pending = board.decisions.filter(
    (d) => d.status === 'pending' || d.status === 'stale',
  ).length;
  const stopped = board.agents.filter((a) => a.state === 'stopped').length;

  const openAgent = (id: string) =>
    setRoute({ kind: 'agent', id, tab: 'chat' });

  const act = {
    approve: async (id: string) => {
      await approve(id);
      bump();
    },
    dismiss: async (id: string) => {
      await dismiss(id);
      bump();
    },
    undo: async (id: string) => {
      await undo(id);
      bump();
    },
  };

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <DemoStrip
        scenario={board.scenario}
        stoppedAll={board.stoppedAll}
        dark={theme === 'dark'}
        onScenario={async (s) => {
          await setScenario(s);
          setRoute({ kind: 'today' });
          setExpandedId(null);
          bump();
        }}
        onStopAll={async (v) => {
          await stopAll(v);
          bump();
        }}
        onTheme={(d) => setTheme(d ? 'dark' : 'light')}
      />

      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar
          agents={board.agents}
          route={route.kind}
          activeAgentId={route.kind === 'agent' ? route.id : null}
          pendingCount={pending + stopped}
          rosterOpen={rosterOpen}
          onRoster={setRosterOpen}
          onToday={() => setRoute({ kind: 'today' })}
          onActivity={() => setRoute({ kind: 'activity' })}
          onAgent={openAgent}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {route.kind === 'today' && (
            <div className="flex-1 overflow-y-auto">
              <TodayView
                decisions={board.decisions}
                agents={board.agents}
                filter={filter}
                onFilter={setFilter}
                expandedId={expandedId}
                onExpand={setExpandedId}
                onOpenAgent={openAgent}
                onApprove={act.approve}
                onDismiss={act.dismiss}
                onUndo={act.undo}
                onRestart={async (id) => {
                  await workspaceApi.restart(id);
                  await refresh();
                  bump();
                }}
                onSeeActivity={() => setRoute({ kind: 'activity' })}
              />
            </div>
          )}

          {route.kind === 'activity' && (
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[900px] px-6 py-6">
                <h1 className="mb-5 text-[21px] font-medium tracking-[-0.02em]">
                  Activity
                </h1>
                <ActivityFeed
                  events={board.activity}
                  agents={board.agents}
                  onOpenAgent={openAgent}
                />
              </div>
            </div>
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
              onApprove={act.approve}
              onDismiss={act.dismiss}
              onUndo={act.undo}
              version={version}
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

const SCENARIOS: Array<[DemoScenario, string]> = [
  ['attended', 'Attended'],
  ['unattended', 'Unattended queue'],
  ['incident', 'Agent stopped'],
];

function DemoStrip({
  scenario,
  stoppedAll,
  dark,
  onScenario,
  onStopAll,
  onTheme,
}: {
  scenario: DemoScenario;
  stoppedAll: boolean;
  dark: boolean;
  onScenario: (s: DemoScenario) => void;
  onStopAll: (v: boolean) => void;
  onTheme: (dark: boolean) => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-muted/50 px-4">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Prototype
      </span>
      <ToggleGroup
        type="single"
        value={scenario}
        onValueChange={(v) => v && onScenario(v as DemoScenario)}
        className="gap-1"
      >
        {SCENARIOS.map(([v, label]) => (
          <ToggleGroupItem key={v} value={v} className="h-7 px-2.5 text-[12px]">
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="ml-auto flex items-center gap-2">
        {/*
          A global stop is table stakes for an autonomy product and the design
          this came from had only per-agent pause. The thing a user needs most
          at 2am is one switch.
        */}
        <Button
          variant={stoppedAll ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onStopAll(!stoppedAll)}
          className="h-7 gap-1.5 text-[12px]"
        >
          <OctagonX size={12} />
          {stoppedAll ? 'Everything is stopped — resume' : 'Stop everything'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Toggle theme"
          onClick={() => onTheme(!dark)}
        >
          {dark ? <Sun size={13} /> : <Moon size={13} />}
        </Button>
      </div>
    </div>
  );
}
