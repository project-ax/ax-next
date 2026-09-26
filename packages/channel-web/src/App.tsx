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
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { sessionStoreActions, useSessionStore } from './lib/session-store';
import { useSessionExpired } from './lib/session-expired-store';
import { bootstrapKickoff } from './lib/bootstrap-kickoff';
import { useTitleEvents } from './lib/use-title-events';
import { useHydrateAgents } from './components/AgentChip';
import { FirstRunAutoCreate } from './components/onboard/FirstRunAutoCreate';
import { NewAgentDialog } from './components/onboard/NewAgentDialog';
import { BootScreen } from './components/BootScreen';
import { LoginPage } from './components/LoginPage';
import { WorkspaceShell } from './components/workspace/WorkspaceShell';
import { fetchFeatures, DEFAULT_FEATURES, type Features } from './lib/features';
import { focusSettingsOpenerWhenReady } from './lib/settings-return-focus';
import { focusNewAgentOpenerWhenReady } from './lib/new-agent-return-focus';
import { Sidebar } from './components/Sidebar';
import { SessionHeader } from './components/SessionHeader';
import { Thread } from './components/Thread';
import { ToastStack } from './components/Toast';
import { AdminShell } from './components/admin/AdminShell';
import { SetupWizard } from './components/setup/SetupWizard';
import { UserProvider } from './lib/user-context';
import { consumeOAuthFullPageReturn } from './lib/oauth-full-page-return';
import { toastActions } from './lib/toast-store';
import { ErrorBoundary } from './components/ErrorBoundary';

type AppMode =
  | { kind: 'loading' }
  | { kind: 'wizard' }
  | { kind: 'authenticated'; user: AuthUser; features: Features }
  | { kind: 'unauthenticated' };

function isSetupPath(): boolean {
  const p = window.location.pathname;
  return p === '/setup' || p.startsWith('/setup/');
}

/**
 * Which paths resolve to the agent workspace — given the deployment has the
 * preview on, which is checked separately at the call site
 * (`features.agentWorkspacePreview`).
 *
 * It is a normal, gated surface: it goes through bootstrap, sign-in, and the
 * first-run agent flow like every other route. A signed-out visitor gets the
 * sign-in page, same as anywhere else.
 *
 * `/` IS IN HERE ON PURPOSE. For a deployment that turns the preview on, the
 * workspace is the landing surface. Note this is not a redirect: App renders by
 * path priority (setup → workspace → chat), so `/` simply resolves to the
 * workspace branch instead of falling through to chat. No URL rewrite and no
 * flash, so this adds no phantom history entry.
 *
 * Since TASK-327 the shell syncs its route to the URL, so the two caveats
 * that used to sit here are gone: Back DOES unwind navigation inside the
 * workspace, and `/` is no longer a second address for the same view — the
 * shell replaces it with `/workspace` on mount (a replace, so the no-phantom-
 * entry claim above still holds). This predicate still has to accept `/`,
 * because that is what the visitor arrives on.
 *
 * Chat keeps an address either way, which is the fact that makes this safe
 * rather than a one-way door: chat is App's FALL-THROUGH branch, and
 * @ax/static-files serves the SPA on any unclaimed path, so `/chat` renders it.
 * Worth stating because chat is easy to misread as "the thing at `/`" — it has
 * no route of its own and its conversation selection is component state, not
 * URL state, so if the fall-through were ever narrowed to an explicit list the
 * chat shell would become unreachable.
 *
 * A deployment with the preview OFF is untouched: `/` falls through to chat
 * exactly as before, because the call site ANDs this with the flag.
 */
function pathRendersWorkspace(): boolean {
  const p = window.location.pathname;
  return p === '/' || p === '/workspace' || p.startsWith('/workspace/');
}

