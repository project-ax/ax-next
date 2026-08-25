/**
 * The agent workspace — the shell.
 *
 * Mounted at `/workspace` — and at `/`, which the flag also claims — behind
 * the `agentWorkspacePreview` feature flag, on
 * the real host: `App.tsx` supplies the signed-in user, `/api/workspace/*`
 * supplies the board, and sending a message goes to the shipped chat wire.
 *
 * The demo strip that used to sit along the top — three canned scenarios and a
 * global stop — went with the mock backend it drove. So did the "New agent"
 * view. What is left renders what the host actually reports, and shows an
 * honest empty state everywhere the host has nothing yet. A surface with three
 * convincing fake panels is worse than one with three honest empty ones,
 * because only the second tells you what still has to be built.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/lib/workspace-api';
import { useActivityFeed } from '@/lib/workspace-activity';
import { useDecisionQueue } from '@/lib/workspace-decisions';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { hydrateTheme } from '@/lib/theme';
import { isOpenDecision, type ActivityEvent } from '@/lib/workspace-types';
import { ActivityFeed } from './ActivityFeed';
import { AgentView, type AgentTab } from './AgentView';
import { HomeComposer } from './HomeComposer';
import { TodayView } from './TodayView';
import { Segmented, WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';

type Route =
  | { kind: 'today' }
  | { kind: 'activity' }
  | { kind: 'agent'; id: string; tab: AgentTab };

/** "Friday, August 21" — the date the queue is describing. */
function today(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

/** Local calendar day, for the "done today" count — never the server's day. */
function isLocalToday(at: string): boolean {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * The instant the reader's local day began — the floor `isLocalToday` accepts,
 * as a number so a feed cursor can be compared against it.
 */
function startOfLocalToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * How many `done` rows landed today — or `undefined` when the pages we hold
 * cannot back that number.
 *
 * `feed.events` is only what has been fetched, and on Today nothing ever calls
 * `loadMore`, so it is page one: fifty rows. A day busier than that used to
 * report whatever fraction fitted, as a flat fact, with nothing on screen to
 * say it was a floor.
 *
 * The feed is strictly newest-first, so the count is true the moment the
 * fetched window reaches back PAST local midnight — every row from today is
 * then already in hand. That is the gate. `null` (nothing older exists) counts
 * as reaching past it; a cursor sitting exactly ON midnight does not, because
 * the cursor is exclusive and a row at that same instant can be cut.
 *
 * Deliberately NOT gated on `!feed.hasMore`. Exhaustion is the right test for
 * Activity's "N entries", which claims the whole record — but the
 * workspace-wide feed on a busy account essentially never exhausts, so reusing
 * it here would hide the line permanently instead of only while the window is
 * short. That trades an undercount for a disappearance.
 *
 * `undefined` rather than `0`: a zero is a claim too, and this is the case
 * where we have none to make. `TodayView` drops the line for either.
 *
 * One case this does NOT catch, deliberately: before the first page lands the
 * cursor is still its initial `null`, so the gate passes over an empty list and
 * this returns 0. What keeps that off screen is `TodayView`'s own positive
 * test, not this function — the honesty guard is genuinely split across the
 * two, and it is the same unlanded-page zero the Activity subtitle below
 * mentions. Folding it in here would mean a `loading` branch no rendered output
 * can distinguish from this one, i.e. a behaviour no test could hold.
 */
function doneTodayFrom(feed: {
  events: ActivityEvent[];
  nextBefore: string | null;
}): number | undefined {
  const reachesPastMidnight =
    feed.nextBefore === null || Date.parse(feed.nextBefore) < startOfLocalToday();
  if (!reachesPastMidnight) return undefined;
  return feed.events.filter((e) => e.kind === 'done' && isLocalToday(e.at))
    .length;
}

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <Inner />
    </WorkspaceProvider>
  );
}

