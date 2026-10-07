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
  type ConnectorWriteBase,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { ProposedConnectorApproveDialog } from './ProposedConnectorApproveDialog';
import { ConnectorEditDialog } from './ConnectorEditDialog';
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

/** Every read and write here is the admin bundle (slice 2a). */
const base: ConnectorWriteBase = '/admin/connectors';

export function ConnectorsTab() {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Authoring: the connector being created/edited (null = closed).
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
  }, []);

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
              top-level section; the Proposed shelf inside it is `h3`. */}
          <h2 className="text-sm font-medium text-foreground">Connectors</h2>
          <p className="text-xs text-muted-foreground">
            Services your assistant can reach. Each one bundles what it needs —
            a key, the data it talks to — behind a single name. People sign in
            from each agent’s Connectors tab.
          </p>
        </div>
        {/* New definitions are shared with the workspace. */}
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
          No connectors yet. Add one to make it available to the workspace.
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
                caption={needsCaption(d.keyMode)}
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
    </div>
  );
}
