/**
 * The event stream, rendered once.
 *
 * The design this came from had three components showing the same rows: a
 * "Done" filter on Today, a per-agent "What it did" tab, and a global Activity
 * page. That is one source of truth rendered three ways, which is exactly the
 * shape that drifts. Here there is one feed and a filter; the per-agent tab is
 * this component with `agentId` set.
 *
 * PRESENTATIONAL ONLY. Scoping to one agent, paging, and the request itself
 * are `useActivityFeed`'s job (`lib/workspace-activity.ts`) — this component
 * just renders whatever page of `events` it is handed, plus the state of that
 * fetch (`loading` / `error` / `hasMore`).
 *
 * `events` carries an ISO instant and nothing else (see `ActivityEvent` in
 * `workspace-types.ts` for why: a server-computed "Today" / "4:12 PM" is only
 * right for a reader in the server's timezone). Everything a reader sees —
 * which day a row falls under, what its clock reads — is computed HERE, from
 * the LOCAL date, at render time.
 */
import {
  AlertTriangle,
  Check,
  CheckCheck,
  CircleDashed,
  Hand,
  TimerOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';
import { localDayKey, localDayLabel, localTime } from '@/lib/workspace-time';

const KIND: Record<ActivityEvent['kind'], { Icon: LucideIcon; tone: string }> = {
  done: { Icon: Check, tone: 'text-primary' },
  held: { Icon: Hand, tone: 'text-warning' },
  approved: { Icon: CheckCheck, tone: 'text-primary' },
  dismissed: { Icon: X, tone: 'text-muted-foreground' },
  working: { Icon: CircleDashed, tone: 'text-primary' },
  // Quiet, like `dismissed`, and deliberately NOT `text-destructive`: a
  // decision nobody answered is not a failure, and the row's own sentence says
  // nothing happened. An alarm colour over it would be the surface shouting
  // about an outcome the copy is telling the reader not to worry about.
  expired: { Icon: TimerOff, tone: 'text-muted-foreground' },
  stopped: { Icon: AlertTriangle, tone: 'text-destructive' },
};

interface Props {
  events: ActivityEvent[];
  agents: WorkspaceAgent[];
  /** When set, the feed is scoped to one agent and drops the agent column. */
  agentId?: string;
  onOpenAgent?: (id: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
  /** Separate from an empty `events` — "we could not read it" is not "there is nothing". */
  error?: string | null;
  /**
   * The rows in hand do NOT describe the collection this feed is being asked
   * for — hold everything and show placeholders instead.
   *
   * `useActivityFeed` is one hook serving two collections (the whole workspace
   * on Activity, one agent on a "What it did" tab) and it re-scopes in an
   * EFFECT, which runs after the commit. So on the render where the reader
   * switches, `events` still holds the collection they just left. The caller
   * knows this by comparing the feed's `scope` against the one it asked for;
   * this prop is that answer (TASK-453).
   *
   * Why placeholders rather than the two obvious alternatives — both of which
   * put a false sentence on screen:
   *
   * - HOLDING the old rows cannot be rescued by dimming them. A per-agent tab
   *   drops the agent column below, so the previous scope's rows render
   *   UNATTRIBUTED under the new agent's name. "Dimmed" says something about
   *   freshness; it says nothing about ownership, and the reader has no way
   *   left to tell whose row they are looking at.
   * - BLANKING lands on the empty state below, whose copy is a sentence —
   *   "The record of what Quill does is empty so far" — and that is a claim we
   *   have not read anything to back. It is the "your agent did nothing"
   *   misreading this file's empty copy was already rewritten once to avoid.
   *
   * Placeholders state the only true thing: we are reading it.
   *
   * Also covers the first page of a fresh mount internally — same false
   * emptiness, arrived at by a different route.
   */
  awaitingScope?: boolean;
}

interface Bucket {
  key: string;
  label: string;
  rows: ActivityEvent[];
}

/**
 * Groups by local calendar day, in the order rows are encountered — the feed
 * hands us newest-first pages, so first-encountered is newest-first buckets
 * too. Computed fresh on every render against `new Date()`, never against
 * anything carried on the wire, so "Today" stays true across midnight without
 * a refetch.
 */
function bucket(rows: ActivityEvent[]): Bucket[] {
  const now = new Date();
  const order: string[] = [];
  const byKey = new Map<string, ActivityEvent[]>();
  const labelFor = new Map<string, string>();

  for (const e of rows) {
    const d = new Date(e.at);
    const key = Number.isNaN(d.getTime()) ? 'unknown' : localDayKey(d);
    if (!byKey.has(key)) {
      order.push(key);
      byKey.set(key, []);
      labelFor.set(key, Number.isNaN(d.getTime()) ? 'Unknown date' : localDayLabel(d, now));
    }
    byKey.get(key)!.push(e);
  }

  return order.map((key) => ({
    key,
    label: labelFor.get(key)!,
    rows: byKey.get(key)!,
  }));
}

/**
 * What the feed shows while it cannot honestly show anything else.
 *
 * Shaped like the real thing — a day heading over a card of rows — so the page
 * does not jump when the rows land. Three rows, not a page of fifty: this is a
 * "we are reading it" sign, not a guess at how much is coming.
 *
 * A sentence in it, because a pile of pulsing rectangles is nothing at all
 * without CSS — just empty divs, indistinguishable from the empty state it
 * replaced, with nothing for a screen reader or a test to read. The sentence
 * is plain text in the accessibility tree: a screen reader reading the page
 * finds it, and jsdom (no CSS, no pulse either) can assert it.
 *
 * Deliberately NOT a live region, and it does not announce (TASK-501). It
 * used to carry `role="status"`, which reads as an announcement guarantee it
 * could not keep: the placeholder is inserted in the same commit that gives it
 * its text, and a live region created and filled together is announced
 * inconsistently (VoiceOver often skips it). Mounting a region empty first is
 * not available either — the fresh-mount case is born in this state. And the
 * announcement is not wanted: the reader got here by pressing a tab or opening
 * a page, which their screen reader already reported, and "Reading the
 * record…" spoken on every switch is chatter that often lands after the rows
 * it describes. The rows arriving are the news, not the wait.
 */
function FeedPlaceholder() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Reading the record…</span>
      <div>
        <div className="mb-2.5 flex items-center gap-2">
          <Skeleton className="h-3 w-24" />
        </div>
        <div
          aria-hidden="true"
          className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-rule-soft px-5 py-3 last:border-b-0"
            >
              <Skeleton className="size-3 shrink-0 rounded-full" />
              <Skeleton className="h-3 min-w-0 flex-1" />
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ActivityFeed({
  events,
  agents,
  agentId,
  onOpenAgent,
  hasMore = false,
  onLoadMore,
  loading = false,
  error = null,
  awaitingScope = false,
}: Props) {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  /*
    FIRST, ahead of `error` as well as the rows: a scope change resets the
    error alongside the list, so on the stale frame `error` belongs to the
    collection we just left too. "We could not load Quill's record" is no more
    true of Tern's tab than Quill's rows are.
  */
  const placeholder = awaitingScope || (loading && events.length === 0);

  /*
    False for exactly the first commit of this mount, then true forever.

    A feed can MOUNT already failed: the hook lives in WorkspaceShell, so
    leaving the "What it did" tab and coming back remounts this component
    with `error` still set (TASK-545). Rendered straight into the region, the
    failure would be born with it — a live region created and filled in one
    commit, which screen readers announce inconsistently, if at all.

    So on that first commit the failure renders BESIDE the region, at the
    same spot (the region takes no room while empty), and the passive effect
    below moves it inside. The region exists empty for a whole commit — and,
    because it is `useEffect` rather than `useLayoutEffect`, for a paint —
    and then gains its text: a change a screen reader reports. Sighted
    readers see nothing move. The alternative, holding the failure back
    until armed, was the one-frame blank TASK-541 declined for this case.
  */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(true);
  }, []);

  /*
    What the polite region below says. Nothing while a read is in flight —
    and that includes a "Try again", where the hook KEEPS `error` set: it is
    what makes a second identical failure audible (TASK-541). The region
    empties when the retry starts and refills when it fails, two real commits
    a network round trip apart. Rendering on `error !== null` alone left the
    region's text unchanged across the retry, and an unchanged live region is
    a silent one: the reader pressed Try again and heard nothing.

    Why clear-and-refill rather than an attempt marker (a counter or a key
    that forces the same sentence back in): re-inserting identical text in
    ONE commit is the very create-and-fill-together shape that screen readers
    handle inconsistently, and a visible counter ("attempt 3") is noise for
    everyone else. The empty frame is also the honest one — while we are
    trying again, "we could not load" is not yet known to be true.
  */
  let failure: ReactNode = null;
  if (!placeholder && !loading && error !== null) {
    failure =
      events.length === 0 ? (
        /*
          Only when there is nothing to show. A failed "Load more" leaves
          page 1 in `events`, and a pagination failure is no reason to
          un-render rows that loaded fine — blanking them reads as "your
          agent did nothing", the exact misreading this surface keeps being
          rewritten to avoid (TASK-501).
        */
        <div className="px-1 py-6">
          <Alert variant="destructive" role="none">
            <AlertDescription>
              We could not load the record. It is usually a blip — nothing your
              agents did was lost, we just could not read it back right now.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <div className="pt-6">
          <Alert variant="destructive" role="none">
            <AlertDescription>
              We could not load the older entries. It is usually a blip —
              everything above is still right, and nothing your agents did was
              lost.
            </AlertDescription>
          </Alert>
        </div>
      );
  }

  let body: ReactNode = null;
  if (placeholder) {
    body = <FeedPlaceholder />;
  } else if (events.length === 0) {
    /*
      Empty is a real state, not just "no rows fetched yet": the collection
      exists and is genuinely empty. Two lines, because "Nothing recorded
      yet." on its own reads as "your agents did nothing", and the truth is
      narrower — the record just has nothing in it so far. Not when the read
      FAILED, though: that is `failure` above, and "we could not read it" is
      not "there is nothing".
    */
    if (error === null) {
      // Scoped to the agent when the tab is. Under one agent's "What it did",
      // "what agents do" is the wrong subject — the reader is asking about
      // this one, and the global phrasing reads like a different screen's
      // answer.
      const scopedName = agentId === undefined ? null : name(agentId);
      body = (
        <div className="flex flex-col gap-1.5 px-5 py-10 text-center">
          <p className="text-[13.5px] text-muted-foreground">
            Nothing recorded yet.
          </p>
          <p className="mx-auto max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
            {scopedName === null
              ? 'The record is empty so far. When your agents do something, every run and every decision shows up here.'
              : `The record of what ${scopedName} does is empty so far. When it does something, every run and every decision shows up here.`}
          </p>
        </div>
      );
    }
  } else {
    body = (
      <div className="flex flex-col gap-6">
        {bucket(events).map(({ key, label, rows }) => (
          <div key={key}>
            <div className="mb-2.5 flex items-center gap-2">
              <span className="text-[12.5px] font-medium">{label}</span>
              <span className="text-[11.5px] text-muted-foreground">
                {rows.length}
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              {rows.map((e) => {
                const k = KIND[e.kind];
                const time = localTime(e.at);
                return (
                  <div
                    key={e.id}
                    className="flex items-center gap-3 border-b border-rule-soft px-5 py-3 last:border-b-0"
                  >
                    <k.Icon size={13} className={cn('shrink-0', k.tone)} />
                    {!agentId && (
                      <button
                        type="button"
                        onClick={() => onOpenAgent?.(e.agentId)}
                        className="shrink-0 text-[13px] font-medium hover:text-primary hover:underline hover:underline-offset-2"
                      >
                        {name(e.agentId)}
                      </button>
                    )}
                    <span className="min-w-0 flex-1">
                      {/* `title` so the clamp hides nothing unrecoverably (TASK-436). */}
                      <span
                        className="block truncate text-[13.5px] text-muted-foreground"
                        title={e.text}
                      >
                        {e.text}
                      </span>
                      {/* The real error on a stopped row. Untrusted text — a string, never markup. */}
                      {e.detail !== null && (
                        <span
                          className="block truncate text-[12px] text-destructive"
                          title={e.detail}
                        >
                          {e.detail}
                        </span>
                      )}
                    </span>
                    {e.tag && (
                      <Badge variant="secondary" className="shrink-0 text-[11px]">
                        {e.tag}
                      </Badge>
                    )}
                    {time !== null && (
                      <span className="shrink-0 text-[12.5px] tabular-nums text-muted-foreground">
                        {time}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {body}

      {/*
        ONE live region for every failure this feed can report, at a fixed
        position that every state above shares — placeholder, empty, rows —
        so it is mounted, EMPTY, before any failure reaches it. A live region
        created and filled in one commit is announced inconsistently
        (VoiceOver often skips it), and both failures have to be heard: the
        reader who pressed Load more has no other sign it failed (focus is on
        the button, the rows did not change), and a first page that fails
        after the placeholder has only ever said "reading" (TASK-501,
        TASK-541). The `Alert`s inside drop their own `role="alert"` so each
        message is announced once, by this region, rather than twice.

        Its spacing lives on the message, not here, so an empty region takes
        no room.

        A feed MOUNTED already failed is covered too: on its first commit
        the failure sits just outside the region, and moves in once the
        region has existed empty (see `armed`, TASK-545).
      */}
      {!armed && failure}
      <div data-activity-announcer aria-live="polite">
        {armed && failure}
      </div>

      {!placeholder && events.length > 0 && hasMore && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => onLoadMore?.()}
            className="h-7 gap-1.5 text-[12px] text-primary"
          >
            {error !== null ? 'Try again' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
