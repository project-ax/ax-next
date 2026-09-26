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
 * Signed in, there is one surface: the agent workspace. (The old chat
 * screen was deleted in TASK-360; `/chat` links land on `/` — see
 * `lib/retired-chat-path.ts`.)
 *
 * Per-test-file note: components in `components/` render in isolation and
 * bypass the gate. Only `App.tsx` is gated; downstream tests don't need
 * to mock the bootstrap or auth wire.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSession, type AuthUser } from './lib/auth';
import { fetchBootstrapStatus, type BootstrapStatus } from './lib/bootstrap-status';
import { hydrateTheme } from './lib/theme';
import { useAgentStore } from './lib/agent-store';
import { shouldShowAgentBootstrap } from './lib/agent-bootstrap-gate';
import { useSessionExpired } from './lib/session-expired-store';
import { useHydrateAgents } from './lib/hydrate-agents';
import { FirstRunAutoCreate } from './components/onboard/FirstRunAutoCreate';
import { NewAgentDialog } from './components/onboard/NewAgentDialog';
import { BootScreen } from './components/BootScreen';
import { LoginPage } from './components/LoginPage';
import { WorkspaceShell } from './components/workspace/WorkspaceShell';
import { focusSettingsOpenerWhenReady } from './lib/settings-return-focus';
import {
  focusNewAgentOpenerWhenReady,
  focusNewAgentViewWhenReady,
  refocusNewAgentViewWhenReady,
} from './lib/new-agent-return-focus';
import { ToastStack } from './components/Toast';
import { AdminShell } from './components/admin/AdminShell';
import { SetupWizard } from './components/setup/SetupWizard';
import { UserProvider } from './lib/user-context';
import { consumeOAuthFullPageReturn } from './lib/oauth-full-page-return';
import { toastActions } from './lib/toast-store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { redirectRetiredChatPath } from './lib/retired-chat-path';

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
  // happened — then they're on the workspace.
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
    // `/chat` and `/chat/*` land on `/` (TASK-360). First thing, before any
    // branch below reads the path; a REPLACE, so a bookmark to the old chat
    // screen adds no Back entry. Nothing before this effect reads the path
    // except the OAuth-return check above, which only acts on its own path.
    redirectRetiredChatPath(window.location, window.history);
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
  return <AppContent user={mode.user} />;
};

