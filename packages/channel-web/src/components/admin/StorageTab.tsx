/**
 * StorageTab — "Storage" under Settings (TASK-690).
 *
 * Each person has a limit on how much their agents' files and their uploads
 * can add up to. This is where anyone sees their own bar and, when they are
 * running out, what that means and who can help. Admins also see, in the same
 * tab so the nav does not grow, the two limits everyone is held to and who is
 * using the most.
 *
 * Reads and writes go through `lib/storage-api.ts`; every sentence comes from
 * `lib/storage-copy.ts`. The admin half is a separate component that only
 * exists for an admin, so a non-admin's browser never asks /admin/storage (or
 * /admin/storage/cleanup) for anything (the server would say no; not asking is
 * politer, and cheaper).
 *
 * The foot of "Everyone's storage" carries one more line for admins (TASK-777):
 * how many files nobody uses any more and how much room they take, ending in
 * "Not removed yet." It is REPORT-ONLY: nothing is removed and there is no
 * button for it. It is read on its own, so if that read fails the rest of the
 * card is untouched and the line says so in one quiet sentence.
 *
 * Layout mirrors the Usage tab: an `h1` from the pane header, then the cards.
 * Card titles carry `role="heading"` (level 2) so the outline stays h1 -> h2
 * without the `h5` that `AlertTitle` would add (see TASK-446).
 *
 * NOTHING HERE TELLS A PERSON TO DELETE THINGS. Deleting a whole agent does give
 * its workspace back, but that throws the agent away, and attachments and
 * artifacts cannot be deleted, so "delete something" would be a false promise
 * for most people. The way out is an admin.
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
import { Progress } from '@/components/ui/progress';
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
import {
  BYTES_PER_MB,
  fetchAdminStorage,
  fetchMyStorage,
  fetchUnusedFiles,
  type AdminStorage,
  type MyStorage,
  type StorageLimits,
  type StorageOwner,
  type StorageStatus,
  type UnusedFiles,
} from '@/lib/storage-api';
import {
  FULL_BODY,
  FULL_TITLE,
  NEAR_LIMIT_BODY,
  NEAR_LIMIT_TITLE,
  UNUSED_FILES_FAILED,
  breakdownRows,
  failureMessage,
  formatBytes,
  ownerBreakdown,
  ownerLabel,
  ownerSubline,
  ownersSummary,
  shareOfLimit,
  statusLabel,
  unusedFilesLine,
  usageLine,
} from '@/lib/storage-copy';
import { StorageLimitsCard } from './StorageLimitsCard';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: T };

interface Read<T> {
  state: Load<T>;
  /** Read again. `first` shows the loading state; `again` keeps what is on screen. */
  load: (mode: 'first' | 'again') => Promise<void>;
  /** Change what is on screen without asking the server (a save just told us). */
  patch: (update: (data: T) => T) => void;
}

/**
 * One read, with the two guards every read here needs: a slow answer that
 * started before a newer one must not land on top of it, and nothing writes to
 * the screen after the tab has gone. `fetcher` and `what` must be stable.
 *
 * A re-read that fails keeps the numbers already on screen: they are a little
 * out of date, not wrong, and blanking a table over a hiccup helps nobody.
 */