export const App = () => {
  const [mode, setMode] = useState<AppMode>({ kind: 'loading' });
  /*
    Post-boot sign-out. `lib/http.ts` sets this latch when a request that had a
    session comes back 401, and the only thing that happens as a result is the
    branch further down: an authenticated app becomes `<LoginPage />`.

    DELIBERATELY ASYMMETRIC WITH BOOT. The boot flow below treats ANY thrown
    failure — a 500, DNS, being offline — as unauthenticated, because at first
    load there is no session to distinguish losing from never having had. Here
    there is one, so only a 401 ends it and every other failure stays a
    per-surface error the reader can retry. Both halves are on purpose; see the
    long note at the top of `lib/http.ts` before changing either.

    The latch is read but never consulted in the `loading` or `wizard` branches,
    which is what keeps the setup wizard's own legitimate pre-auth 401s
    (`StepAdmin`, `StepGate`) from meaning anything here. Those surfaces do not
    route through `lib/http.ts` either — belt and braces.
  */
  const sessionExpired = useSessionExpired();

  // Full-page OAuth return fallback (Task 12). Runs once on mount. The popup
  // case is already handled by the bridge in main.tsx before React mounts, so
  // this only fires when there is no opener (the provider redirected the main
  // window directly). Strip the params + push a toast so the user knows what
  // happened — then they're on the normal chat surface.
  const handledOAuthReturn = useRef(false);
  useEffect(() => {
    if (handledOAuthReturn.current) return;
    handledOAuthReturn.current = true;
    const result = consumeOAuthFullPageReturn({
      pathname: window.location.pathname,
      search: window.location.search,
      hasOpener:
        typeof window !== 'undefined' &&
        window.opener !== null &&
        window.opener !== window,
    });
    if (result === null) return;
    // Strip /oauth/connected?... so the back-button and reload land on /.
    window.history.replaceState({}, '', '/');
    if (result.toast === 'success') {
      toastActions.show({ title: "Connected. You're all set.", kind: 'info' });
    } else {
      toastActions.error("Couldn't connect. Please try again.");
    }
  }, []);

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
        // Concurrent, not serial: the feature flags are only needed once we
        // know who the user is, but making boot wait for a second round-trip
        // would add latency to every sign-in.
        //
        // Defensive .catch: lib/features.ts already swallows every failure and
        // returns the all-off default, but a future refactor could let one
        // escape — and a throw here would land an authenticated user on the
        // sign-in page. Same posture as the fetchBootstrapStatus() guard above.
        const [session, features] = await Promise.all([
          getSession(),
          fetchFeatures().catch(() => DEFAULT_FEATURES),
        ]);
        if (cancelled) return;
        if (session?.user) {
          setMode({ kind: 'authenticated', user: session.user, features });
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
    // (TASK-339 / audit B6) The boot fetch has no timeout, so this used to be a
    // terminal state: a host that accepted the connection and never answered
    // left `connecting…` on screen forever with nothing suggesting a reload.
    // BootScreen says so after ten seconds.
    return <BootScreen message="Getting things ready…" />;
  }
  if (mode.kind === 'wizard') {
    return <SetupWizard />;
  }
  if (mode.kind === 'unauthenticated') {
    return <LoginPage />;
  }
  // Checked AFTER the loading/wizard branches on purpose — see the note where
  // `sessionExpired` is read. A session can only end once it existed.
  if (sessionExpired) {
    // (B1) Say why they are suddenly looking at a sign-in page.
    return <LoginPage sessionExpired />;
  }
  return <AppContent user={mode.user} features={mode.features} />;
};

