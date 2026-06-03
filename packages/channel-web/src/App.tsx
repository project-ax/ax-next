/**
 * App — bootstrap-aware, auth-gated root component.
 *
 * Boot flow:
 *   1. `loading` — fetch `/admin/bootstrap-status` first.
 *   2. If status is pending/claimed/uninitialized:
 *        - on `/setup*` → render `<SetupWizard />`
 *        - elsewhere   → `window.location.replace('/setup')` (avoids
 *          trapping a fresh-install user on the sign-in screen they
 *          can't satisfy because no auth provider is configured yet)
 *   3. If status is completed:
 *        - on `/setup*` → `window.location.replace('/')` (the wizard's
 *          POST routes already 410 after completion; redirect rather
 *          than show a dead form)
 *        - elsewhere   → fetch `/admin/me`, then render `<LoginPage />`
 *          or `<AppContent />`.
 *
 * Global keyboard shortcuts (⌘\, ⌘N) live inside `<AppContent>` so they
 * only bind once the user is signed in. Unauthenticated state can't
 * accidentally trigger a session create against an unknown user.
 *
 * Per-test-file note: components in `components/` render in isolation and
 * bypass the gate. Only `App.tsx` is gated; downstream tests don't need
 * to mock the bootstrap or auth wire.
 */
import { useEffect, useState } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/runtime';
import { getSession, type AuthUser } from './lib/auth';
import { fetchBootstrapStatus, type BootstrapStatus } from './lib/bootstrap-status';
import {
  hydrateSidebarCollapsed,
  setSidebarCollapsed,
  setSidebarOpen,
  useSidebarOpen,
} from './lib/sidebar-collapse';
import { hydrateTheme } from './lib/theme';
import { useAgentStore } from './lib/agent-store';
import { shouldShowAgentBootstrap } from './lib/agent-bootstrap-gate';
import { sessionStoreActions } from './lib/session-store';
import { bootstrapKickoff } from './lib/bootstrap-kickoff';
import { useTitleEvents } from './lib/use-title-events';
import { useHydrateAgents } from './components/AgentChip';
import { FirstRunAutoCreate } from './components/onboard/FirstRunAutoCreate';
import { NewAgentDialog } from './components/onboard/NewAgentDialog';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { SessionHeader } from './components/SessionHeader';
import { Thread } from './components/Thread';
import { ToastStack } from './components/Toast';
import { AdminShell } from './components/admin/AdminShell';
import { RoutinesPanel } from './components/routines/RoutinesPanel';
import { SetupWizard } from './components/setup/SetupWizard';
import { UserProvider } from './lib/user-context';

type AppMode =
  | { kind: 'loading' }
  | { kind: 'wizard' }
  | { kind: 'authenticated'; user: AuthUser }
  | { kind: 'unauthenticated' };

function isSetupPath(): boolean {
  const p = window.location.pathname;
  return p === '/setup' || p.startsWith('/setup/');
}

