/**
 * TASK-1101 — Admin › Connectors › Find in directory: search the host's
 * mirror of the public MCP server directory, check a listing, and start the
 * create editor from it ("Set it up"). Nothing is saved here. The editor's
 * Add connector, which the parent owns, is the only write.
 *
 * WHAT IT SHOWS. On open, one empty-query read for the directory's state:
 * turned off, never synced, or a list and how fresh it is. Then the search
 * box, and no list until the admin types.
 *
 * ORDER OF ANSWERS. Typing waits `SEARCH_DEBOUNCE_MS` for a pause. Each
 * request aborts the one before it and takes the next number from `latest`,
 * and an answer is applied only while its number is still the newest.
 * Aborting alone isn't enough, because a request can finish before its abort
 * lands. The number is what stops a slow answer for "no" from replacing the
 * answer for "notion". Show more draws from the same counter. Clearing the
 * box and leaving the view both move it on, so nothing still in flight lands
 * after either.
 *
 * ALREADY ADDED. Connector summaries carry no addresses, so while this view
 * is mounted and the directory is searchable it reads each connector's full
 * record (as the agent rail's Add view does) and marks a listing whose server
 * address one of them already uses (`serverAddressKey`: the same host and
 * path, however it's written). A record that won't load is skipped. The worst
 * case is an unmarked listing, and a duplicate connector is harmless. The
 * list view itself still reads no full records.
 *
 * UNTRUSTED. Every listing field is third-party registry text, and it renders
 * only through `DirectoryListingRow`: text nodes, the address as its host,
 * never a link. The query is the admin's own text, rendered as text too.
 *
 * shadcn primitives and semantic tokens only (invariant 6).
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  DIRECTORY_QUERY_MAX,
  connectorServerAddresses,
  searchDirectory,
  serverAddressKey,
  type DirectoryEntry,
  type DirectoryPage,
} from '@/lib/connector-directory';
import { getConnector, type Connector, type ConnectorSummary } from '@/lib/connectors';
import { logRequestFailure } from '@/lib/http';
import { timeAgo } from '@/lib/workspace-time';
import { DirectoryListingRow } from './DirectoryListingRow';

/** How long the box waits for typing to pause before it searches. */
export const SEARCH_DEBOUNCE_MS = 300;

const LOG_CONTEXT = 'connector-directory';

const INTRO =
  'Search a public directory of services that work with agents. Anyone can publish to it, so each result shows who published it.';
const VERIFIED_ONLY = 'Only listings from verified publishers are shown in this workspace.';
const LOCAL_ONLY =
  'Only servers on the web are listed. Ones that run on someone’s own computer can’t be reached by agents, so we leave them out.';

/** The directory's state: still loading, couldn't load, or the newest page's. */
type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; page: DirectoryPage };

/** The rows found for one query, in the order they came, with no id twice. */
interface Results {
  query: string;
  entries: DirectoryEntry[];
  /** Where the next page starts. Absent on the last page. */
  nextCursor?: string;
}

/** `entries`, then each of `incoming` whose id isn't listed yet. */
function appendNew(entries: readonly DirectoryEntry[], incoming: readonly DirectoryEntry[]): DirectoryEntry[] {
  const ids = new Set(entries.map((e) => e.id));
  const out = [...entries];
  for (const entry of incoming) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    out.push(entry);
  }
  return out;
}

function toResults(query: string, entries: DirectoryEntry[], page: DirectoryPage): Results {
  return { query, entries, ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }) };
}

/** The route sends a page and no total, so while more pages remain the count is a floor. */
function countLine({ entries, nextCursor }: Results): string {
  if (nextCursor !== undefined) return `More than ${entries.length} servers match`;
  return entries.length === 1 ? '1 server matches' : `${entries.length} servers match`;
}

/** How old the list is: a muted line, or a note when the last refresh failed. */
function Freshness({ page }: { page: DirectoryPage }) {
  const ago = page.syncedAt === null ? null : timeAgo(page.syncedAt);
  if (page.stale) {
    return (
      <Alert role="note" data-testid="directory-stale">
        <AlertDescription>
          {ago === null
            ? 'We couldn’t refresh the directory, so this list may be out of date. New servers may be missing. We’ll keep trying.'
            : `We couldn’t refresh the directory, so this is the list from ${ago}. New servers may be missing. We’ll keep trying.`}
        </AlertDescription>
      </Alert>
    );
  }
  if (ago === null) return null;
  return <p className="text-xs text-muted-foreground">{`List updated ${ago}`}</p>;
}