const AppContent = ({ user }: { user: AuthUser }) => {
  useHydrateAgents(); // before the first-run gate, which reads the result
  const { agents, agentsStatus } = useAgentStore();
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
  // This is also why it lives here rather than in the shell: App is the only
  // component that knows the swap happened, and threading a prop down through
  // the sidebar to a menu would put the knowledge in more places.
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
  //
  // TASK-533 — a finished create is not the same exit as the other two. By
  // the time focus can land the screen shows the NEW agent, so focus goes into
  // its conversation instead of back to the row. `onDone` records the id here
  // before it closes the flow; Escape and ✕ leave it null.
  //
  // TASK-547 — on the workspace, the route only moves to the new agent once
  // the kickoff's send returns, and nothing keyed by the new id can be on
  // screen before that. A send slower than `RESTORE_WINDOW_MS` used to run
  // the close-time restore out with focus on `<body>`. So the restore is
  // started AGAIN when `WorkspaceShell` reports the route has moved
  // (`onKickoffRouted`) — a fresh window, measured from the moment the new
  // agent's view can actually paint, instead of a longer guess from the
  // close. Only for the create this close armed (`kickoffFocusFor`), and
  // only if nobody has taken the keyboard in the meantime — see
  // `refocusNewAgentViewWhenReady`. On a fast send it is a harmless second
  // wait on the same targets: whichever lands first, the other sees a
  // claimed keyboard and stops.
  const createAgentWasOpen = useRef(false);
  const createdAgentId = useRef<string | null>(null);
  const kickoffFocusFor = useRef<string | null>(null);
  const cancelKickoffFocus = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (createAgentOpen) {
      createAgentWasOpen.current = true;
      createdAgentId.current = null;
      kickoffFocusFor.current = null;
      cancelKickoffFocus.current?.();
      cancelKickoffFocus.current = null;
      return;
    }
    if (!createAgentWasOpen.current) return;
    createAgentWasOpen.current = false;
    const created = createdAgentId.current;
    createdAgentId.current = null;
    if (created === null) return focusNewAgentOpenerWhenReady();
    kickoffFocusFor.current = created;
    return focusNewAgentViewWhenReady(created);
  }, [createAgentOpen]);
  const onKickoffRouted = useCallback((agentId: string) => {
    if (kickoffFocusFor.current !== agentId) return;
    kickoffFocusFor.current = null;
    cancelKickoffFocus.current?.();
    cancelKickoffFocus.current = refocusNewAgentViewWhenReady(agentId);
  }, []);
  useEffect(() => () => cancelKickoffFocus.current?.(), []);
  // `bootstrapAgentName` holds the name the user enters in the NewAgentDialog
  // before the bootstrap starts. null = dialog not yet submitted.
  const [bootstrapAgentName, setBootstrapAgentName] = useState<string | null>(null);
  // The new agent the workspace still has to greet. `WorkspaceShell` sends
  // the kickoff itself once it has the id.
  const [kickoffAgentId, setKickoffAgentId] = useState<string | null>(null);

  useEffect(() => {
    // Apply the persisted theme before first paint of any subscriber.
    hydrateTheme();
  }, []);

  if (agentsStatus === 'loading') {
    return <BootScreen message="Loading your agents…" />;
  }

  // First-run (no personal agent yet) OR the explicit "+ New agent…" entry.
  // 'error' deliberately falls through to the workspace — a transient blip
  // must not force an existing user into the create flow; "+ New agent…"
  // remains available from the workspace.
  //
  // Two-phase bootstrap:
  //   Phase 1 (bootstrapAgentName === null): show NewAgentDialog so the user
  //     picks a name before anything is created. For first-run the dialog is
  //     non-dismissible (Escape / outside click is ignored — they must create
  //     an agent). For the explicit "New agent…" path the dialog can be
  //     cancelled, which closes the gate.
  //   Phase 2 (bootstrapAgentName !== null): auto-create with the chosen name,
  //     then hand the new agent to the workspace to greet.
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
          // A bare agent that is never greeted never introduces itself, which
          // is the conversational half of the create flow — so the new id goes
          // to `WorkspaceShell`, which sends the kickoff
          // (`workspaceApi.sendMessage`) and routes to the agent.
          onDone={(agentId) => {
            // Before the close below, so the close effect sees it (TASK-533).
            createdAgentId.current = agentId;
            setCreateAgentOpen(false);
            setBootstrapAgentName(null);
            setKickoffAgentId(agentId);
          }}
        />
        <ToastStack />
      </UserProvider>
    );
  }

  // The agent workspace. Below the first-run gate on purpose: a brand-new user
  // still gets the create-an-agent flow first, because a workspace with no
  // agents in it has nothing to show them.
  return (
    <UserProvider value={user}>
      <ErrorBoundary surface="workspace">
        {/*
          Settings opens `AdminShell` as a pane swap. The workspace once
          rendered `<UserMenu />` bare, and its Settings item
          silently did nothing — offering a control that cannot work is worse
          than not offering it (TASK-340 / audit B4).

          This is the ONLY route to AI model keys, Sign-in methods, Connectors,
          Skills, Teams, Routines and Branding.

          `AdminShell` roots at `flex flex-1 min-w-0 h-full` and needs a flex
          parent with a height, hence the wrapper.
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
            onCreateAgent={() => { setBootstrapAgentName(null); setCreateAgentOpen(true); }}
            kickoffAgentId={kickoffAgentId}
            onKickoffConsumed={() => setKickoffAgentId(null)}
            onKickoffRouted={onKickoffRouted}
          />
        )}
      </ErrorBoundary>
      {/*
        Outside the workspace boundary on purpose: if the workspace subtree
        trips, toasts (retry confirmations, error notes) must still reach
        the user.
      */}
      <ToastStack />
    </UserProvider>
  );
};
