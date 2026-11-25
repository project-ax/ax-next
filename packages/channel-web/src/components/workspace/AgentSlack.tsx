/**
 * An agent's Slack section in its settings (TASK-1094): one card for the
 * agent's own bot (`AgentSlackBot`, TASK-1168, TASK-1187), whose title says
 * which of three states it is in (not in Slack, waiting, live). Once it is
 * live, the card holds the channels the bot has answered in
 * (`AgentSlackBotChannels`, TASK-1180). A team agent reaches channels only
 * through its own bot (TASK-1186), so nothing is connected here through the
 * shared Slack app. Everyone gets the card: someone who can't manage the agent
 * reads that it isn't in Slack yet, until it is.
 *
 * Claude-simple on purpose. No ids, scopes or install words: a channel is
 * `#name`, a person is a name, and a problem shows up only when there is one.
 * Slack itself is set up once, in Admin settings; this page never asks for it.
 *
 * A personal agent has no bot of its own. It says which of its owner's agents a
 * direct message to the shared bot reaches, and offers to make this one it
 * (`AgentSlackDms`, TASK-1238). The confirmation after a switch is held here,
 * because the switch reads the status again and the loading face replaces
 * everything below until it lands (and, should that read fail, the confirmation
 * still shows above the load error: the switch happened).
 *
 * A memory change is never optimistic (the `lib/agent-abilities.ts` rule):
 * while a write is in flight the row keeps its old state, and a failed write
 * leaves it there with a sentence saying nothing changed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { logRequestFailure } from '@/lib/http';
import { AgentSlackDms, AgentSlackDmsSwitched } from './AgentSlackDms';
import { AgentSlackBot, AppLeftOverNote, type AgentSlackBotProps, type BotCancelled } from './AgentSlackBot';
import type { RebuildFrom } from './AgentSlackBotLifecycle';
import { fetchAgentSlack, type AgentSlackRead } from '@/lib/agent-slack';

type Ready = Extract<AgentSlackRead, { state: 'ready' }>;
type Load = { status: 'loading' } | { status: 'failed' } | { status: 'ok'; read: AgentSlackRead };

export interface AgentSlackProps {
  agentId: string;
  agentName: string;
}

export function AgentSlack({ agentId, agentName }: AgentSlackProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Only the newest scope's answers land (switching agents quickly).
  const scope = useRef(0);
  // What the last cancel of this agent's bot request said. Held here, not in the
  // bot section: a cancel reads the status again, and the loading face replaces
  // everything below this component until it lands.
  const [leftOver, setLeftOver] = useState<BotCancelled | null>(null);
  // The bot Set up again just took away, so the request form that follows can offer its name back (TASK-1173).
  const [rebuilding, setRebuilding] = useState<RebuildFrom | null>(null);
  // The labels of a direct-message switch this page just made, for its confirmation (TASK-1238).
  // `botName` rides along so the confirmation can still be drawn when the re-read fails.
  const [switched, setSwitched] = useState<{ self: string; from: string; botName: string } | null>(null);
  const [leftOverFor, setLeftOverFor] = useState(agentId);
  if (leftOverFor !== agentId) {
    // Another agent: the note was about the one before (reset while rendering, so it never flashes).
    setLeftOverFor(agentId);
    setLeftOver(null);
    setRebuilding(null);
    setSwitched(null);
  }
  const botCallbacks = {
    leftOver,
    rebuilding,
    onCancelled: (cancelled: BotCancelled) => setLeftOver(cancelled.appDeleted ? null : cancelled),
    onRebuilt: (from: RebuildFrom) => setRebuilding(from),
    onRequesting: () => {
      setLeftOver(null);
      setRebuilding(null);
    },
  };

  const read = useCallback(() => {
    const id = ++scope.current;
    setLoad({ status: 'loading' });
    void (async () => {
      try {
        const out = await fetchAgentSlack(agentId);
        if (scope.current === id) setLoad({ status: 'ok', read: out });
      } catch (e) {
        logRequestFailure(e, 'agent-slack');
        if (scope.current === id) setLoad({ status: 'failed' });
      }
    })();
  }, [agentId]);

  useEffect(() => {
    read();
    return () => {
      scope.current += 1;
    };
  }, [read]);

  if (load.status === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading Slack settings…</span>
        <Skeleton className="h-14 w-full" aria-hidden="true" />
        <Skeleton className="h-14 w-full" aria-hidden="true" />
      </div>
    );
  }
  if (load.status === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        {switched !== null && <AgentSlackDmsSwitched botName={switched.botName} switched={switched} />}
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>We couldn&apos;t load the Slack settings.</p>
            <Button variant="outline" size="sm" onClick={read}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const state = load.read;
  switch (state.state) {
    case 'unavailable':
      return <p className="text-[13px] text-muted-foreground">Slack isn&apos;t available here.</p>;
    case 'no-workspace':
      // A live bot outlives the shared install, and a pending or requested one still
      // has to be cancellable (only a manager is told of either); its managers can
      // disconnect a live one too (the server says who they are). Nothing can be
      // asked for here.
      return (
        <div className="flex flex-col gap-5">
          <p className="text-[13px] text-muted-foreground">
            Slack isn&apos;t connected to this workspace yet. An admin can connect it in Admin settings.
          </p>
          {state.bot.state !== 'none' ? (
            <AgentSlackBot
              key={agentId}
              agentId={agentId}
              agentName={agentName}
              bot={state.bot}
              canManage={state.canManage}
              channels={state.botChannels ?? []}
              {...botCallbacks}
              onChanged={read}
            />
          ) : (
            // No form to sit above here: the note stands on its own.
            leftOver !== null && <AppLeftOverNote leftOver={leftOver} />
          )}
        </div>
      );
    case 'personal-agent':
      return (
        <AgentSlackDms
          agentId={agentId}
          agentName={agentName}
          botName={state.botName}
          answersDms={state.answersDms}
          dmAgentName={state.dmAgentName}
          switched={switched}
          onSwitched={(labels) => {
            setSwitched({ ...labels, botName: state.botName });
            read();
          }}
          onStale={() => {
            setSwitched(null);
            read();
          }}
        />
      );
    case 'ready':
      return (
        <ReadySection
          key={agentId}
          agentId={agentId}
          agentName={agentName}
          ready={state}
          botCallbacks={botCallbacks}
          onStale={read}
        />
      );
  }
}

function ReadySection({
  agentId,
  agentName,
  ready,
  botCallbacks,
  onStale,
}: {
  agentId: string;
  agentName: string;
  ready: Ready;
  /** The bot section's cancel note and its setters, held by `AgentSlack` so they outlive a re-read. */
  botCallbacks: Pick<
    AgentSlackBotProps,
    'leftOver' | 'rebuilding' | 'onCancelled' | 'onRebuilt' | 'onRequesting'
  >;
  /** A refusal that says the picture is out of date: read it again. */
  onStale: () => void;
}) {
  const { canManage, bot } = ready;
  const botChannels = ready.botChannels ?? [];
  return (
    <div className="flex flex-col gap-5">
      <AgentSlackBot
        agentId={agentId}
        agentName={agentName}
        bot={bot}
        canManage={canManage}
        sharedConnected
        channels={botChannels}
        {...botCallbacks}
        onChanged={onStale}
      />
    </div>
  );
}