export const App = () => {
  const [mode, setMode] = useState<AppMode>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Defensive: lib/bootstrap-status.ts already swallows network and
      // parse errors, but a future refactor could let one escape. A
      // throw here would leave the SPA stuck on "connecting…" forever
      // — same posture as the getSession() try/catch below.
      let status: BootstrapStatus;
      try {
        status = await fetchBootstrapStatus();
      } catch {
        status = 'completed';
      }
      if (cancelled) return;

      const onSetup = isSetupPath();

      if (status !== 'completed') {
        if (!onSetup) {
          window.location.replace('/setup');
          return;
        }
        setMode({ kind: 'wizard' });
        return;
      }

      // status === 'completed'
      if (onSetup) {
        window.location.replace('/');
        return;
      }

      try {
        const session = await getSession();
        if (cancelled) return;
        if (session?.user) {
          setMode({ kind: 'authenticated', user: session.user });
        } else {
          setMode({ kind: 'unauthenticated' });
        }
      } catch {
        // Network/DNS/offline — treat as unauthenticated so the user
        // sees the sign-in CTA instead of "connecting…" forever.
        if (!cancelled) setMode({ kind: 'unauthenticated' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (mode.kind === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen text-muted-foreground font-mono text-xs tracking-[0.04em]">
        connecting…
      </div>
    );
  }
  if (mode.kind === 'wizard') {
    return <SetupWizard />;
  }
  if (mode.kind === 'unauthenticated') {
    return <LoginPage />;
  }
  return <AppContent user={mode.user} />;
};

const AppContent = ({ user }: { user: AuthUser }) => {
  useTitleEvents();
  useHydrateAgents(); // lifted from SessionHeader so the first-run gate can read the result
  const { agents, agentsStatus, selectedAgentId, pendingAgentId } = useAgentStore();
  const runtime = useAxChatRuntime(user.id);
  // `adminSettingsOpen` is set by the user menu's "Settings" entry
  // (admin-gated). AdminSettings renders in the main pane when true.
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  // `routinesOpen` is set by the user menu's "Routines" entry. Available
  // to every signed-in user — server-side scopes routines to caller's
  // owned/shared agents.
  const [routinesOpen, setRoutinesOpen] = useState(false);
  // `createAgentOpen` drives the explicit "+ New agent" entry into the
  // bootstrap flow (the first-run gate below uses the empty-list signal).
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  // `bootstrapAgentName` holds the name the user enters in the NewAgentDialog
  // before the bootstrap starts. null = dialog not yet submitted.
  const [bootstrapAgentName, setBootstrapAgentName] = useState<string | null>(null);
  // Mobile slide-over open state (Task 27). Used to render the scrim
  // that closes the sidebar on tap. Desktop CSS hides the scrim.
  const sidebarOpen = useSidebarOpen();

  useEffect(() => {
    // Apply persisted sidebar + theme state before first paint of any subscriber.
    hydrateSidebarCollapsed();
    hydrateTheme();

    // Global keyboard shortcuts:
    //  - ⌘\ (or Ctrl+\) toggles the sidebar. (Ctrl+\ has no browser
    //    conflict so we honor it cross-platform.)
    //  - ⌘N creates a new session for the active agent. We deliberately
    //    don't bind Ctrl+N: most browsers refuse to let preventDefault
    //    cancel "open new window" on that combo, so binding it just
    //    creates a confusing race where sometimes the shortcut wins and
    //    sometimes a new window opens.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        setSidebarCollapsed(!collapsed);
        return;
      }
      if (e.metaKey && (e.key === 'n' || e.key === 'N')) {
        const activeAgentId =
          pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;
        if (!activeAgentId) return;
        e.preventDefault();
        try {
          // Drive assistant-ui to a fresh thread first so the chat pane
          // clears (welcome empty state). Without this the chat keeps
          // showing the previous thread until the next message lands.
          runtime.threads.switchToNewThread();
        } catch (err) {
          console.warn('[app] ⌘N switchToNewThread failed', err);
        }
        void sessionStoreActions
          .createAndActivate(activeAgentId)
          .catch((err) => {
            console.warn('[app] ⌘N create failed', err);
          });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agents, selectedAgentId, pendingAgentId, runtime]);

  if (agentsStatus === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen text-muted-foreground font-mono text-xs tracking-[0.04em]">
        loading your agents…
      </div>
    );
  }

  // First-run (no personal agent yet) OR the explicit "+ New agent…" entry.
  // 'error' deliberately falls through to the chat shell — a transient blip
  // must not force an existing user into the create flow; "+ New agent…"
  // remains available from the agent menu.
  //
  // Two-phase bootstrap:
  //   Phase 1 (bootstrapAgentName === null): show NewAgentDialog so the user
  //     picks a name before anything is created. For first-run the dialog is
  //     non-dismissible (Escape / outside click is ignored — they must create
  //     an agent). For the explicit "New agent…" path the dialog can be
  //     cancelled, which closes the gate.
  //   Phase 2 (bootstrapAgentName !== null): auto-create with the chosen name
  //     and drop into the bootstrap chat.
  if (shouldShowAgentBootstrap({ agentsStatus, agentCount: agents.length, createAgentOpen })) {
    const isFirstRun = agents.length === 0 && !createAgentOpen;
    if (bootstrapAgentName === null) {
      return (
        <UserProvider value={user}>
          <NewAgentDialog
            open={true}
            onOpenChange={(open) => {
              if (!open && !isFirstRun) {
                // Explicit "New agent…" path — allow cancel
                setCreateAgentOpen(false);
              }
              // First-run: ignore close attempts — the user must create an agent
            }}
            onCreate={(name) => setBootstrapAgentName(name)}
          />
          <ToastStack />
        </UserProvider>
      );
    }
    return (
      <UserProvider value={user}>
        <FirstRunAutoCreate
          agentName={bootstrapAgentName}
          onDone={() => {
            setCreateAgentOpen(false);
            setBootstrapAgentName(null);
            bootstrapKickoff.trigger();
          }}
        />
        <ToastStack />
      </UserProvider>
    );
  }

  return (
    <UserProvider value={user}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="flex h-screen bg-background text-foreground font-sans">
          {adminSettingsOpen ? (
            <AdminShell
              isAdmin={user.role === 'admin'}
              onClose={() => setAdminSettingsOpen(false)}
            />
          ) : (
            <>
              <Sidebar
                onOpenAdminSettings={() => setAdminSettingsOpen(true)}
                onOpenRoutines={() => setRoutinesOpen(true)}
              />
              {sidebarOpen && (
                <div
                  className="hidden max-[720px]:block fixed inset-0 bg-black/40 z-40"
                  onClick={() => setSidebarOpen(false)}
                  aria-hidden="true"
                />
              )}
              <main className="flex flex-1 flex-col min-w-0 min-h-0 h-full">
                <SessionHeader onCreateAgent={() => { setBootstrapAgentName(null); setCreateAgentOpen(true); }} />
                <Thread />
              </main>
            </>
          )}
          <RoutinesPanel
            open={routinesOpen}
            onClose={() => setRoutinesOpen(false)}
            isAdmin={user.role === 'admin'}
          />
          <ToastStack />
        </div>
      </AssistantRuntimeProvider>
    </UserProvider>
  );
};
