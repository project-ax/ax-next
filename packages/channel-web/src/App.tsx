/**
 * App — auth-gated root component.
 *
 * Boot flow:
 *   1. `loading` — fetch `/api/auth/get-session` on mount.
 *   2. `unauthenticated` — render `<LoginPage />` (single Google CTA).
 *   3. `authenticated` — render `<AppContent />` with the assistant-ui
 *      runtime, sidebar, session header, and thread.
 *
 * Global keyboard shortcuts (⌘\, ⌘N) live inside `<AppContent>` so they
 * only bind once the user is signed in. Unauthenticated state can't
 * accidentally trigger a session create against an unknown user.
 *
 * Per-test-file note: components in `components/` render in isolation and
 * bypass the auth gate. Only `App.tsx` is gated; downstream tests don't
 * need to mock `/api/auth/*`.
 */
import { useEffect, useState } from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/runtime';
import { getSession, type AuthUser } from './lib/auth';
import {
  hydrateSidebarCollapsed,
  setSidebarCollapsed,
} from './lib/sidebar-collapse';
import { useAgentStore } from './lib/agent-store';
import { sessionStoreActions } from './lib/session-store';
import { LoginPage } from './components/LoginPage';
import { Sidebar } from './components/Sidebar';
import { SessionHeader } from './components/SessionHeader';
import { Thread } from './components/Thread';
import { AdminPanel } from './components/admin/AdminPanel';
import { UserProvider } from './lib/user-context';
import type { AdminView } from './lib/admin';

type AuthState = 'loading' | 'authenticated' | 'unauthenticated';

export const App = () => {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await getSession();
      if (cancelled) return;
      if (session?.user) {
        setUser(session.user);
        setAuthState('authenticated');
      } else {
        setAuthState('unauthenticated');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === 'loading') {
    return <div className="app-loading">connecting…</div>;
  }
  if (authState === 'unauthenticated') {
    return <LoginPage />;
  }
  return <AppContent user={user!} />;
};

const AppContent = ({ user }: { user: AuthUser }) => {
  const { agents, selectedAgentId, pendingAgentId } = useAgentStore();
  const runtime = useAxChatRuntime(undefined, undefined, user.id, undefined);
  // `adminView` is set by the user menu's Admin entries. AdminPanel
  // renders below when non-null.
  const [adminView, setAdminView] = useState<AdminView>(null);

  useEffect(() => {
    // Apply persisted sidebar state before first paint of any subscriber.
    hydrateSidebarCollapsed();

    // Global keyboard shortcuts:
    //  - ⌘\ (or Ctrl+\) toggles the sidebar.
    //  - ⌘N (or Ctrl+N) creates a new session for the active agent.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        setSidebarCollapsed(!collapsed);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        const activeAgentId =
          pendingAgentId ?? selectedAgentId ?? agents[0]?.id ?? null;
        if (!activeAgentId) return;
        e.preventDefault();
        void sessionStoreActions
          .createAndActivate(activeAgentId)
          .catch((err) => {
            console.warn('[app] ⌘N create failed', err);
          });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agents, selectedAgentId, pendingAgentId]);

  return (
    <UserProvider value={user}>
      <AssistantRuntimeProvider runtime={runtime}>
        <div className="app-layout">
          <Sidebar onOpenAdmin={setAdminView} />
          <main className="pane">
            <SessionHeader />
            <Thread />
          </main>
          <AdminPanel view={adminView} onClose={() => setAdminView(null)} />
        </div>
      </AssistantRuntimeProvider>
    </UserProvider>
  );
};
