/**
 * ConnectorsTab — the Admin › Connectors surface: the connector
 * DEFINITIONS (what a service is and how we reach it), one list.
 *
 * Signing in and adding keys are NOT here. A person connects a service where
 * they use it — an agent's Connectors tab in the side rail (Sign in / Add
 * key) — so there is no Connect / Update key here, and no Ready / Needs a key
 * status that would only be true for whoever happens to be looking. A shared
 * (workspace) key is part of the definition and is set in its editor. Nor is
 * there a Test button: the rail checks a connector's health where it's used.
 *
 * Each row is the service's name, what it needs (a key each agent adds, or
 * one shared key) and, when the server allows it, Edit and Delete — nothing
 * else.
 *
 * AUTHORING (slice 2a): only admins define connectors, so this tab is mounted
 * only for an admin (AdminShell gates it; the server gates every write), and
 * every read and write goes through `/admin/connectors`. Any admin may edit or
 * delete a shared connector; the server says so per row (`canEdit`). The site
 * lists that used to sit at the bottom moved to Settings › Sites.
 *
 * AWAITING APPROVAL (slice 2c): an agent that needs a connector nobody has
 * defined files a request, and every admin sees every person's requests here.
 * Approval is creation — "Set it up" opens the normal create editor prefilled
 * from the request, and the server clears the request when the shared
 * connector is created. "Dismiss" clears it without creating anything.
 *
 * Untrusted text (connector name / description, and everything in a request,
 * which an agent wrote) renders through React text nodes (auto-escaped) —
 * never raw HTML. shadcn primitives + semantic tokens
 * only (invariant #6).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listConnectors,
  deleteConnector,
  isConnectorGone,
  CONNECTOR_GONE_MESSAGE,
  listAuthoredProposals,
  dismissAuthoredProposal,
  prefillFromProposal,
  proposalReach,
  type AuthoredProposal,
  type ConnectorPrefill,
  type ConnectorSummary,
  type ConnectorWriteBase,
} from '@/lib/connectors';
import { relativeDay } from '@/lib/workspace-time';
import { ConnectorEditDialog } from './ConnectorEditDialog';
import { RoleCard } from '@/components/admin/RoleCard';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Mechanism-free "what it needs" caption — keyMode only, no transport vocab.
 * The stored value is still `'personal'` (not renamed, slice 2a ruling); a
 * per-person key is added per agent, so that is what the words say. The shared
 * wording matches the editor's own choice ("One shared key for everyone").
 */
function needsCaption(keyMode: ConnectorSummary['keyMode']): string {
  return keyMode === 'workspace'
    ? 'One shared key for everyone'
    : 'Each agent adds its own key';
}

/**
 * One shelf row per requested connector id. Several people may ask for the
 * same one; the row shows (and "Set it up" starts from) the newest request,
 * and its caption says whose that is. Dismiss clears them all (the server
 * clears every request with that id).
 */
interface RequestGroup {
  connectorId: string;
  newest: AuthoredProposal;
  /** Who asked, de-duplicated, in list order. */
  people: string[];
}

