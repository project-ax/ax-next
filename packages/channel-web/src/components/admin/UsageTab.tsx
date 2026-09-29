/**
 * UsageTab — admin-only "Usage and limits" (TASK-692).
 *
 * Launch runs on model keys the operator pays for, so this is where an admin
 * sees who used what over the last 24 hours, changes the two limits everyone is
 * held to, and pauses (or resumes) one person's agents. Reads and writes go
 * through `lib/usage-admin.ts`; every sentence comes from `lib/usage-copy.ts`.
 *
 * The screen never guesses about money it cannot see. If the numbers do not
 * load, there is one error with a Try again button and NOTHING else: no
 * editable limits, no Pause buttons on a table we cannot read.
 *
 * Layout mirrors the other admin tabs: an `h1` from the pane header, then the
 * cards. Card titles carry `role="heading"` (level 2) so the outline stays
 * h1 → h2 without the `h5` that `AlertTitle` would add (see TASK-446).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toastActions } from '@/lib/toast-store';
import {
  fetchUsage,
  resumeUser,
  suspendUser,
  type UsageLimits,
  type UsageReport,
  type UsageStatus,
  type UsageUser,
} from '@/lib/usage-admin';
import {
  failureMessage,
  formatCount,
  formatUsd,
  personLabel,
  personSubline,
  shareOfLimit,
  statusLabel,
  summaryLine,
} from '@/lib/usage-copy';
import { PauseAgentsDialog } from './PauseAgentsDialog';
import { UsageLimitsCard } from './UsageLimitsCard';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; report: UsageReport };

/** Words carry the status; the variant only backs them up. */
const STATUS_VARIANT: ReadonlyMap<UsageStatus, BadgeProps['variant']> = new Map([
  ['ok', 'outline'],
  ['near-limit', 'secondary'],
  ['at-limit', 'destructive'],
  ['suspended', 'default'],
]);

/**
 * Where someone stands once un-paused, from the numbers on screen. The server
 * has the last word (it also knows "close to"): `UsageTab` re-reads right
 * after, and this only keeps the row from lying for that moment.
 */
function statusWithoutPause(u: UsageUser, limits: UsageLimits): UsageStatus {
  return u.spendUsd >= limits.dailySpendUsd || u.turnsLastHour >= limits.turnsPerHour
    ? 'at-limit'
    : 'ok';
}

interface PauseTarget {
  userId: string;
  label: string;
}