const AppContent = ({ user, features }: { user: AuthUser; features: Features }) => {
  useTitleEvents();
  useHydrateAgents(); // lifted from SessionHeader so the first-run gate can read the result
  const { agents, agentsStatus, selectedAgentId, pendingAgentId } = useAgentStore();
  const runtime = useAxChatRuntime(user.id);
  // Content identity for the chat-thread boundary's resetKey: when the user
  // switches sessions, a tripped thread boundary clears instead of sticking
  // the old session's fallback onto the new one. Scoped to chat-thread on
  // purpose — the sidebar list identity doesn't change on switch, and the
  // workspace shell owns its own route state.
  const { activeSessionId } = useSessionStore();
  // `adminSettingsOpen` is set by the user menu's "Settings" entry
  // (admin-gated). AdminSettings renders in the main pane when true.
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  // TASK-443 — closing Settings must not drop the keyboard on `<body>`.
  //
  // Settings is a PANE SWAP, not an overlay: the branches below render either
  // `AdminShell` or the surface it was opened from, never both. So the control
  // that opened it is destroyed on open and a NEW one is created on close, and
  // neither `components/ui/use-opener-restore.ts` (Dialog/Sheet) nor
  // `lib/consent-focus.ts` (#599) can help — both restore a captured NODE, and
  // both correctly refuse to focus a detached one. The restore has to be by
  // identity, after the remount.
  //
  // This is also why it lives here rather than in either shell: App is the only
  // component that knows the swap happened, threading a prop down through two
  // sidebars to a menu would put the knowledge in three more places, and doing
  // it once here gives the chat shell the same fix — same state, same
  // `onClose`, same marked trigger inside `UserMenu`.
  //
  // ARMED AS A REF, FIRED FROM AN EFFECT ON `adminSettingsOpen`. The same shape
  // `lib/consent-focus.ts`'s `useResolutionFocus` uses, for the same reason:
  // arming must not cause a render (the close already does one), and the flag
  // must survive that render. Keying the effect on `adminSettingsOpen` rather
  // than on the flag also puts the effect's CLEANUP on exactly the right
  // events — re-opening Settings, or unmounting — so a restore nobody wants
  // any more is called off instead of landing later.
  //
  // The ref is what distinguishes "Settings just closed" from "Settings has
  // never been open", which is every other time this effect runs, first mount
  // included. Without it the app would steal focus to the user menu on load.
  const settingsCloseArmed = useRef(false);
  const closeAdminSettings = useCallback(() => {
    setAdminSettingsOpen(false);
    settingsCloseArmed.current = true;
  }, []);
  useEffect(() => {
    if (adminSettingsOpen || !settingsCloseArmed.current) return;
    settingsCloseArmed.current = false;
    // Not a plain `focusSettingsOpener()` — measured, the opener is NOT in the
    // document yet at this point. The surface coming back re-reads its data and
    // paints a loading state with no sidebar in it first. See
    // `lib/settings-return-focus.ts`.
    return focusSettingsOpenerWhenReady();
  }, [adminSettingsOpen]);
  // `createAgentOpen` drives the explicit "+ New agent" entry into the
  // bootstrap flow (the first-run gate below uses the empty-list signal).
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  // TASK-510 — closing the new-agent flow must not drop the keyboard on
  // `<body>`. Same shape as the Settings restore above: the bootstrap gate
  // below REPLACES the workspace with the dialog, so the "New agent…" row is
  // destroyed on open and re-created on close, and the dialog's own node
  // restore bails on the detached opener. Restore by identity, after the
  // remount — see `lib/new-agent-return-focus.ts`.
  //
  // Keyed on `createAgentOpen` going true → false, which is every way out of
  // the explicit flow: Escape and the ✕ (the dialog's `onOpenChange`) and a
  // finished create (`FirstRunAutoCreate`'s `onDone`). First run never sets
  // `createAgentOpen`, so it arms nothing — nobody opened it from a control.
  const createAgentWasOpen = useRef(false);
  useEffect(() => {
    if (createAgentOpen) {
      createAgentWasOpen.current = true;
      return;
    }
    if (!createAgentWasOpen.current) return;
    createAgentWasOpen.current = false;
    return focusNewAgentOpenerWhenReady();
  }, [createAgentOpen]);
  // `bootstrapAgentName` holds the name the user enters in the NewAgentDialog
  // before the bootstrap starts. null = dialog not yet submitted.
  const [bootstrapAgentName, setBootstrapAgentName] = useState<string | null>(null);
  // The new agent the workspace still has to greet. The chat surface has
  // `bootstrapKickoff` for this (a module-level bridge to the assistant-ui
  // runtime); the workspace mounts no `AssistantRuntimeProvider`, so that
  // bridge's registrant never runs there. This state hands the id to
  // `WorkspaceShell` instead, which sends the kickoff itself.
  const [kickoffAgentId, setKickoffAgentId] = useState<string | null>(null);
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
    return <BootScreen message="Loading your agents…" />;
  }

  // Hoisted above the bootstrap gate (not just the branch below) so the
  // gate's `onDone` can tell which surface is about to render and hand the
  // kickoff to the right send path. Still a plain per-render const —
  // `pathRendersWorkspace()` reads `window.location.pathname` and is not
  // reactive, same as the existing call site below.
  const rendersWorkspace = pathRendersWorkspace() && features.agentWorkspacePreview;

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
            // (TASK-340 / audit B4) On first run the dialog now declines to
            // OFFER an exit, rather than rendering a ✕ and an Escape key that
            // quietly do nothing. The guard below stays as the backstop.
            dismissible={!isFirstRun}
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
          // One kickoff, two surfaces, two send paths — this is the load-
          // bearing line of the whole "create agent from the workspace"
          // card. `bootstrapKickoff` bridges to the CHAT runtime and only
          // that: assistant-ui invokes `useChatThreadRuntime` only under an
          // `AssistantRuntimeProvider`, which the workspace branch below
          // deliberately mounts none of — so on that path `register()` never
          // runs and `trigger()` would strand the intent in `_pending`,
          // silently. A bare agent that is never greeted never introduces
          // itself, which is the conversational half of the create flow.
          // The workspace has its own send (`workspaceApi.sendMessage`), so
          // it gets handed the agent id and greets it there.
          onDone={(agentId) => {
            setCreateAgentOpen(false);
            setBootstrapAgentName(null);
            if (rendersWorkspace) {
              setKickoffAgentId(agentId);
            } else {
              bootstrapKickoff.trigger();
            }
          }}
        />
        <ToastStack />
      </UserProvider>
    );
  }

  // The agent workspace. Below the first-run gate on purpose: a brand-new user
  // still gets the create-an-agent flow first, because a workspace with no
  // agents in it has nothing to show them.
  //
  // No AssistantRuntimeProvider here — the workspace doesn't mount the
  // assistant-ui runtime.
  if (rendersWorkspace) {
    return (
      <UserProvider value={user}>
        <ErrorBoundary surface="workspace">
          {/*
            Settings opens the SAME `AdminShell` the chat shell opens, from the
            same `adminSettingsOpen` state declared above both branches — there
            is one Settings surface, not one per shell (invariant 4).

            Before this, the workspace rendered `<UserMenu />` bare. The menu
            item was still there, still clickable, and `onOpenAdminSettings?.()`
            resolved to undefined — so it silently did nothing. That is the
            exact failure `hideClose` was added to stop (TASK-340 / audit B4):
            offering a control that cannot work is worse than not offering it,
            because the reader concludes the product is broken rather than that
            the door is elsewhere.

            It also matters for what comes next: with the workspace as the only
            interface, this is the ONLY route to AI model keys, Sign-in methods,
            Connectors, Skills, Teams, Routines and Branding.

            The wrapper mirrors the chat branch because `AdminShell` roots at
            `flex flex-1 min-w-0 h-full` and needs a flex parent with a height.
          */}
          {adminSettingsOpen ? (
            <div className="flex h-screen bg-background font-sans text-foreground">
              <AdminShell
                isAdmin={user.role === 'admin'}
                onClose={closeAdminSettings}
                backLabel="workspace"
              />
            </div>
          ) : (
            <WorkspaceShell
              onOpenAdminSettings={() => setAdminSettingsOpen(true)}
              // Byte-identical in effect to the chat branch's
              // `SessionHeader onCreateAgent` below — same two setters, same
              // order. One create-agent entry, not one per shell.
              onCreateAgent={() => { setBootstrapAgentName(null); setCreateAgentOpen(true); }}
              kickoffAgentId={kickoffAgentId}
              onKickoffConsumed={() => setKickoffAgentId(null)}
            />
          )}
        </ErrorBoundary>
        <ToastStack />
      </UserProvider>
    );
  }

  // Per-surface boundaries (TASK-273): a broken sidebar must not take the
  // thread with it, and vice versa. The outer `chat` boundary is the
  // backstop for throws above both (providers, admin shell).
  return (
    <UserProvider value={user}>
      <ErrorBoundary surface="chat">
        <AssistantRuntimeProvider runtime={runtime}>
          <div className="flex h-screen bg-background text-foreground font-sans">
            {adminSettingsOpen ? (
              <AdminShell
                isAdmin={user.role === 'admin'}
                onClose={closeAdminSettings}
              />
            ) : (
              <>
                <ErrorBoundary surface="chat-sidebar">
                  <Sidebar onOpenAdminSettings={() => setAdminSettingsOpen(true)} />
                </ErrorBoundary>
                {sidebarOpen && (
                  <div
                    className="hidden max-[720px]:block fixed inset-0 bg-black/40 z-40"
                    onClick={() => setSidebarOpen(false)}
                    aria-hidden="true"
                  />
                )}
                <ErrorBoundary surface="chat-thread" resetKey={activeSessionId}>
                  <main className="flex flex-1 flex-col min-w-0 min-h-0 h-full">
                    <SessionHeader onCreateAgent={() => { setBootstrapAgentName(null); setCreateAgentOpen(true); }} />
                    <Thread />
                  </main>
                </ErrorBoundary>
              </>
            )}
          </div>
        </AssistantRuntimeProvider>
      </ErrorBoundary>
      {/*
        Outside the chat boundary on purpose: if the chat subtree trips,
        toasts (retry confirmations, error notes) must still reach the user.
      */}
      <ToastStack />
    </UserProvider>
  );
};
