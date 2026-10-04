import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SetupShell } from '../setup/SetupShell';
import {
  autoCreateBareAgent,
  discardCreatedAgent,
  renameCreatedAgent,
} from '../../lib/auto-create-agent';
import { hydrateAgentsOnce } from '../../lib/hydrate-agents';
import { agentStoreActions } from '../../lib/agent-store';
import { logRequestFailure } from '../../lib/http';

/**
 * First-run: no form (TASK-140, conversational-agent-identity). We create a
 * BARE agent server-side — POST /api/agents/bootstrap, which also seeds
 * `.ax/BOOTSTRAP.md` — then select it, hydrate the agent store, and hand
 * control to the workspace. The new agent wakes up in bootstrap mode and
 * figures out who it is through conversation (the runner injects BOOTSTRAP.md).
 * This replaces the retired 3-field name→soul→purpose wizard.
 *
 * Despite the name it also runs the explicit "+ New agent…" create (`mode`
 * says which) — one create path, two framings. The name comes from
 * `NewAgentCard` first; this is what happens after it.
 *
 * A `ran` ref makes the create idempotent: once it has fired, a re-invocation
 * of the effect returns early, so we never create two agents from one mount.
 * The re-invocation that actually happens here is dev Fast Refresh
 * (`@vitejs/plugin-react`, see `vite.config.ts`), which re-runs effects on a
 * hot update while preserving refs. The ref would equally cover StrictMode's
 * deliberate double-invoke, but this app never enables it — `main.tsx` renders
 * a bare `createRoot`. The ref is not dead code either way: the "Try again"
 * handler below resets it on purpose so a retry can re-run the effect.
 *
 * `ran` guards one mount's effect; `createdAgentId` guards the SERVER (TASK-709).
 * The POST and the hand-off after it (hydrate, onDone) share one `try`, so a
 * failure in the hand-off shows the same card as a failed create — and "Try
 * again" used to POST again, making a second agent with the same name while
 * the first one never got its kickoff. Once the POST has returned an id we
 * keep it, and a retry only re-runs the hand-off.
 *
 * The two ways out of the failure card respect that id too (TASK-791). "Change
 * name" unmounts us, so the id has to outlive this mount: `onCreated` hands it
 * to the caller, which passes it back as `existingAgentId`, and the next mount
 * RENAMES that agent instead of POSTing a second one. "Cancel" (adding only)
 * deletes the agent this flow made, so walking away leaves nothing behind.
 */