export function UsageTab() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  // A problem with a re-read (as opposed to the first read): the numbers on
  // screen are still there, but they may be out of date, and we say so.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [pauseTarget, setPauseTarget] = useState<PauseTarget | null>(null);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  /*
    Only the newest read may write to the screen. `readSeq` is bumped by every
    new read AND by every change we make to a row ourselves (`supersedeReads`),
    so a slow read that started before a Pause cannot land afterwards and put
    the person back to "OK".
  */
  const readSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSeq.current += 1;
    };
  }, []);

  const supersedeReads = useCallback(() => {
    readSeq.current += 1;
    setRefreshing(false);
  }, []);

  const load = useCallback(async (mode: 'first' | 'again') => {
    const mine = ++readSeq.current;
    if (mode === 'first') setState({ kind: 'loading' });
    else setRefreshing(true);
    setRefreshError(null);
    try {
      const report = await fetchUsage();
      if (mine !== readSeq.current) return;
      setState({ kind: 'ready', report });
    } catch (err) {
      if (mine !== readSeq.current) return;
      if (mode === 'first') {
        setState({
          kind: 'error',
          // The "Try again" button is right there, so the sentence does not
          // repeat it.
          message: failureMessage("We couldn't load usage just now.", err, {
            retry: null,
          }),
        });
      } else {
        setRefreshError(
          failureMessage("We couldn't refresh the numbers.", err, {
            settled: 'What you see may be out of date.',
            retry: 'Press Refresh to try again.',
          }),
        );
      }
    } finally {
      if (mine === readSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load('first');
  }, [load]);

  const changeReport = (update: (r: UsageReport) => UsageReport) =>
    setState((prev) => (prev.kind === 'ready' ? { kind: 'ready', report: update(prev.report) } : prev));

  const changeUser = (userId: string, update: (u: UsageUser, limits: UsageLimits) => UsageUser) =>
    changeReport((r) => ({
      ...r,
      users: r.users.map((u) => (u.userId === userId ? update(u, r.limits) : u)),
    }));

  const openPause = (u: UsageUser) => {
    setActionError(null);
    setPauseError(null);
    setPauseTarget({ userId: u.userId, label: personLabel(u) });
    setPauseOpen(true);
  };

  const confirmPause = async (note: string) => {
    if (pauseTarget === null) return;
    setPauseBusy(true);
    setPauseError(null);
    try {
      const { suspended, interrupted } = await suspendUser(pauseTarget.userId, note);
      supersedeReads();
      changeUser(pauseTarget.userId, (u) => ({ ...u, status: 'suspended', suspended }));
      setPauseOpen(false);
      toastActions.show({
        title:
          interrupted === 0
            ? 'Paused. Nothing was running.'
            : `Paused. Stopped ${interrupted} running ${interrupted === 1 ? 'task' : 'tasks'}.`,
        kind: 'info',
      });
    } catch (err) {
      setPauseError(
        failureMessage(`We couldn't pause ${pauseTarget.label}'s agents.`, err, {
          settled: 'Nothing was changed.',
        }),
      );
    } finally {
      if (mounted.current) setPauseBusy(false);
    }
  };

  const resume = async (u: UsageUser) => {
    const label = personLabel(u);
    setActionError(null);
    setBusyUserId(u.userId);
    try {
      await resumeUser(u.userId);
      supersedeReads();
      changeUser(u.userId, (row, limits) => ({
        ...row,
        status: statusWithoutPause(row, limits),
        suspended: null,
      }));
      toastActions.show({ title: `Resumed agents for ${label}.`, kind: 'info' });
      // Whether they are also close to a limit is the server's call.
      void load('again');
    } catch (err) {
      setActionError(
        failureMessage(`We couldn't resume ${label}'s agents.`, err, {
          settled: 'They are still paused.',
        }),
      );
    } finally {
      if (mounted.current) setBusyUserId(null);
    }
  };

  if (state.kind === 'error') {
    return (
      <div className="max-w-[960px] mx-auto font-sans">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{state.message}</p>
            <Button variant="outline" size="sm" onClick={() => void load('first')}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const report = state.kind === 'ready' ? state.report : null;

  return (
    <div className="max-w-[960px] mx-auto flex flex-col gap-6 font-sans">
      <UsageLimitsCard
        limits={report?.limits ?? null}
        onSaved={(limits) => changeReport((r) => ({ ...r, limits }))}
      />

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="flex flex-col gap-1.5">
            <CardTitle role="heading" aria-level={2} className="text-lg">
              Last 24 hours
            </CardTitle>
            {report !== null && report.users.length > 0 && (
              <CardDescription>{summaryLine(report.totals)}</CardDescription>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={report === null || refreshing}
            onClick={() => {
              setActionError(null);
              void load('again');
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {refreshError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{refreshError}</AlertDescription>
            </Alert>
          )}
          {actionError !== null && (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}
          {report === null ? (
            <div role="status" className="flex flex-col gap-3">
              <span className="sr-only">Loading usage…</span>
              <Skeleton className="h-10 w-full" aria-hidden="true" />
              <Skeleton className="h-10 w-full" aria-hidden="true" />
              <Skeleton className="h-10 w-full" aria-hidden="true" />
            </div>
          ) : report.users.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No usage in the last 24 hours</EmptyTitle>
                <EmptyDescription>
                  When people start chatting, they'll show up here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <Table>
                <TableCaption className="sr-only">
                  Estimated usage per person, last 24 hours
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Messages</TableHead>
                    <TableHead>Estimated spend</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
                      <span className="sr-only">Action</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.users.map((u) => (
                    <UsageRow
                      key={u.userId}
                      user={u}
                      limits={report.limits}
                      busy={busyUserId === u.userId}
                      onPause={() => openPause(u)}
                      onResume={() => void resume(u)}
                    />
                  ))}
                </TableBody>
              </Table>
              {report.truncated && (
                <p className="text-sm text-muted-foreground">
                  Showing the 200 biggest users.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <PauseAgentsDialog
        open={pauseOpen}
        personLabel={pauseTarget?.label ?? ''}
        busy={pauseBusy}
        error={pauseError}
        onConfirm={(note) => void confirmPause(note)}
        onCancel={() => setPauseOpen(false)}
      />
    </div>
  );
}

interface UsageRowProps {
  user: UsageUser;
  limits: UsageLimits;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
}

function UsageRow({ user, limits, busy, onPause, onResume }: UsageRowProps) {
  const label = personLabel(user);
  const subline = personSubline(user);
  const share = shareOfLimit(user.spendUsd, limits.dailySpendUsd);
  const paused = user.status === 'suspended';
  const note = user.suspended?.note ?? null;

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium break-words">{label}</div>
        {subline !== null && (
          <div className="text-xs text-muted-foreground break-words">{subline}</div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div>{formatCount(user.turnsLast24h)}</div>
        <div className="text-xs text-muted-foreground">
          {`${formatCount(user.turnsLastHour)} in the last hour`}
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div>{formatUsd(user.spendUsd)}</div>
        {share !== null && <div className="text-xs text-muted-foreground">{share}</div>}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex flex-col items-start gap-1">
          <Badge variant={STATUS_VARIANT.get(user.status) ?? 'outline'} className="whitespace-nowrap">
            {statusLabel(user.status)}
          </Badge>
          {paused && note !== null && note.length > 0 && (
            <div className="max-w-[16rem] text-xs text-muted-foreground break-words">
              {note}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="align-top text-right">
        {paused ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`Resume agents for ${label}`}
            onClick={onResume}
          >
            {busy ? 'Resuming…' : 'Resume'}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Pause agents for ${label}`}
            onClick={onPause}
          >
            Pause agents
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
