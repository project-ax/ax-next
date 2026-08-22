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
  X,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ActivityEvent, WorkspaceAgent } from '@/lib/workspace-api';

const KIND: Record<ActivityEvent['kind'], { Icon: LucideIcon; tone: string }> = {
  done: { Icon: Check, tone: 'text-primary' },
  held: { Icon: Hand, tone: 'text-warning' },
  approved: { Icon: CheckCheck, tone: 'text-primary' },
  dismissed: { Icon: X, tone: 'text-muted-foreground' },
  working: { Icon: CircleDashed, tone: 'text-primary' },
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
}

/** Local Y-M-D. Two ISO instants on the same calendar day here share a bucket. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** `Today`, `Yesterday`, or a plain local date — never anything the server said. */
function dayLabel(d: Date, now: Date): string {
  if (localDayKey(d) === localDayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDayKey(d) === localDayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** `null` on an unparseable `at` — the row renders without a clock, not "Invalid Date". */
function localTime(at: string): string | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
      labelFor.set(key, Number.isNaN(d.getTime()) ? 'Unknown date' : dayLabel(d, now));
    }
    byKey.get(key)!.push(e);
  }

  return order.map((key) => ({
    key,
    label: labelFor.get(key)!,
    rows: byKey.get(key)!,
  }));
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
}: Props) {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  if (error !== null) {
    return (
      <div className="px-1 py-6">
        <Alert variant="destructive">
          <AlertDescription>
            We could not load the record. It is usually a blip — nothing your
            agents did was lost, we just could not read it back right now.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  /*
    Empty is a real state, not just "no rows fetched yet": the collection
    exists and is genuinely empty. Two lines, because "Nothing recorded yet."
    on its own reads as "your agents did nothing", and the truth is narrower —
    the record just has nothing in it so far.
  */
  if (events.length === 0) {
    // Scoped to the agent when the tab is. Under one agent's "What it did",
    // "what agents do" is the wrong subject — the reader is asking about this
    // one, and the global phrasing reads like a different screen's answer.
    const scopedName = agentId === undefined ? null : name(agentId);
    return (
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

  const days = bucket(events);

  return (
    <div className="flex flex-col gap-6">
      {days.map(({ key, label, rows }) => (
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
                    <span className="block truncate text-[13.5px] text-muted-foreground">
                      {e.text}
                    </span>
                    {/* The real error on a stopped row. Untrusted text — a string, never markup. */}
                    {e.detail !== null && (
                      <span className="block truncate text-[12px] text-destructive">
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

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => onLoadMore?.()}
            className="h-7 gap-1.5 text-[12px] text-primary"
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
