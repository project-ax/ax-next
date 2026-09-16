/**
 * The agent workspace — the shell.
 *
 * Mounted at `/workspace/*` — and at `/`, which the flag also claims and the
 * shell rewrites to `/workspace` on mount — behind the
 * `agentWorkspacePreview` feature flag, on the real host: `App.tsx` supplies
 * the signed-in user, `/api/workspace/*` supplies the board, and sending a
 * message goes to the shipped chat wire.
 *
 * Views are addressable: `/workspace`, `/workspace/activity`, and
 * `/workspace/agents/<id>[/<tab>]`. The grammar lives in
 * `@/lib/workspace-route`; this file owns the history calls. No server route
 * backs those paths and none is needed — `@ax/static-files` serves the SPA on
 * any unclaimed path.
 *
 * The demo strip that used to sit along the top — three canned scenarios and a
 * global stop — went with the mock backend it drove. So did the "New agent"
 * view. What is left renders what the host actually reports, and shows an
 * honest empty state everywhere the host has nothing yet. A surface with three
 * convincing fake panels is worse than one with three honest empty ones,
 * because only the second tells you what still has to be built.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  workspaceApi,
  WorkspaceApiError,
} from '@/lib/workspace-api';
import { useActivityFeed } from '@/lib/workspace-activity';
import { useDecisionQueue } from '@/lib/workspace-decisions';
import {
  useWorkspaceGrants,
  workspaceGrantActions,
} from '@/lib/workspace-grant-store';
import { WorkspaceProvider, useWorkspace } from '@/lib/workspace-context';
import { hydrateTheme } from '@/lib/theme';
import { KICKOFF_TEXT } from '@/lib/bootstrap-kickoff';
import { toastActions } from '@/lib/toast-store';
import { isOpenDecision, type ActivityEvent } from '@/lib/workspace-types';
import {
  parseWorkspaceRoute,
  workspaceRoutePath,
  type WorkspaceRoute,
} from '@/lib/workspace-route';
import { ActivityFeed } from './ActivityFeed';
import { AgentView } from './AgentView';
import { HomeComposer } from './HomeComposer';
import { TodayView } from './TodayView';
import { Segmented, WorkspaceHeader } from './WorkspaceHeader';
import { WorkspaceSidebar } from './WorkspaceSidebar';

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

export interface WorkspaceShellProps {
  /**
   * Opens Settings. Threaded down to the `UserMenu` in the sidebar, which is
   * where the entry lives — see the note in `App.tsx`. Optional so the shell
   * still renders in tests that do not care, but the app always passes it: a
   * `UserMenu` without it shows a Settings item that does nothing.
   */
  onOpenAdminSettings?: (() => void) | undefined;
  /**
   * Opens the create-an-agent flow. Threaded to `WorkspaceSidebar`'s
   * "New agent…" row, same shape and same reason as `onOpenAdminSettings`:
   * optional so tests that don't care can omit it, but the app always passes
   * it, because a row that renders and does nothing is worse than no row.
   */
  onCreateAgent?: (() => void) | undefined;
  /**
   * The id of a just-bootstrapped agent still waiting for its kickoff — set
   * by `App.tsx` when `FirstRunAutoCreate`'s `onDone` fires on this surface.
   * See the effect below for why the workspace cannot reuse
   * `bootstrapKickoff`.
   */
  kickoffAgentId?: string | null | undefined;
  /** Fired once the kickoff for `kickoffAgentId` has been sent (or failed). */
  onKickoffConsumed?: (() => void) | undefined;
}

export function WorkspaceShell({
  onOpenAdminSettings,
  onCreateAgent,
  kickoffAgentId,
  onKickoffConsumed,
}: WorkspaceShellProps = {}) {
  return (
    <WorkspaceProvider>
      <Inner
        onOpenAdminSettings={onOpenAdminSettings}
        onCreateAgent={onCreateAgent}
        kickoffAgentId={kickoffAgentId}
        onKickoffConsumed={onKickoffConsumed}
      />
    </WorkspaceProvider>
  );
}

