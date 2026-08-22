/**
 * One agent: its current conversation, what it did, what it wrote, what it
 * remembers — plus the rail.
 *
 * The agent is the object you navigate to, and the conversation is one of its
 * properties. That inversion is the whole point of the refresh: chat stops
 * being the noun.
 *
 * There is no Pause/Resume control. Pausing an agent has no backend, and a
 * button wired to a route that answers 501 is half-wired code with a friendly
 * face on it. It arrives with the halted/paused state itself (AW-12).
 *
 * Sending goes to the SHIPPED chat wire (`workspaceApi.sendMessage` →
 * `streamReply`), not to a workspace route of its own — starting a turn has one
 * source of truth. While the reply streams we show a transient bubble; when the
 * turn ends we re-read the detail so the server's durable thread replaces it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, ChevronLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { workspaceApi, type AgentDetail, type Decision } from '@/lib/workspace-api';
import { ActivityFeed } from './ActivityFeed';
import { AgentConversation } from './AgentConversation';
import { AgentFiles } from './AgentFiles';
import { AgentMemory } from './AgentMemory';
import { AgentRail } from './AgentRail';
import { AgentStateLabel, AgentTile } from './bits';
import type {
  ActivityEvent,
  ThreadMessage,
  WorkspaceAgent,
} from '@/lib/workspace-api';

export type AgentTab = 'chat' | 'did' | 'files' | 'memory';

interface Props {
  agentId: string;
  tab: AgentTab;
  onTab: (t: AgentTab) => void;
  decisions: Decision[];
  activity: ActivityEvent[];
  /** Threaded straight through to the `did` tab's `ActivityFeed` — see there. */
  activityHasMore?: boolean;
  onActivityLoadMore?: () => void;
  activityLoading?: boolean;
  activityError?: string | null;
  agents: WorkspaceAgent[];
  onBack: () => void;
  /**
   * The three ways out of a decision. REQUIRED — see `AgentConversation` for
   * why they are not optional-with-a-default.
   */
  onApprove: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndo: (id: string) => void;
  /** Rows with a POST in flight, and any per-row notice from the last action. */
  busyIds?: ReadonlySet<string>;
  notices?: ReadonlyMap<string, string>;
  /**
   * The agent stopped mid-turn to ask for something. Fired from the live SSE
   * stream so the card appears in the thread as it happens rather than on the
   * reader's next refresh — the shell re-reads the queue and this panel.
   */
  onDecisionRaised?: (decisionId: string) => void;
  /** Bumped by the shell whenever the board changes, to re-pull detail. */
  version: number;
  onChanged: () => void;
  /**
   * A message the shell already sent on this agent's behalf (the home
   * composer). We stream its reply as soon as we mount.
   */
  pendingReply?: { reqId: string; text: string } | null;
  onPendingReplyConsumed?: () => void;
}