export function FirstRunAutoCreate({
  agentName,
  mode,
  existingAgentId = null,
  onCreated,
  onBack,
  onDone,
}: {
  agentName: string;
  /**
   * An agent an EARLIER mount of this flow already created — set only when
   * "Change name" brought the person back here after the create succeeded.
   * This mount renames it to `agentName` instead of creating another.
   */
  existingAgentId?: string | null;
  /** Called the moment the create returns an id, so the caller can keep it. */
  onCreated?: (agentId: string) => void;
  /**
   * Which flow this is. The two used to share one failure card, which told
   * someone adding their fifth agent that we were setting up their "first"
   * (TASK-689).
   */
  mode: 'first-run' | 'add';
  /**
   * The way out of a failed create: first run goes back to the name card
   * ("Change name"), adding goes back to the workspace ("Cancel"). Only ever
   * offered on the failure card — going back while the POST is still running
   * would abandon a create that may yet succeed. When adding, Cancel first
   * deletes the agent this flow created (if any) and only calls this once the
   * delete has worked.
   */
  onBack: () => void;
  // Hands back the new agent's id: the workspace's send is explicit about
  // which agent it's talking to, so the caller needs the id to hand the
  // kickoff to the right agent.
  onDone: (agentId: string) => void;
}) {
  const ran = useRef(false);
  // Set the moment the bootstrap POST returns. Never cleared: a retry must not
  // create the agent twice (TASK-709).
  const createdAgentId = useRef<string | null>(existingAgentId);
  // An agent from an earlier mount still carries the name the person changed
  // away from. Cleared once the rename lands, so a retry after a later
  // hand-off failure does not rename again.
  const needsRename = useRef(existingAgentId !== null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const isAdd = mode === 'add';
  const failed = err !== null;
  // Whether this flow has an agent on the server. Read at render time from the
  // ref: every render that matters here follows the `setErr` that came after
  // the ref was written.
  const hasCreatedAgent = createdAgentId.current !== null;

  // Cancel (adding only). Before anything exists there is nothing to undo.
  // Once an agent exists, Cancel deletes THAT agent — the id this flow's own
  // create returned, never one picked from a list — and only then goes back.
  // If the delete fails we stay on the card and say so: going back would
  // leave the agent behind while telling the person it was gone.
  const cancel = useCallback(async () => {
    const agentId = createdAgentId.current;
    if (agentId === null) {
      onBack();
      return;
    }
    setDiscarding(true);
    try {
      await discardCreatedAgent(agentId);
    } catch (e) {
      logRequestFailure(e, 'agent-bootstrap-discard');
      setDiscarding(false);
      setErr(
        `We couldn't remove ${agentName} just now. Press Cancel again in a moment, or Try again to finish setting it up instead.`,
      );
      return;
    }
    // The create may have put it in the agent list; take it back out.
    await hydrateAgentsOnce();
    onBack();
  }, [agentName, onBack]);

  // Escape is the same "out" as Cancel, but only when adding and only once the
  // create has failed. First run has nothing to go back to that Escape should
  // promise; a running create is not something to walk away from.
  //
  // A LAYOUT effect, not a passive one (TASK-772). The failure arrives from a
  // promise continuation, so React commits the card on a non-sync lane and
  // defers passive effects to a later task: for that gap the Cancel button is
  // on screen but Escape was silently dropped. Measured 20/20 with a keydown
  // fired from a MutationObserver the moment Cancel appeared; it is also what
  // made the CI test flaky (the test's keydown landed in the gap). Layout
  // effects run inside the commit, so "the card is visible" now implies
  // "Escape works".
  //
  // Escape runs the same `cancel` as the button, delete included: the card
  // says Cancel removes the agent, and Escape is offered as Cancel. Not while a
  // delete is already in flight — that would send a second one.
  useLayoutEffect(() => {
    if (!isAdd || !failed || discarding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      void cancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isAdd, failed, discarding, cancel]);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    let cancelled = false;
    void (async () => {
      try {
        // Reuse the agent an earlier attempt already created; only POST when
        // there is none. Recorded BEFORE the `cancelled` check: it is a fact
        // about the server, not this component's view state.
        let agentId = createdAgentId.current;
        if (agentId === null) {
          agentId = (await autoCreateBareAgent(agentName)).agentId;
          createdAgentId.current = agentId;
          // Same reasoning: the caller keeps the id past this mount, so a
          // "Change name" that unmounts us cannot lose it (TASK-791).
          onCreated?.(agentId);
        } else if (needsRename.current) {
          // "Change name" after the agent existed: rename it, never POST a
          // second one (TASK-791).
          await renameCreatedAgent(agentId, agentName);
          needsRename.current = false;
        }
        if (cancelled) return;
        // Select + hydrate so the App-level gate flips (agent list no longer
        // empty) and the workspace renders this agent.
        agentStoreActions.setSelectedAgent(agentId);
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
        onDone(agentId);
      } catch (e) {
        // The operator's half (TASK-695): the person is told below, but a real
        // bootstrap failure used to leave nothing in the console to start from.
        // Before the `cancelled` check on purpose — the breadcrumb is not this
        // component's state, so it must not depend on anyone still watching.
        logRequestFailure(e, 'agent-bootstrap');
        if (!cancelled) {
          // Names the agent: it is the one thing on this card the person typed,
          // and it says WHICH create failed when they are adding another.
          setErr(
            `We couldn't set up ${agentName} just now. That's on us, not you — give it another go.`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `attempt` is a dep so "Try again" (which resets `ran` and bumps
    // `attempt`) re-runs the effect. Once `createdAgentId` is set, that re-run
    // does not POST again.
    //
    // `agentName`, `onCreated` and `onDone` are left out on purpose. They are
    // stable for the lifetime of this mount, and the `ran` ref already guards
    // against a second create.
  }, [attempt]);

  if (err !== null) {
    return (
      <SetupShell
        title={isAdd ? 'New agent' : "Let's get you started"}
        description={
          isAdd
            ? `We're setting up ${agentName}.`
            : "We're setting up your first agent so you can start chatting."
        }
      >
        <div className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
          {/* TASK-689: the card used to offer only "Try again". When the
              failure is not a blip that is a trap, and here `App.tsx`'s gate
              has replaced the workspace, so the page had no other exit. */}
          {/* TASK-791: Cancel deletes the agent once one exists, so say so
              BEFORE the click rather than surprising anyone after it. */}
          {isAdd && hasCreatedAgent && (
            <p className="text-sm text-muted-foreground">
              Cancel removes {agentName}, so you won't be left with a half-finished agent.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={discarding}
              onClick={isAdd ? () => void cancel() : onBack}
            >
              {isAdd ? (discarding ? 'Removing…' : 'Cancel') : 'Change name'}
            </Button>
            <Button
              type="button"
              disabled={discarding}
              onClick={() => {
                ran.current = false;
                setErr(null);
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </Button>
          </div>
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