function useRead<T>(fetcher: () => Promise<T>, what: string): Read<T> {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const seq = useRef(0);

  const load = useCallback(
    async (mode: 'first' | 'again') => {
      const mine = ++seq.current;
      if (mode === 'first') setState({ kind: 'loading' });
      try {
        const data = await fetcher();
        if (mine !== seq.current) return;
        setState({ kind: 'ready', data });
      } catch (err) {
        if (mine !== seq.current) return;
        if (mode === 'first') {
          setState({
            kind: 'error',
            // The "Try again" button is right there, so the sentence does not
            // repeat it.
            message: failureMessage(what, err, { retry: null }),
          });
        }
      }
    },
    [fetcher, what],
  );

  useEffect(() => {
    void load('first');
    return () => {
      // Whatever is still in flight belongs to a tab that is gone.
      seq.current += 1;
    };
  }, [load]);

  const patch = useCallback((update: (data: T) => T) => {
    // A save just told us the truth; a read that started before it must not
    // land afterwards and put the old numbers back.
    seq.current += 1;
    setState((prev) => (prev.kind === 'ready' ? { kind: 'ready', data: update(prev.data) } : prev));
  }, []);

  return { state, load, patch };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Words carry the status; the variant only backs them up. */
const STATUS_VARIANT: ReadonlyMap<StorageStatus, BadgeProps['variant']> = new Map([
  ['ok', 'outline'],
  ['near-limit', 'secondary'],
  ['full', 'destructive'],
]);

function ReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-col items-start gap-3">
        <p>{message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function LoadingRows({ label, rows }: { label: string; rows: number }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" aria-hidden="true" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your storage (everyone)
// ---------------------------------------------------------------------------

function MyStorageBody({ storage }: { storage: MyStorage }) {
  const line = usageLine(storage.usedBytes, storage.limitBytes);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-base font-medium">{line}</p>
        <Progress
          aria-label="Storage used"
          aria-valuetext={line}
          // With no limit to measure against there is nothing to fill.
          value={storage.limitBytes > 0 ? storage.usedBytes : 0}
          max={storage.limitBytes > 0 ? storage.limitBytes : 1}
        />
      </div>
      <dl className="flex flex-col gap-1.5 text-sm">
        {breakdownRows(storage).map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      {storage.status === 'near-limit' && (
        <Alert>
          <AlertDescription className="flex flex-col gap-1">
            <p className="font-medium">{NEAR_LIMIT_TITLE}</p>
            <p>{NEAR_LIMIT_BODY}</p>
          </AlertDescription>
        </Alert>
      )}
      {storage.status === 'full' && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-1">
            <p className="font-medium">{FULL_TITLE}</p>
            <p>{FULL_BODY}</p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function MyStorageCard({ read }: { read: Read<MyStorage> }) {
  const { state, load } = read;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-lg">
          Your storage
        </CardTitle>
        <CardDescription>
          Your agents' files and everything you upload share the same room.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' && (
          <LoadingRows label="Loading your storage…" rows={3} />
        )}
        {state.kind === 'error' && (
          <ReadError message={state.message} onRetry={() => void load('first')} />
        )}
        {state.kind === 'ready' && <MyStorageBody storage={state.data} />}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The admin half
// ---------------------------------------------------------------------------

function OwnerRow({ owner, limitBytes }: { owner: StorageOwner; limitBytes: number }) {
  const subline = ownerSubline(owner);
  const share = shareOfLimit(owner.usedBytes, limitBytes);
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words">{ownerLabel(owner)}</span>
          {owner.kind === 'team' && <Badge variant="secondary">Team</Badge>}
        </div>
        {subline !== null && (
          <div className="text-xs text-muted-foreground break-words">{subline}</div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div>{formatBytes(owner.usedBytes)}</div>
        {share !== null && <div className="text-xs text-muted-foreground">{share}</div>}
        <div className="text-xs text-muted-foreground">{ownerBreakdown(owner)}</div>
      </TableCell>
      <TableCell className="align-top">
        <Badge
          variant={STATUS_VARIANT.get(owner.status) ?? 'outline'}
          className="whitespace-nowrap"
        >
          {statusLabel(owner.status)}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

/**
 * "Files no longer used by anyone: 12 (120.6 KB). Not removed yet." (TASK-777).
 *
 * A side note at the foot of the card, read on its own so that a failure here
 * never touches the numbers above it: it asks for itself the moment the card
 * mounts (not after the owners list arrives), shows nothing while it waits, and
 * on a failure says one quiet sentence. No retry: the next visit asks again,
 * and the answer only changes hourly.
 *
 * REPORT-ONLY. It counts what a cleanup would take; nothing is taken yet, and
 * there is no button here that could start one.
 */
function UnusedFilesLine() {
  // The read builds a longer message (with the reason) for the cards that show
  // one; this line shows only the fixed sentence, so `what` is that sentence.
  const { state } = useRead<UnusedFiles>(fetchUnusedFiles, UNUSED_FILES_FAILED);
  if (state.kind === 'loading') return null;
  return (
    <p className="text-sm text-muted-foreground">
      {state.kind === 'error' ? UNUSED_FILES_FAILED : unusedFilesLine(state.data.report)}
    </p>
  );
}

function EveryoneCard({ admin }: { admin: AdminStorage | null }) {
  const limitBytes = admin === null ? 0 : admin.limits.limitMb * BYTES_PER_MB;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-lg">
          Everyone's storage
        </CardTitle>
        {admin !== null && admin.owners.length > 0 && (
          <CardDescription>{ownersSummary(admin)}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {admin === null ? (
          <LoadingRows label="Loading everyone's storage…" rows={3} />
        ) : admin.owners.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No storage used yet</EmptyTitle>
              <EmptyDescription>
                When people start saving files and uploads, they'll show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Table>
              <TableCaption className="sr-only">
                Storage used by each person or team, biggest first
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Person or team</TableHead>
                  <TableHead>Storage used</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admin.owners.map((o) => (
                  <OwnerRow key={o.ownerId} owner={o} limitBytes={limitBytes} />
                ))}
              </TableBody>
            </Table>
            {admin.ownerCount > admin.owners.length && (
              <p className="text-sm text-muted-foreground">
                {`Showing the ${admin.owners.length.toLocaleString('en-US')} biggest of ${admin.ownerCount.toLocaleString('en-US')}.`}
              </p>
            )}
          </>
        )}
        <UnusedFilesLine />
      </CardContent>
    </Card>
  );
}

function AdminStorageSection({ onLimitsSaved }: { onLimitsSaved: () => void }) {
  const { state, load, patch } = useRead(
    fetchAdminStorage,
    "We couldn't load the storage limits just now.",
  );

  if (state.kind === 'error') {
    // Nothing to edit or list when we cannot see the numbers. The card keeps
    // its title so the page outline does not change shape.
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="text-lg">
            Storage limits
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReadError message={state.message} onRetry={() => void load('first')} />
        </CardContent>
      </Card>
    );
  }

  const admin = state.kind === 'ready' ? state.data : null;

  const saved = (limits: StorageLimits) => {
    patch((a) => ({ ...a, limits }));
    // The new limit moves every status in the table, and the admin's own bar.
    void load('again');
    onLimitsSaved();
  };

  return (
    <>
      <StorageLimitsCard limits={admin?.limits ?? null} onSaved={saved} />
      <EveryoneCard admin={admin} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export interface StorageTabProps {
  /**
   * Admins get the limits and everyone's usage as well. Gated on the server
   * too (every /admin/* route checks the role); this only decides whether we
   * ask.
   */
  isAdmin: boolean;
}

export function StorageTab({ isAdmin }: StorageTabProps) {
  const mine = useRead(fetchMyStorage, "We couldn't load your storage just now.");
  const reloadMine = mine.load;

  return (
    <div className="max-w-[960px] mx-auto flex flex-col gap-6 font-sans">
      <MyStorageCard read={mine} />
      {isAdmin && <AdminStorageSection onLimitsSaved={() => void reloadMine('again')} />}
    </div>
  );
}
