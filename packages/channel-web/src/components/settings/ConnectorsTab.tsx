/**
 * ConnectorsTab — the Settings "Connectors" surface: the connector
 * DEFINITIONS (what a service is and how we reach it), one list.
 *
 * Signing in and adding keys are NOT here. A person connects a service where
 * they use it — an agent's Connectors tab in the side rail (Sign in / Add
 * key) — so there is no Connect / Update key here, and no Ready / Needs a key
 * status that would only be true for whoever happens to be looking. A shared
 * (workspace) key is part of the definition and is set in its editor. Nor is
 * there a Test button: the rail checks a connector's health where it's used.
 *
 * Each row is the service's name, what it needs (a personal or a shared key)
 * and, for someone who may change it, Edit and Delete — nothing else.
 *
 * AUTHORING: users and admins configure integrations here. New definitions
 * are shared. Authors may edit/delete their personal definitions; definitions
 * owned by someone else are read-only. The actor’s role selects
 * `/settings/connectors` or `/admin/connectors` for writes.
 *
 * Untrusted text (connector name / description) renders through React text
 * nodes (auto-escaped) — never raw HTML. shadcn primitives + semantic tokens
 * only (invariant #6).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listConnectors,
  deleteConnector,
  listAuthoredPending,
  rejectAuthoredConnector,
  type ConnectorSummary,
  type ConnectorRouteBase,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { ProposedConnectorApproveDialog } from './ProposedConnectorApproveDialog';
import { ConnectorEditDialog } from './ConnectorEditDialog';
import { connectorSource } from '@/components/SourceBadge';
import { RoleCard } from '@/components/admin/RoleCard';
import { StatusDot } from '@/components/admin/StatusDot';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AllowedSitesPanel } from './AllowedSitesPanel';
import { RememberedSitesPanel } from './RememberedSitesPanel';

/** Mechanism-free "what it needs" caption — keyMode only, no transport vocab. */
function needsCaption(c: ConnectorSummary): string {
  return c.keyMode === 'workspace' ? 'Needs a shared key' : 'Needs a personal key';
}

