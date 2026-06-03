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
 * A `ran` ref guards React 18 StrictMode's intentional double-invoke of effects
 * in dev, so we never create two agents from one mount.
 */
export function FirstRunAutoCreate({
  agentName,
  onDone,
}: {
  agentName: string;
  onDone: () => void;
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
        if (cancelled) return;
        onDone();
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
      <div className="flex items-center justify-center py-6 text-muted-foreground font-mono text-xs tracking-[0.04em]">
        creating your agent…
      </div>
    </SetupShell>
  );
}