export function ConnectorDirectory({
  connectors,
  onBack,
  onSetUp,
  onNewConnector,
}: {
  /** The workspace's connectors, to mark listings that are already added. */
  connectors: readonly ConnectorSummary[];
  onBack: () => void;
  /** "Set it up" on a listing: open the create editor filled in from it. */
  onSetUp: (entry: DirectoryEntry) => void;
  /** Set up a connector by hand instead. */
  onNewConnector: () => void;
}) {
  const inputId = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  /** The query whose search failed. The failure shows only while that query is in the box. */
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  /** The `serverAddressKey` of every server the workspace's connectors use. */
  const [addresses, setAddresses] = useState<ReadonlySet<string>>(() => new Set());

  /** The newest request's number. An answer is applied only while it still matches. */
  const latest = useRef(0);
  /** The newest request's controller, aborted when another replaces it. */
  const inFlight = useRef<AbortController | null>(null);

  const q = query.trim();

  // The directory's state, on open and on Try again.
  useEffect(() => {
    const controller = new AbortController();
    void searchDirectory('', { signal: controller.signal }).then(
      (page) => {
        if (!controller.signal.aborted) setLoad({ kind: 'ready', page });
      },
      (e: unknown) => {
        if (controller.signal.aborted) return;
        logRequestFailure(e, LOG_CONTEXT);
        setLoad({ kind: 'failed' });
      },
    );
    return () => controller.abort();
  }, [loadAttempt]);

  const retryLoad = () => {
    setLoad({ kind: 'loading' });
    setLoadAttempt((n) => n + 1);
  };

  /** Abort the request in flight, then take the next number and a fresh controller. */
  const begin = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    latest.current += 1;
    return { seq: latest.current, signal: controller.signal };
  }, []);

  /** Abort the request in flight and move the number on, so its answer never lands. */
  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    latest.current += 1;
  }, []);

  const runSearch = useCallback(
    (text: string) => {
      const { seq, signal } = begin();
      setFailedQuery(null);
      setMore('idle');
      void searchDirectory(text, { signal }).then(
        (page) => {
          if (seq !== latest.current) return;
          setResults(toResults(text, appendNew([], page.entries), page));
          setLoad({ kind: 'ready', page });
        },
        (e: unknown) => {
          if (seq !== latest.current) return;
          logRequestFailure(e, LOG_CONTEXT);
          setFailedQuery(text);
        },
      );
    },
    [begin],
  );

  // Search once the typing pauses. An empty box is handled as it's typed.
  useEffect(() => {
    if (q === '') return;
    const timer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, runSearch]);

  // Leaving: nothing in flight lands. The effect above clears a waiting timer.
  useEffect(() => cancel, [cancel]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim() !== '') return;
    cancel();
    setResults(null);
    setFailedQuery(null);
    setMore('idle');
  };

  const showMore = () => {
    if (results?.nextCursor === undefined) return;
    const { query: shownQuery, nextCursor } = results;
    const { seq, signal } = begin();
    setMore('loading');
    void searchDirectory(shownQuery, { cursor: nextCursor, signal }).then(
      (page) => {
        if (seq !== latest.current) return;
        setResults((prev) =>
          prev === null || prev.query !== shownQuery
            ? prev
            : toResults(shownQuery, appendNew(prev.entries, page.entries), page),
        );
        setMore('idle');
      },
      (e: unknown) => {
        if (seq !== latest.current) return;
        logRequestFailure(e, LOG_CONTEXT);
        setMore('failed');
      },
    );
  };

  // Keyed on each connector's id and last edit rather than on the array, so a
  // parent that passes an equal new list doesn't re-read every record. Only
  // while there's a list to mark: turned off, never synced, or not loaded
  // reads nothing.
  const searchable = load.kind === 'ready' && load.page.enabled && load.page.syncedAt !== null;
  const connectorsKey = connectors.map((c) => `${c.id}@${c.updatedAt}`).join('|');
  useEffect(() => {
    if (!searchable) return;
    let cancelled = false;
    void Promise.allSettled(connectors.map((c) => getConnector(c.id, '/admin/connectors'))).then((settled) => {
      if (cancelled) return;
      const loaded: Connector[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') loaded.push(result.value);
        else logRequestFailure(result.reason, LOG_CONTEXT);
      }
      setAddresses(connectorServerAddresses(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [connectorsKey, searchable]);

  const isAdded = (entry: DirectoryEntry): boolean => {
    const key = serverAddressKey(entry.url);
    return key !== null && addresses.has(key);
  };

  let body: ReactNode;
  if (load.kind === 'loading') {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  } else if (load.kind === 'failed') {
    body = (
      <Alert>
        <AlertDescription className="flex flex-col items-start gap-3">
          <p>We couldn’t load the directory just now.</p>
          <Button type="button" variant="outline" size="sm" onClick={retryLoad}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!load.page.enabled) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The directory is turned off in this workspace</EmptyTitle>
          <EmptyDescription>You can still set up a connector by hand.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" onClick={onNewConnector}>
            New connector
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else if (load.page.syncedAt === null) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>The directory isn’t available yet</EmptyTitle>
          <EmptyDescription>
            We haven’t been able to load it since this workspace started, so there’s nothing to search yet. The
            first load takes a few minutes. If it never finishes, your network may be blocking outside sites. You
            can still set up a connector by hand.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" variant="outline" onClick={retryLoad}>
              Try again
            </Button>
            <Button type="button" onClick={onNewConnector}>
              New connector
            </Button>
          </div>
        </EmptyContent>
      </Empty>
    );
  } else {
    // What the results area shows for the text in the box, if anything.
    const failed = q !== '' && failedQuery === q;
    const shown = results !== null && results.query === q ? results : null;
    const searching = q !== '' && !failed && shown === null;

    let resultsArea: ReactNode = null;
    if (failed) {
      resultsArea = (
        <Alert>
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>We couldn’t search the directory just now.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => runSearch(q)}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      );
    } else if (searching || (shown !== null && shown.entries.length > 0)) {
      // One status line for "Searching…" and then the count, so a screen
      // reader hears the count arrive in the same live region.
      resultsArea = (
        <div className="flex flex-col gap-3">
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            {searching && <Spinner aria-hidden="true" />}
            {shown === null ? 'Searching…' : countLine(shown)}
          </p>
          {shown !== null && (
            <>
              <div className="flex flex-col">
                {shown.entries.map((entry) => (
                  <DirectoryListingRow key={entry.id} entry={entry} added={isAdded(entry)} onSetUp={onSetUp} />
                ))}
              </div>
              {shown.nextCursor !== undefined && (
                <div className="flex flex-col items-start gap-2">
                  {more === 'failed' && (
                    <p className="text-sm text-muted-foreground">We couldn’t load more just now.</p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={more === 'loading'}
                    onClick={showMore}
                  >
                    {more === 'loading' && <Spinner data-icon="inline-start" aria-hidden="true" />}
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      );
    } else if (shown !== null) {
      resultsArea = (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{`Nothing matches “${shown.query}”`}</EmptyTitle>
            <EmptyDescription>
              Try the service’s name rather than what it does. Not every service is listed yet. If you know its
              address, you can set it up by hand.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={onNewConnector}>
              New connector
            </Button>
          </EmptyContent>
        </Empty>
      );
    }

    body = (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={inputId}>Search the directory</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id={inputId}
                type="search"
                placeholder="Search by service, like Notion or Stripe"
                maxLength={DIRECTORY_QUERY_MAX}
                autoFocus
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
              />
            </InputGroup>
          </Field>
          <Freshness page={load.page} />
          {load.page.verifiedOnly && <p className="text-xs text-muted-foreground">{VERIFIED_ONLY}</p>}
        </div>
        {resultsArea}
        <p className="text-xs text-muted-foreground">{LOCAL_ONLY}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-3"
          aria-label="Back to connectors"
          onClick={onBack}
        >
          <ChevronLeft data-icon="inline-start" aria-hidden="true" />
          Connectors
        </Button>
        <h2 className="text-base font-medium">Find a connector</h2>
        <p className="text-sm text-muted-foreground">{INTRO}</p>
      </div>
      {body}
    </div>
  );
}