export function ConnectorsTab({ isAdmin }: { isAdmin: boolean }) {
  // The route bundle every CRUD call targets (TASK-129): admins curate via
  // `/admin/connectors`; non-admin authors read/write their OWN PRIVATE
  // connectors via the locked-down `/settings/connectors` (owner forced,
  // visibility forced private, admin-only fields rejected, catalog/shared
  // read-only — server-side). Both bundles are owner-scoped, so the list/get a
  // user sees is identical; only the write policy differs.
  const base: ConnectorRouteBase = isAdmin
    ? '/admin/connectors'
    : '/settings/connectors';
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Authoring: the connector being created/edited (null = closed). Admins curate
  // any connector; non-admins author only their own PRIVATE ones.
  const [editing, setEditing] = useState<ConnectorSummary | 'new' | null>(null);
  // Authoring: the connector awaiting delete confirmation (null = none).
  const [pendingDelete, setPendingDelete] = useState<ConnectorSummary | null>(
    null,
  );

  // "Proposed by your assistant" fallback: pending authored drafts the assistant
  // proposed mid-turn (the approval-card twin for a missed/dismissed card). The
  // draft currently being approved (null = dialog closed).
  const [proposed, setProposed] = useState<PendingAuthoredConnector[]>([]);
  const [approving, setApproving] = useState<PendingAuthoredConnector | null>(null);
  // The proposed draft awaiting dismiss confirmation (null = dialog closed).
  const [dismissing, setDismissing] = useState<PendingAuthoredConnector | null>(
    null,
  );

  /** Reload the pending authored drafts ("Proposed by your assistant"). Always
   *  the owner-scoped `/settings/connectors/authored` surface; best-effort — a
   *  failure just leaves the shelf empty rather than blocking the tab. */
  const refreshProposed = useCallback(() => {
    return listAuthoredPending()
      .then((drafts) => setProposed(drafts))
      .catch(() => setProposed([]));
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
  }, [base]);

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
    listAuthoredPending()
      .then((drafts) => {
        if (!cancelled) setProposed(drafts);
      })
      .catch(() => {
        // Best-effort: a preset without the connectors plugin (or a transient
        // failure) just hides the Proposed shelf.
        if (!cancelled) setProposed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  // --- admin curation actions ----------------------------------------------

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteConnector(pendingDelete.id, base);
      setPendingDelete(null);
      await refreshConnectors();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingDelete(null);
    }
  };

  const confirmDismiss = async () => {
    if (!dismissing) return;
    try {
      await rejectAuthoredConnector(dismissing.connectorId, {
        agentId: dismissing.agentId,
      });
      setDismissing(null);
      refreshProposed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setDismissing(null);
    }
  };

  const list = connectors ?? [];

  /** One connector row: name, what it needs, and Edit / Delete when allowed. */
  const renderTile = (c: ConnectorSummary) => {
    const source = connectorSource(c);
    // Availability and edit permission are separate: shared definitions stay
    // editable by their author and read-only for everyone else.
    const canEdit = (c.canEdit ?? (isAdmin || source === 'private')) &&
      (isAdmin || !(c.visibility === 'shared' && c.keyMode === 'workspace'));
    return (
      <div key={c.id} data-testid={`connector-tile-${c.id}`}>
        <RoleCard pill="service" title={c.name} caption={needsCaption(c)}>
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
          {/* `h2` under the pane title's `h1` (TASK-446) — this and the two
              site panels at the bottom of the tab are the tab's three top-level
              sections; the shelves inside each one are `h3`. */}
          <h2 className="text-sm font-medium text-foreground">Connectors</h2>
          <p className="text-xs text-muted-foreground">
            Services your assistant can reach. Each one bundles what it needs —
            a key, the data it talks to — behind a single name. People sign in
            from each agent’s Connectors tab.
          </p>
        </div>
        {/* New definitions are shared; credential and edit permissions remain
            scoped to the user. The role determines which route bundle saves. */}
        <Button size="sm" onClick={() => setEditing('new')}>
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
          No connectors yet.{' '}
          {isAdmin
            ? 'Add one to make it available to the workspace.'
            : 'Add one with “New connector,” or your assistant will offer to connect a service when it needs one.'}
        </p>
      )}

      {/* Proposed by your assistant — pending authored drafts the assistant
          proposed mid-turn. The approval-card twin: if the in-chat card was
          missed/dismissed, approve the connector here. Rendered only when there
          is at least one pending draft. */}
      {proposed.length > 0 && (
        <section className="flex flex-col gap-3.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Proposed by your assistant ({proposed.length})
          </h3>
          {proposed.map((d) => (
            <div key={d.connectorId} data-testid={`proposed-connector-${d.connectorId}`}>
              <RoleCard
                pill="service"
                title={d.name}
                caption={
                  d.keyMode === 'workspace' ? 'Needs a shared key' : 'Needs a personal key'
                }
              >
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground mr-auto">
                    <StatusDot variant="pending" />
                    Awaiting your approval
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDismissing(d)}
                  >
                    Dismiss
                  </Button>
                  <Button size="sm" onClick={() => setApproving(d)}>
                    Approve
                  </Button>
                </div>
              </RoleCard>
            </div>
          ))}
        </section>
      )}

      {connectors !== null && list.length > 0 && (
        <section className="flex flex-col gap-3.5">
          {list.map((c) => renderTile(c))}
        </section>
      )}

      {/* Approve a proposed (pending authored) connector — the Settings twin of
          the in-chat approval card. On approval the draft is promoted into the
          registry; we refresh both shelves so it leaves "Proposed" and appears as
          a real connector. */}
      {approving && (
        <ProposedConnectorApproveDialog
          draft={approving}
          open
          onOpenChange={(o) => {
            if (!o) setApproving(null);
          }}
          onApproved={() => {
            setApproving(null);
            void refreshProposed();
            void refreshConnectors();
          }}
        />
      )}

      {/* Admin curation: create / edit the connector definition. */}
      {editing !== null && (
        <ConnectorEditDialog
          target={editing}
          open
          isAdmin={isAdmin}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void refreshConnectors();
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

      {/* Dismiss a proposed (pending authored) draft — reject it outright, no
          approve and no key entry. Low-stakes + reversible (the assistant can
          propose it again), so the copy is light and blameless. */}
      {dismissing !== null && (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setDismissing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Dismiss this suggestion?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              We'll remove{' '}
              <span className="font-medium text-foreground">
                {dismissing.name}
              </span>{' '}
              from your proposals. No key needed — and your assistant can always
              suggest it again later.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDismissing(null)}>
                Keep
              </Button>
              <Button variant="destructive" onClick={() => void confirmDismiss()}>
                Dismiss
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Allowed sites — its OWN section (set off by a top border from the
          connector shelves above). NOT connectors: individual egress hosts the
          user's agents may reach. One list across all agents, each host showing
          which agents it applies to (see AllowedSitesPanel). */}
      <AllowedSitesPanel />

      {/* Sites we read without asking — a DIFFERENT store from Allowed sites
          above, deliberately kept separate: Allowed sites is which hosts an
          agent's SANDBOX may open raw network connections to (per agent);
          this is which hosts `web_extract` may fetch a page from without
          stopping to ask (per person). Folding them together would mean
          approving one page read also opened raw sockets to that host. */}
      <RememberedSitesPanel />
    </div>
  );
}