function Inner() {
  const { board, error, loading, refresh } = useWorkspace();
  const [route, setRoute] = useState<Route>({ kind: 'today' });
  /**
   * The single activity collection, scoped to the agent tab when one is open
   * and to the whole workspace otherwise (design §7 — one feed and a filter).
   * Called once here rather than once per consumer: Today's "done today"
   * count, the Activity page, and a given agent's "What it did" tab all read
   * off this same fetch.
   */
  const feed = useActivityFeed(route.kind === 'agent' ? route.id : undefined);
  /**
   * The queue, fetched once here and read by three places: Today's rows, the
   * sidebar's pending badge, and the in-thread approval card on an agent's
   * tab. One collection, one fetch, one array — the card in the thread and the
   * row in Today are literally the same object, so resolving one resolves both
   * without a second read and without two copies drifting apart on screen.
   */
  const queue = useDecisionQueue();
  const [filter, setFilter] = useState<'needs' | 'working'>('needs');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rosterOpen, setRosterOpen] = useState(true);
  const [version, setVersion] = useState(0);
  /**
   * A turn the home composer started. `AgentView` picks it up on mount and
   * streams the reply, so the message the user typed on Today does not vanish
   * on the way to the agent's tab.
   */
  const [pendingReply, setPendingReply] = useState<{
    agentId: string;
    reqId: string;
    text: string;
  } | null>(null);

  useEffect(() => {
    hydrateTheme();
  }, []);

  const bump = () => setVersion((v) => v + 1);

  /**
   * `undefined` when the pages we hold cannot back the number — see
   * `doneTodayFrom`. Passed as an ABSENT prop rather than an explicit
   * `undefined` (`exactOptionalPropertyTypes`), which is the same thing to
   * `TodayView` and the shape the rest of this file already uses.
   */
  const doneToday = doneTodayFrom(feed);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6">
        <div className="flex max-w-[440px] flex-col items-center gap-4 text-center">
          <h1 className="text-[17px] font-medium">
            We could not load your workspace.
          </h1>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            The server did not answer when we asked what your agents are up to.
            It is usually a blip. Nothing is lost — your agents keep whatever
            they were doing, and this page only reads.
          </p>
          <Button onClick={() => void refresh()}>Try again</Button>
          {/*
            The raw detail used to print here (`workspace /board → 401`). It is
            a request path and a number — nothing a reader can act on — and
            `lib/http.ts` sends it to the console for operators now (TASK-288).
          */}
        </div>
      </div>
    );
  }

  if (loading && !board) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-[13px] text-muted-foreground">
        Loading your workspace…
      </div>
    );
  }

  if (!board) {
    /*
      Near-unreachable: `refresh` sets either the board or the error. If we do
      land here, the reader needs something to DO, not a shrug — "nothing to
      show yet" reads as a verdict on their workspace when it is a verdict on
      our fetch.
    */
    return (
      <div className="flex h-screen items-center justify-center gap-3 bg-background text-[13px] text-muted-foreground">
        <span>We couldn&rsquo;t find anything to load. Refreshing usually sorts it.</span>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  /*
    The sidebar badge counts only what we actually read. A failed queue read
    leaves it at zero — which is the same number a genuinely empty queue shows,
    and that is the honest ambiguity: Today itself says out loud that it could
    not check. A badge cannot carry that sentence, so it does not try to.
  */
  const pending = queue.decisions.filter(isOpenDecision).length;
  const workingCount = board.agents.filter((a) => a.state === 'working').length;

  const openAgent = (id: string) =>
    setRoute({ kind: 'agent', id, tab: 'chat' });

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <div className="flex min-h-0 flex-1">
        <WorkspaceSidebar
          agents={board.agents}
          route={route.kind}
          activeAgentId={route.kind === 'agent' ? route.id : null}
          pendingCount={pending}
          rosterOpen={rosterOpen}
          onRoster={setRosterOpen}
          onToday={() => setRoute({ kind: 'today' })}
          onActivity={() => setRoute({ kind: 'activity' })}
          onAgent={openAgent}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {route.kind === 'today' && (
            <>
              <WorkspaceHeader title="Today" subtitle={today()}>
                <Segmented
                  value={filter}
                  onValueChange={setFilter}
                  options={[
                    { value: 'needs', label: 'Needs you', count: pending },
                    { value: 'working', label: 'Working', count: workingCount },
                  ]}
                />
              </WorkspaceHeader>
              <div className="flex-1 overflow-y-auto">
                <TodayView
                  decisions={queue.decisions}
                  agents={board.agents}
                  filter={filter}
                  expandedId={expandedId}
                  onExpand={setExpandedId}
                  onOpenAgent={openAgent}
                  onApprove={queue.approve}
                  onDismiss={queue.dismiss}
                  onUndo={queue.undo}
                  busyIds={queue.busyIds}
                  notices={queue.notices}
                  error={queue.error}
                  loading={queue.loading}
                  onRetry={() => void queue.refresh()}
                  onSeeActivity={() => setRoute({ kind: 'activity' })}
                  {...(doneToday !== undefined ? { doneToday } : {})}
                />
              </div>
              <HomeComposer
                agents={board.agents}
                onSend={async (agentId, text) => {
                  const { reqId } = await workspaceApi.sendMessage({
                    agentId,
                    conversationId: null,
                    text,
                  });
                  setPendingReply({ agentId, reqId, text });
                  setRoute({ kind: 'agent', id: agentId, tab: 'chat' });
                }}
              />
            </>
          )}

          {route.kind === 'activity' && (
            <>
              {/*
                "12 entries" is a claim about the WHOLE record, and
                `feed.events.length` only counts the pages fetched so far. So
                the subtitle appears only once there is nothing left to page
                into — at which point the two numbers are the same one. While
                more is loadable the count is simply absent, along with the
                zero that shows briefly on every mount before the first page
                lands. Same rule as Today's summary line — a count is rendered
                only when it is both positive and true — but a different test
                for "true". This number claims the whole record, so only
                exhaustion settles it; Today's claims a single day, and
                `doneTodayFrom` settles that the moment the fetched window
                reaches back past local midnight.
              */}
              <WorkspaceHeader
                title="Activity"
                {...(feed.events.length > 0 && !feed.hasMore
                  ? {
                      subtitle: `${feed.events.length} ${
                        feed.events.length === 1 ? 'entry' : 'entries'
                      }`,
                    }
                  : {})}
              />
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[900px] px-6 pb-6">
                  <ActivityFeed
                    events={feed.events}
                    agents={board.agents}
                    onOpenAgent={openAgent}
                    hasMore={feed.hasMore}
                    onLoadMore={feed.loadMore}
                    loading={feed.loading}
                    error={feed.error}
                  />
                </div>
              </div>
            </>
          )}

          {route.kind === 'agent' && (
            <AgentView
              agentId={route.id}
              tab={route.tab}
              onTab={(t) => setRoute({ ...route, tab: t })}
              decisions={queue.decisions}
              onApprove={queue.approve}
              onDismiss={queue.dismiss}
              onUndo={queue.undo}
              busyIds={queue.busyIds}
              notices={queue.notices}
              /*
                The queue's error travels with its rows. Today has always taken
                both; this tab took the rows and left the error behind, so a
                failed queue read reached it as an empty `decisions` array and
                the thread simply showed no approval cards — the same silence a
                conversation with nothing waiting in it shows.
              */
              decisionsError={queue.error}
              onDecisionRaised={() => void queue.refresh()}
              activity={feed.events}
              activityHasMore={feed.hasMore}
              onActivityLoadMore={feed.loadMore}
              activityLoading={feed.loading}
              activityError={feed.error}
              agents={board.agents}
              onBack={() => setRoute({ kind: 'today' })}
              version={version}
              pendingReply={
                pendingReply && pendingReply.agentId === route.id
                  ? { reqId: pendingReply.reqId, text: pendingReply.text }
                  : null
              }
              onPendingReplyConsumed={() => setPendingReply(null)}
              onChanged={async () => {
                await Promise.all([refresh(), queue.refresh()]);
                bump();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