function Inner({
  onOpenAdminSettings,
  onCreateAgent,
  kickoffAgentId,
  onKickoffConsumed,
}: WorkspaceShellProps) {
  const { board, error, loading, refresh } = useWorkspace();
  /**
   * The open view, and the URL, kept as one thing.
   *
   * This used to be plain component state seeded at Today, which meant every
   * reload was a context loss, nothing in the workspace could be linked or
   * shared, and Back jumped straight out of the workspace instead of
   * unwinding it. Acceptable while this was a preview at a URL you had to
   * know; TASK-324 made it the landing surface.
   *
   * Hand-rolled rather than a router dependency: three views and one tab
   * axis, all inside one component, is not a routing table. `useState`'s
   * initializer reads the URL once — `parseWorkspaceRoute` never throws, so a
   * mangled link degrades to Today instead of blanking the shell.
   */
  const [route, setRoute] = useState<WorkspaceRoute>(() =>
    parseWorkspaceRoute(window.location.pathname),
  );

  /**
   * Move, and leave an address behind. Pushes only when the URL would
   * actually change, so re-selecting the view already on screen doesn't stack
   * a history entry the reader then has to press Back through twice.
   */
  const navigate = useCallback((next: WorkspaceRoute) => {
    setRoute(next);
    const path = workspaceRoutePath(next);
    if (path !== window.location.pathname) {
      window.history.pushState(null, '', path);
    }
  }, []);

  /**
   * Back / forward. The URL is the source of truth on the way in, exactly as
   * it is at mount.
   *
   * Every entry this can see is one we pushed, so it is always a workspace
   * path: `popstate` fires only for SAME-DOCUMENT entries, and every other
   * surface in the app (`/chat`, `/admin`, `/setup`) is reached by a full
   * document load. Backing out of the workspace entirely is therefore a real
   * navigation and never arrives here.
   */
  useEffect(() => {
    const onPop = () => setRoute(parseWorkspaceRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /**
   * Canonicalize whatever we were opened with, once.
   *
   * `/` is a real entry point — App renders the workspace there when the
   * preview is on — and so are the non-canonical spellings of a view
   * (`/workspace/agents/x/chat`, a trailing slash, an unknown tab). Left
   * alone, the same view would have several addresses and "copy the URL"
   * would be a coin flip.
   *
   * REPLACE, never push: a push here would insert a phantom entry between the
   * visitor and wherever they came from, so their first Back would land on us
   * again. Search and hash are carried over — they are not ours to drop, and
   * a link with a `?ref=` on it is the ordinary case.
   */
  useEffect(() => {
    const canonical = workspaceRoutePath(
      parseWorkspaceRoute(window.location.pathname),
    );
    if (window.location.pathname !== canonical) {
      window.history.replaceState(
        null,
        '',
        canonical + window.location.search + window.location.hash,
      );
    }
  }, []);

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
  /*
    Open capability grants (TASK-350). A store with TWO producers that meet in
    one place — `raise()` — so a grant is one row however it arrives:

      - the turn stream (`AgentView` → `onPermissionRequest`), for a grant
        raised while a turn is live; and
      - the mount fetch below (`GET /api/workspace/grants`, TASK-373), for one
        raised while the workspace was closed — the buffer holds pending cards
        past the turn, and this read-back is what makes them answerable.

    `raise()` replaces in place on the subject key, so a grant that is BOTH
    fetched and streamed stays one row, last writer wins. (Today the two
    payloads are the same buffered card, so they cannot disagree; nothing here
    needs a deeper merge rule than that.) A second, hydrate-flavoured entry
    point is exactly how two rows for one grant would happen.
  */
  const grants = useWorkspaceGrants();
  /**
   * How the mount read-back went. `null` = read fine (or not attempted);
   * `'failed'` = a blip, retryable; `'expired'` = 401, the session ran out and
   * no retry can work — offered sign-in instead, the same split the queue
   * read makes. A failed read can NEVER be allowed to render as an empty
   * day: Today's headline takes `grantsError` and refuses the empty sentence.
   */
  const [grantsError, setGrantsError] = useState<
    'expired' | 'failed' | null
  >(null);

  /**
   * TASK-373 — read back what is waiting, once, at mount. Together with the
   * live stream this covers the gap between them: a grant raised by an agent
   * working unattended lands in the buffer, survives the turn ending and the
   * page reloading, and is here when Today opens.
   *
   * A failed read is SURFACED, not swallowed: it sets `grantsError`, which
   * Today renders as its own alert (with a real retry on the blip branch).
   * The stream remains the live path for anything raised on an open turn, so
   * the store keeps whatever rows it already has — the failure only means the
   * read-back contributed nothing, never that the day was empty.
   *
   * Unmount cancels the apply rather than racing the store (the store is
   * module-level and outlives this component).
   *
   * KNOWN RACE, accepted deliberately: a response that lands AFTER the person
   * answered the same subject locally would re-raise an answered grant — a
   * ghost row whose POST re-asks a settled question. The window is one fetch
   * round-trip at mount, which is orders of magnitude shorter than the time
   * it takes to see a row and act on it, and the same race already exists on
   * the stream path (a replayed frame in flight while a person answers —
   * TASK-350). If it is ever observed, the fix belongs in the store (resolve
   * remembers when, raise declines re-raising a key settled after a stated
   * instant), not here.
   */
  const fetchGrants = useCallback((): (() => void) => {
    let cancelled = false;
    workspaceApi
      .grants()
      .then((page) => {
        if (cancelled) return;
        setGrantsError(null);
        for (const g of page.grants) {
          workspaceGrantActions.raise(g.request, g.conversationId);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[workspace] pending grants could not be read', e);
        setGrantsError(
          e instanceof WorkspaceApiError && e.status === 401
            ? 'expired'
            : 'failed',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => fetchGrants(), [fetchGrants]);

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
    /**
     * The conversation the send created. Carried rather than re-derived: the
     * agent view streams this turn BEFORE its own read resolves, so without
     * this it has no conversation to attribute the turn to — and a capability
     * grant raised on it would arrive unanswerable (TASK-350 review).
     */
    conversationId: string;
  } | null>(null);

  useEffect(() => {
    hydrateTheme();
  }, []);

  const bump = () => setVersion((v) => v + 1);

  /**
   * One turn-start on this surface, two callers: the home composer (a person
   * picking or being routed to an agent) and the kickoff effect below (a
   * freshly-bootstrapped agent nobody has greeted yet). Both need the exact
   * same three steps — POST the message, remember it as the reply
   * `AgentView` should stream, and move the reader to that agent's chat tab —
   * and two copies of that sequence would be two sources of truth for what
   * "starting a turn" means. The rejection is NOT caught here: `HomeComposer`
   * needs it to keep the user's draft on a failed send (its own comment on
   * `dispatch` documents the past bug where a swallowed rejection lost the
   * draft), and the kickoff effect needs it to decide whether to toast.
   */
  const startTurn = useCallback(
    async (agentId: string, text: string): Promise<void> => {
      const { reqId, conversationId } = await workspaceApi.sendMessage({
        agentId,
        conversationId: null,
        text,
      });
      setPendingReply({ agentId, reqId, text, conversationId });
      navigate({ kind: 'agent', id: agentId, tab: 'chat' });
    },
    [navigate],
  );

  /**
   * TASK-249 — the kickoff for an agent just created from THIS surface.
   *
   * `bootstrapKickoff` (the chat runtime's module-level trigger/register
   * bridge) cannot serve the workspace: its only registrant is
   * `useChatThreadRuntime`, which assistant-ui calls only from inside
   * `_RuntimeBinder`, reached only under an `AssistantRuntimeProvider` — and
   * the workspace branch of `App.tsx` deliberately mounts none. `trigger()`
   * would set `_pending` and nothing would ever consume it: a created agent
   * that never says anything. So the workspace sends its own kickoff, through
   * the same `startTurn` a person's own first message uses.
   *
   * Ref-guarded on the id, mirroring `AgentView`'s `consumedReqId` /
   * `onPendingReplyConsumed` pattern, so a re-render with the same
   * `kickoffAgentId` (or the id sticking around after `App.tsx` reacts to
   * `onKickoffConsumed`) does not resend it.
   *
   * ABOVE the `error` / `loading` / `!board` early returns — which the rules
   * of hooks require anyway, and which is also what we want: this effect only
   * calls `navigate` (route state + a URL push) and `startTurn` (a POST),
   * neither of which needs the board, and `AgentView` picks up `pendingReply`
   * once the board — and it — eventually mount.
   *
   * One rare consequence, accepted (review): if the board read FAILS while a
   * kickoff is pending, the `'hi'` is still POSTed and the route still moves,
   * under the error screen. The turn is real and server-side, so nothing is
   * lost; it just is not streamed, and a refresh shows it. Holding the kickoff
   * back until the board lands would trade that for the worse failure — a
   * brand-new agent left permanently un-greeted because one read blipped.
   */
  const kickedOffId = useRef<string | null>(null);
  useEffect(() => {
    if (!kickoffAgentId) return;
    if (kickedOffId.current === kickoffAgentId) return;
    kickedOffId.current = kickoffAgentId;
    const id = kickoffAgentId;
    onKickoffConsumed?.();
    startTurn(id, KICKOFF_TEXT).catch(() => {
      // The agent exists, it just has not been greeted — never silently.
      toastActions.error(
        'Your agent is ready, but we could not say hello for you.',
        'Send it a message to get started — it will introduce itself.',
      );
      navigate({ kind: 'agent', id, tab: 'chat' });
    });
    // `startTurn` and `navigate` are useCallback-stable; `onKickoffConsumed`
    // may not be, but the ref guard above is what actually prevents a
    // resend, so a changed identity re-running this effect is harmless.
  }, [kickoffAgentId, startTurn, navigate, onKickoffConsumed]);

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
    The sidebar badge and the "Needs you" tab count the same queue Today's
    headline counts: open decisions plus open grants. Grants used to be
    missing here, which put two "waiting on you" numbers on one screen that
    could disagree the moment a grant was open — the headline counted it, the
    badge did not. Same honesty rule as the headline: a failed read (queue or
    grants) contributes what it actually read, and the surface itself says
    where it could not check. A badge cannot carry that sentence, so it does
    not try to.
  */
  const pending =
    queue.decisions.filter(isOpenDecision).length + grants.grants.length;
  const workingCount = board.agents.filter((a) => a.state === 'working').length;

  const openAgent = (id: string) =>
    navigate({ kind: 'agent', id, tab: 'chat' });

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
          onToday={() => navigate({ kind: 'today' })}
          onActivity={() => navigate({ kind: 'activity' })}
          onAgent={openAgent}
          onOpenAdminSettings={onOpenAdminSettings}
          onCreateAgent={onCreateAgent}
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
                  grants={grants.grants}
                  onGrantResolved={workspaceGrantActions.resolve}
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
                  grantsError={grantsError}
                  onRetryGrants={fetchGrants}
                  onSeeActivity={() => navigate({ kind: 'activity' })}
                  {...(doneToday !== undefined ? { doneToday } : {})}
                />
              </div>
              <HomeComposer agents={board.agents} onSend={startTurn} />
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
              onTab={(t) => navigate({ ...route, tab: t })}
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
              onBack={() => navigate({ kind: 'today' })}
              version={version}
              pendingReply={
                pendingReply && pendingReply.agentId === route.id
                  ? {
                      reqId: pendingReply.reqId,
                      text: pendingReply.text,
                      conversationId: pendingReply.conversationId,
                    }
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