function groupRequests(requests: readonly AuthoredProposal[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const r of requests) {
    const g = groups.get(r.connectorId);
    if (!g) {
      groups.set(r.connectorId, {
        connectorId: r.connectorId,
        newest: r,
        people: [r.proposedBy.label],
      });
      continue;
    }
    if (r.updatedAt > g.newest.updatedAt) g.newest = r;
    if (!g.people.includes(r.proposedBy.label)) g.people.push(r.proposedBy.label);
  }
  return [...groups.values()];
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol". */
function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Who asked. With one person, plainly that. With several, the row shows the
 * NEWEST request (its name, reach and prefill), so the caption says whose
 * request that is and that the others asked too, rather than crediting one
 * person's wording to everyone.
 */
function askedByCaption(g: RequestGroup): string {
  const shown = g.newest.proposedBy.label;
  const others = g.people.filter((p) => p !== shown);
  if (others.length === 0) return `Asked for by ${shown} for one of their agents`;
  return `Showing ${shown}’s request. ${namesList(others)} also asked for this.`;
}

/** Every read and write here is the admin bundle (slice 2a). */
const base: ConnectorWriteBase = '/admin/connectors';

export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Authoring: the connector being created/edited (null = closed).
  const [editing, setEditing] = useState<ConnectorSummary | 'new' | null>(null);
  // "Set it up": the request the create editor starts from (null = blank).
  const [prefill, setPrefill] = useState<ConnectorPrefill | null>(null);
  // Authoring: the connector awaiting delete confirmation (null = none).
  const [pendingDelete, setPendingDelete] = useState<ConnectorSummary | null>(
    null,
  );

  // Awaiting approval: every person's open connector requests, and the one
  // awaiting dismiss confirmation (null = dialog closed).
  const [requests, setRequests] = useState<AuthoredProposal[]>([]);
  const [dismissing, setDismissing] = useState<RequestGroup | null>(null);
  // The requests didn't load. A preset without the connectors plugin is not a
  // failure (the lib answers an empty list for its 404); anything else is, and
  // saying so beats an empty shelf that looks like "nobody asked".
  const [requestsFailed, setRequestsFailed] = useState(false);

  /** Reload the requests. A failure never blocks the tab: it shows an Alert
   *  with Retry where the shelf would be. */
  const refreshRequests = useCallback(() => {
    return listAuthoredProposals()
      .then((drafts) => {
        setRequests(drafts);
        setRequestsFailed(false);
      })
      .catch(() => {
        setRequests([]);
        setRequestsFailed(true);
      });
  }, []);

  /** Reload the connector list (after a curation write). */
  const refreshConnectors = useCallback(() => {
    setError(null);
    return listConnectors(base)
      .then((list) => setConnectors(list))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setConnectors([]);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listConnectors(base)
      .then((list) => {
        if (!cancelled) setConnectors(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setConnectors([]);
        }
      });
    listAuthoredProposals()
      .then((drafts) => {
        if (!cancelled) setRequests(drafts);
      })
      .catch(() => {
        if (!cancelled) setRequestsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- admin curation actions ----------------------------------------------

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteConnector(pendingDelete.id, base);
      setPendingDelete(null);
      await refreshConnectors();
    } catch (e: unknown) {
      setPendingDelete(null);
      if (isConnectorGone(e)) {
        // Another admin got there first: drop it from the list, then say so
        // (the reload clears any earlier error, so it goes first).
        await refreshConnectors();
        setError(CONNECTOR_GONE_MESSAGE);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmDismiss = async () => {
    if (!dismissing) return;
    try {
      await dismissAuthoredProposal(dismissing.connectorId);
      setDismissing(null);
      void refreshRequests();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setDismissing(null);
    }
  };

  const list = connectors ?? [];
  const groups = groupRequests(requests);

  /** One connector row: name, what it needs, and Edit / Delete when allowed. */
  const renderTile = (c: ConnectorSummary) => {
    // The server decides per row (any admin may edit a shared connector). A
    // row without the flag is the admin's to edit, as it always was here.
    const canEdit = c.canEdit ?? true;
    return (
      <div key={c.id} data-testid={`connector-tile-${c.id}`}>
        <RoleCard pill="service" title={c.name} caption={needsCaption(c.keyMode)}>
          {canEdit && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPendingDelete(c)}
              >
                Delete
              </Button>
            </div>
          )}
        </RoleCard>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          {/* `h2` under the pane title's `h1` (TASK-446) — the tab's one
              top-level section; the Awaiting approval shelf inside it is `h3`. */}
          <h2 className="text-sm font-medium text-foreground">Connectors</h2>
          <p className="text-xs text-muted-foreground">
            Services your assistant can reach. Each one bundles what it needs —
            a key, the data it talks to — behind a single name. People sign in
            from each agent’s Connectors tab.
          </p>
        </div>
        {/* New definitions are shared with the workspace. */}
        <Button
          size="sm"
          onClick={() => {
            setPrefill(null);
            setEditing('new');
          }}
        >
          New connector
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {connectors === null && !error && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}

      {connectors !== null && list.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No connectors yet. Add one to make it available to the workspace.
        </p>
      )}

      {requestsFailed && (
        <Alert data-testid="connector-requests-failed">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>Couldn’t load requests waiting for approval.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refreshRequests()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Awaiting approval — every person's connector requests. Rendered only
          when there is at least one. */}
      {groups.length > 0 && (
        <section className="flex flex-col gap-3.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Awaiting approval ({groups.length})
          </h3>
          {groups.map((g) => {
            const r = g.newest;
            const reach = proposalReach(r.proposal);
            return (
              <div
                key={g.connectorId}
                data-testid={`connector-request-${g.connectorId}`}
              >
                <RoleCard
                  pill="request"
                  title={r.name}
                  caption={askedByCaption(g)}
                >
                  <div className="flex flex-col gap-3">
                    {/* Requests from before an upgrade surface too, so the
                        age helps an admin spot (and Dismiss) a stale one. */}
                    <p className="text-xs text-muted-foreground">
                      {`Requested ${relativeDay(r.updatedAt)}`}
                    </p>
                    {reach.length > 0 && (
                      <p className="break-words text-sm text-muted-foreground">
                        {`Would reach ${reach.join(', ')}`}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDismissing(g)}
                      >
                        Dismiss
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setPrefill(prefillFromProposal(r));
                          setEditing('new');
                        }}
                      >
                        Set it up
                      </Button>
                    </div>
                  </div>
                </RoleCard>
              </div>
            );
          })}
        </section>
      )}

      {connectors !== null && list.length > 0 && (
        <section className="flex flex-col gap-3.5">
          {list.map((c) => renderTile(c))}
        </section>
      )}

      {/* Admin curation: create / edit the connector definition. "Set it up"
          is the same create, started from a request; the server clears the
          request when it's created, so both lists refresh. */}
      {editing !== null && (
        <ConnectorEditDialog
          target={editing}
          {...(editing === 'new' && prefill ? { prefill } : {})}
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void refreshConnectors();
            void refreshRequests();
          }}
        />
      )}

      {/* Admin curation: styled delete confirmation (no OS confirm). */}
      {pendingDelete !== null && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setPendingDelete(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete connector?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Delete{' '}
              <span className="font-medium text-foreground">
                {pendingDelete.name}
              </span>
              ? This cannot be undone. Agents that rely on it will lose access.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Dismiss a request: nothing is created, and the person isn't told.
          Their agent can ask again if it still needs it. */}
      {dismissing !== null && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setDismissing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dismiss this request?</DialogTitle>
              <DialogDescription>
                {dismissing.people.length === 1
                  ? 'The person who asked won’t be notified.'
                  : 'The people who asked won’t be notified.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDismissing(null)}>
                Keep
              </Button>
              <Button variant="destructive" onClick={() => void confirmDismiss()}>
                Dismiss
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
