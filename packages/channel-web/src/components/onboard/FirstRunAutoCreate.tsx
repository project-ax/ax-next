import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SetupShell } from '../setup/SetupShell';
import { autoCreateBareAgent } from '../../lib/auto-create-agent';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';

/**
 * First-run: no form (TASK-140, conversational-agent-identity). We create a
 * BARE agent server-side — POST /api/agents/bootstrap, which also seeds
 * `.ax/BOOTSTRAP.md` — then select it, hydrate the agent store, and hand
 * control to the chat shell. The new agent wakes up in bootstrap mode and
 * figures out who it is through conversation (the runner injects BOOTSTRAP.md).
 * This replaces the retired 3-field name→soul→purpose wizard.
 *
 * A `ran` ref makes the create idempotent: once it has fired, a re-invocation
 * of the effect returns early, so we never create two agents from one mount.
 * The re-invocation that actually happens here is dev Fast Refresh
 * (`@vitejs/plugin-react`, see `vite.config.ts`), which re-runs effects on a
 * hot update while preserving refs. The ref would equally cover StrictMode's
 * deliberate double-invoke, but this app never enables it — `main.tsx` renders
 * a bare `createRoot`, and `lib/conversation-decisions.ts` says the same. The
 * ref is not dead code either way: the "Try again" handler below resets it on
 * purpose so a retry can re-run the effect.
 */
export function FirstRunAutoCreate({
  agentName,
  onDone,
}: {
  agentName: string;
  // Hands back the new agent's id: the chat surface resolves a freshly
  // created agent from the agent store via its transport, but the
  // workspace's send is explicit about which agent it's talking to, so the
  // caller needs the id to hand the kickoff to the right agent.
  onDone: (agentId: string) => void;
}) {
  const ran = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const agent = await autoCreateBareAgent(agentName);
        if (cancelled) return;
        // Select + hydrate so the App-level gate flips (agent list no longer
        // empty) and the chat shell renders this agent.
        agentStoreActions.setSelectedAgent(agent.agentId);
        await hydrateAgentsOnce();
        /*
          NOT gated on `cancelled` — and that is the fix for a silent failure
          this component was causing itself.

          `hydrateAgentsOnce` writes to `agent-store`, which App subscribes to
          through `useSyncExternalStore`. The agent list is now non-empty, so
          `shouldShowAgentBootstrap`'s `noAgents` arm flips false and, on FIRST
          RUN — where `createAgentOpen` is false and `noAgents` is the only
          thing holding the gate open — App unmounts us. React can flush that
          sync-lane re-render in a microtask queued BEFORE the continuation you
          are reading, so our own cleanup sets `cancelled = true` and a
          `if (cancelled) return` here swallows the completion of work that
          fully succeeded. Measured: the agent was created (POST returned 201)
          and `onDone` was called ZERO times.

          The cost of that is the whole conversational half of the create flow.
          `onDone` is what sends the bootstrap kickoff — the first message that
          makes a bare agent wake up and introduce itself — so the user got an
          agent that never said anything.

          `cancelled` is here to stop setState-after-unmount, and `onDone` is
          not our state: it is a callback on `AppContent`, which is still
          mounted (it is the thing that unmounted us). The guards that remain
          are the two that do touch local state. Leaving this one in made a
          success or a silence depend on which React lane an unrelated store
          write happened to take, which is not a property this component should
          be resting on.
        */
        onDone(agent.agentId);
      } catch {
        if (!cancelled) {
          setErr(
            "We couldn't set up your agent just now. This one's on us, not you — give it another go.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `attempt` is a dep so "Try again" (which resets `ran` + bumps `attempt`)
    // re-runs the effect. `agentName` and `onDone` are intentionally omitted —
    // they're stable for the lifetime of this mount, and the `ran` ref already
    // guards against re-creation.
  }, [attempt]);

  if (err !== null) {
    return (
      <SetupShell
        title="Let's get you started"
        description="We're setting up your first agent so you can start chatting."
      >
        <div className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
          <Button
            type="button"
            onClick={() => {
              ran.current = false;
              setErr(null);
              setAttempt((a) => a + 1);
            }}
          >
            Try again
          </Button>
        </div>
      </SetupShell>
    );
  }

  return (
    <SetupShell
      title="Setting up your agent…"
      description="One moment — we're bringing your new agent online. It'll introduce itself in a sec."
    >
      {/* (TASK-339 / audit B6) Sentence case, plain words. No ten-second
          "taking longer than usual" here: spawning a fresh agent honestly takes
          a while, this step already has its own error state with a Try again,
          and crying wolf on a job that is working is its own kind of lie. */}
      <div className="flex items-center justify-center py-6 text-[13px] text-muted-foreground">
        Bringing your agent online…
      </div>
    </SetupShell>
  );
}