export function AgentView({
  agentId,
  tab,
  onTab,
  decisions,
  activity,
  activityHasMore,
  onActivityLoadMore,
  activityLoading,
  activityError,
  agents,
  onBack,
  onApprove,
  onDismiss,
  onUndo,
  busyIds,
  notices,
  onDecisionRaised,
  version,
  onChanged,
  pendingReply = null,
  onPendingReplyConsumed,
}: Props) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pastId, setPastId] = useState<string | null>(null);
  /**
   * The excerpt for the past conversation the rail has open, fetched on demand
   * and kept SEPARATE from `detail` so the current conversation's id — the one
   * a send lands in — is never overwritten by a read-only view.
   */
  const [pastDetail, setPastDetail] = useState<AgentDetail | null>(null);
  const [pastError, setPastError] = useState<string | null>(null);

  /** The turn in flight: what we sent, what has streamed back, how it ended. */
  const [sent, setSent] = useState<string | null>(null);
  const [streamed, setStreamed] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  /** Set by a send before the re-read lands, so a follow-up hits the same row. */
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await workspaceApi.agent(agentId);
      setDetail(next);
      conversationRef.current = next.conversationId;
      setLoadError(null);
    } catch (e) {
      setDetail(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  /*
    Open one of the rail's past conversations. The excerpt is a real re-read
    (`?conversationId=`), not something the roster response carried: `past`
    rows used to ship `msgs: []` and a `folded: 0`, which the pane rendered as
    "Earlier turns were summarised into memory · 0 messages folded" above an
    empty transcript. Nothing had been summarised and nothing had been read.
  */
  useEffect(() => {
    if (pastId === null) {
      setPastDetail(null);
      setPastError(null);
      return;
    }
    let cancelled = false;
    setPastDetail(null);
    setPastError(null);
    void (async () => {
      try {
        const excerpt = await workspaceApi.agent(agentId, pastId);
        if (!cancelled) setPastDetail(excerpt);
      } catch (e) {
        if (!cancelled) {
          setPastError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, pastId]);

  useEffect(() => {
    setPastId(null);
    setSent(null);
    setStreamed('');
    setStreaming(false);
    setTurnError(null);
  }, [agentId]);

  // Abort any live stream when we unmount or switch agents — a reader left
  // running would keep writing into a component nobody is looking at.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [agentId]);

  const streamFrom = useCallback(
    async (reqId: string) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setStreamed('');
      setTurnError(null);
      await workspaceApi.streamReply(reqId, {
        signal: ac.signal,
        onText: (chunk) => setStreamed((prev) => prev + chunk),
        onDone: () => {
          setStreaming(false);
          setSent(null);
          setStreamed('');
          // The durable thread is the source of truth — re-read it rather than
          // keeping our transient copy around to drift.
          void load();
          onChanged();
        },
        onError: (message) => {
          // Never leave the spinner up. A stale answer is a state we can
          // render; an absence is not (design H7).
          setStreaming(false);
          setTurnError(message);
        },
        /*
          The agent stopped to ask for something. NON-TERMINAL: the stream
          stays open, the turn is parked waiting for an answer, and the
          spinner stays up because the agent genuinely is still going.

          The frame carries only an id and a one-line summary, so we do not
          render it — we re-read. `load()` brings back the thread with the
          approval message on the end of it, and `onChanged()` pulls the
          decision itself into the queue the card reads from. The card is then
          the same row Today shows rather than a second description of it.
        */
        onDecisionRaised: ({ decisionId }) => {
          void load();
          onDecisionRaised?.(decisionId);
          onChanged();
        },
      });
    },
    [load, onChanged, onDecisionRaised],
  );

  /*
    Pick up a turn the home composer already started for this agent. Keyed on
    the reqId rather than on the prop's identity: the shell rebuilds that object
    on every render, and re-opening the same stream twice would double the
    reply.
  */
  const consumedReqId = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingReply) return;
    if (consumedReqId.current === pendingReply.reqId) return;
    consumedReqId.current = pendingReply.reqId;
    setSent(pendingReply.text);
    onPendingReplyConsumed?.();
    void streamFrom(pendingReply.reqId);
  }, [pendingReply, streamFrom, onPendingReplyConsumed]);

  const send = useCallback(
    async (text: string) => {
      setSent(text);
      setTurnError(null);
      try {
        const { conversationId, reqId } = await workspaceApi.sendMessage({
          agentId,
          conversationId: conversationRef.current,
          text,
        });
        conversationRef.current = conversationId;
        await streamFrom(reqId);
      } catch (e) {
        setStreaming(false);
        setTurnError(
          e instanceof Error
            ? e.message
            : 'We could not get that message to the agent.',
        );
      }
    },
    [agentId, streamFrom],
  );

  if (loadError !== null) {
    /*
      The prose, the way out, and the code — in that order, on separate lines.
      This used to end with a bare "(workspace /agents/ag_x → 404)" inside the
      sentence and told the reader to try again with no button to do it. The
      shell's board-level error (WorkspaceShell) has the same three parts in
      the same order; a reader who has seen one recognises the other.
    */
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <Alert variant="destructive" className="max-w-[520px]">
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>
              We could not load this agent. It may have been removed, or the
              server may be having a moment. Nothing was lost — its work and
              its memory are untouched.
            </span>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">
              {loadError}
            </span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        Loading…
      </div>
    );
  }

  const { agent } = detail;
  const past = detail.past.find((p) => p.id === pastId) ?? null;

  /*
    The transient turn, appended to the durable thread while it is in flight.
    It disappears on `done`, when the re-read brings back the server's version
    of the same two messages.
  */
  const liveThread: ThreadMessage[] = [...detail.thread];
  if (sent !== null) {
    liveThread.push({ kind: 'user', id: 'pending-user', text: sent });
  }
  if (streaming || streamed.length > 0) {
    liveThread.push(
      streamed.length > 0
        ? { kind: 'agent', id: 'pending-agent', text: streamed, time: '' }
        : { kind: 'status', id: 'pending-status', text: 'Thinking…' },
    );
  }

  /*
    The read-only excerpt. While it is in flight the pane says so rather than
    rendering an empty transcript — an empty thread reads as "this
    conversation had nothing in it", which is a claim about the content, not
    about the fetch. On failure the alert above carries the news and the pane
    stays blank rather than repeating it.
  */
  const pastThread: ThreadMessage[] =
    pastDetail !== null
      ? pastDetail.thread
      : pastError !== null
        ? []
        : [{ kind: 'status', id: 'past-loading', text: 'Opening…' }];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-6 pt-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ChevronLeft size={16} />
          </Button>
          <AgentTile agent={agent} size={30} />
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] font-medium">{agent.name}</span>
            <AgentStateLabel agent={agent} />
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) => onTab(v as AgentTab)}
          className="mt-3"
        >
          <TabsList className="h-auto bg-transparent p-0">
            {(
              [
                ['chat', 'Conversation'],
                ['did', 'What it did'],
                ['files', 'Files'],
                ['memory', 'Memory'],
              ] as const
            ).map(([v, label]) => (
              <TabsTrigger
                key={v}
                value={v}
                className="rounded-none border-b-2 border-transparent bg-transparent px-0 pb-3 pt-0 text-[13px] text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none [&:not(:first-child)]:ml-6"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === 'chat' && (
            <>
              {past && (
                <div className="flex items-center gap-2.5 border-b border-border bg-muted px-6 py-2.5">
                  <Archive size={13} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
                    {past.title} · {past.meta} · read-only
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPastId(null)}
                    className="h-7 gap-1.5 text-[12px] text-primary"
                  >
                    Back to current
                    <ArrowRight size={11} />
                  </Button>
                </div>
              )}
              {turnError !== null && !past && (
                /*
                  One sentence about one event, then the raw detail, then the
                  way out.

                  This used to concatenate our prose with whatever string the
                  transport handed back — "That reply did not finish. We lost
                  the connection before the reply finished. Send it again to
                  pick up where we left off. Send it again when you are ready."
                  — three sentences saying one thing twice, with a raw
                  `(500)` landing mid-paragraph. Worse, "send it again" meant
                  RETYPE: the composer clears its draft on send. We still hold
                  the text in `sent`, so the honest control is a button that
                  re-fires it.
                */
                <div className="px-6 pt-4">
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>
                        That reply didn&rsquo;t finish — we may have lost the
                        connection. Nothing you sent was lost.
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {turnError}
                      </span>
                      <div className="flex items-center gap-2">
                        {sent !== null && (
                          <Button
                            size="sm"
                            onClick={() => void send(sent)}
                            disabled={streaming}
                          >
                            Resend
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setTurnError(null)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              {past && pastError !== null && (
                <div className="px-6 pt-4">
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-col items-start gap-2">
                      <span>
                        We could not open that conversation. It may have been
                        deleted since this list was drawn.
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {pastError}
                      </span>
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              <AgentConversation
                agent={agent}
                thread={past ? pastThread : liveThread}
                decisions={decisions}
                readOnly={past !== null}
                busy={streaming}
                onSend={(text) => void send(text)}
                onApprove={onApprove}
                onDismiss={onDismiss}
                onUndo={onUndo}
                {...(busyIds !== undefined ? { busyIds } : {})}
                {...(notices !== undefined ? { notices } : {})}
              />
            </>
          )}

          {tab === 'did' && (
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <ActivityFeed
                events={activity}
                agents={agents}
                agentId={agent.id}
                {...(activityHasMore !== undefined ? { hasMore: activityHasMore } : {})}
                {...(onActivityLoadMore ? { onLoadMore: onActivityLoadMore } : {})}
                {...(activityLoading !== undefined ? { loading: activityLoading } : {})}
                {...(activityError !== undefined ? { error: activityError } : {})}
              />
            </div>
          )}

          {tab === 'files' && (
            <AgentFiles files={detail.files} agentName={agent.name} />
          )}

          {tab === 'memory' && (
            <AgentMemory
              docs={detail.memory}
              agentName={agent.name}
              onSaveRules={async (body) => {
                const saved = await workspaceApi.saveRules(agent.id, body);
                // Re-read so what the tab shows is what the server stored, not
                // what we typed. If the write landed somewhere unexpected, the
                // user finds out here rather than three weeks later.
                onChanged();
                // The editor adopts the STORED text (the writer normalizes),
                // so it never sits one newline away from "saved".
                return saved.body;
              }}
            />
          )}
        </div>

        {tab === 'chat' && (
          <AgentRail
            detail={detail}
            openPastId={pastId}
            onOpenPast={setPastId}
          />
        )}
      </div>
    </div>
  );
}
