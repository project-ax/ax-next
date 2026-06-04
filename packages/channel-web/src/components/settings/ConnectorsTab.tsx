/**
 * ConnectorsTab — the Settings "Connectors" surface, an app-store split
 * (TASK-127, settings-unified epic). The user's connector library presented as
 * two shelves, mirroring the Skills tab's Installed / Not-installed:
 *
 *   - **Connected** — services every credential slot has a stored key for; the
 *     assistant can reach them now. Per-row Manage (status / replace / remove keys).
 *   - **Available** — services in your library still missing a key. Per-row
 *     **Connect** opens the capability-consent handshake (ConnectorConnectDialog)
 *     before the user-scoped key write completes — the self-connect path.
 *
 * A connector is the first-class ACCESS object; whether it's backed by MCP, a
 * CLI, or a direct API is a MECHANISM that NEVER shows on the default shelf —
 * each row names only the service, what it needs (a key), and its status in the
 * plain-language, mechanism-agnostic vocabulary (TASK-130): Ready / Needs a key
 * / Can't reach it / Checking… (see STATUS_COPY).
 *
 * AUTHORING: the standalone admin Connector Registry is gone (TASK-125). Both
 * users and admins author connectors INLINE here via the shared connector form
 * (ConnectorEditDialog, reusing `lib/connector-form`, the one source of truth,
 * invariant #4):
 *   - Every user (TASK-129) gets "New connector" + per-row Edit / Delete on the
 *     connectors they OWN AND that are PRIVATE. Their writes go to the
 *     locked-down `/settings/connectors` routes (owner forced, visibility forced
 *     private, admin-only fields rejected server-side).
 *   - Admins additionally get per-row set-default / Test (workspace curation) and
 *     may edit ANY connector, writing to `/admin/connectors` (where they may set
 *     visibility:shared + default-on).
 * Catalog/shared connectors are READ-ONLY for non-admins: they see the source
 * badge + Connect/Manage only, never edit/delete — mirrored by the user
 * route's server-side 403.
 *
 * SCOPE NOTE: the connector store is owner-scoped at every layer — `listConnectors`
 * returns only the caller's own connectors (the admin and user route bundles are
 * both owner-scoped). There is no cross-owner workspace-catalog read (deferred
 * per the design's Out-of-scope §); so the Available shelf is
 * "owned-but-not-yet-connected", and authoring edits the caller's own rows.
 * Connected/Available derive from REAL credential presence, not a separate
 * attach state.
 *
 * Untrusted text (connector name / description) renders through React text
 * nodes (auto-escaped) — never raw HTML. shadcn primitives + semantic tokens
 * only (invariant #6).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listConnectors,
  getConnector,
  deleteConnector,
  patchConnector,
  testConnector,
  deriveCredentialPlan,
  listAuthoredPending,
  rejectAuthoredConnector,
  type ConnectorSummary,
  type ConnectorTestStatus,
  type ConnectorRouteBase,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { ProposedConnectorApproveDialog } from './ProposedConnectorApproveDialog';
import {
  myCredentials,
  adminCredentials,
  type CredentialMeta,
} from '@/lib/credentials';
import { ConnectorConnectDialog } from './ConnectorConnectDialog';
import { ConnectorEditDialog } from './ConnectorEditDialog';
import { SourceBadge, connectorSource } from '@/components/SourceBadge';
import { RoleCard } from '@/components/admin/RoleCard';
import { StatusDot, type StatusDotVariant } from '@/components/admin/StatusDot';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AllowedSitesPanel } from './AllowedSitesPanel';

/** Mechanism-free "what it needs" caption — keyMode only, no transport vocab. */
function needsCaption(c: ConnectorSummary): string {
  return c.keyMode === 'workspace' ? 'Needs a shared key' : 'Needs a personal key';
}

/**
 * Per-connector connected state, derived from REAL credential presence.
 * `undefined` while the connector's plan is still loading.
 *   - `'connected'` — every credential slot in the connector's plan has a stored
 *     key at its derived scope/ref (an empty plan ⇒ needs no key ⇒ connected).
 *   - `'disconnected'` — at least one plan slot has no stored key.
 *   - `'unknown'` — the connector's full record failed to load (presence
 *     undeterminable; the connector still appears on the Available shelf).
 */
type ConnectedState = 'connected' | 'disconnected' | 'unknown';

/** Per-row Test probe state (admin Test action). */
type TestState = 'idle' | 'testing' | ConnectorTestStatus;

/**
 * Plain-language, mechanism-agnostic connector status vocabulary (TASK-130).
 * Reads the same whether the connector is backed by MCP, a Direct API, or a
 * Command-line tool — the underlying probe/presence signal NEVER shows through.
 *
 *   - **Ready** — reachable / every credential slot has a stored key.
 *   - **Needs a key** — a credential slot is still missing its key.
 *   - **Can't reach it** — the service answered, but we couldn't reach it (only
 *     the live Test probe can tell this apart from "needs a key").
 *   - **Checking…** — the presence read / probe is still in flight.
 */
const STATUS_COPY = {
  ready: 'Ready',
  'needs-key': 'Needs a key',
  unreachable: "Can't reach it",
  checking: 'Checking…',
} as const;
type StatusKey = keyof typeof STATUS_COPY;

/** The credential-presence status all users see, mapped to the friendly copy.
 *  `undefined` (still loading) reads as "Checking…". */
function presenceStatusKey(state: ConnectedState | undefined): StatusKey {
  if (state === undefined) return 'checking';
  return state === 'connected' ? 'ready' : 'needs-key';
}

function presenceDotVariant(state: ConnectedState | undefined): StatusDotVariant {
  if (state === undefined) return 'pending';
  return state === 'connected' ? 'ok' : 'empty';
}

/** The admin Test-probe verdict, mapped to the same friendly copy. `unreachable`
 *  is the one outcome only the live probe can distinguish from "needs a key". */
function testStatusKey(state: TestState | undefined): StatusKey | null {
  switch (state) {
    case 'reachable':
      return 'ready';
    case 'unreachable':
      return 'unreachable';
    case 'needs-key':
      return 'needs-key';
    case 'testing':
      return 'checking';
    default:
      return null; // idle / not yet probed → no verdict shown
  }
}

function testDotVariant(state: TestState | undefined): StatusDotVariant {
  switch (state) {
    case 'reachable':
      return 'ok';
    case 'unreachable':
    case 'needs-key':
      return 'bad';
    case 'testing':
      return 'pending';
    default:
      return 'empty';
  }
}

/** Friendly label for the admin Test-probe verdict; 'not tested' when idle. */
function testLabel(state: TestState | undefined): string {
  const key = testStatusKey(state);
  return key ? STATUS_COPY[key] : 'not tested';
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
  // Derived connected-state per connector id (REAL credential presence).
  const [connected, setConnected] = useState<Record<string, ConnectedState>>({});
  // The connector whose connect dialog is open (null = closed).
  const [connecting, setConnecting] = useState<ConnectorSummary | null>(null);
  // Authoring: the connector being created/edited (null = closed). Admins curate
  // any connector; non-admins author only their own PRIVATE ones.
  const [editing, setEditing] = useState<ConnectorSummary | 'new' | null>(null);
  // Authoring: the connector awaiting delete confirmation (null = none).
  const [pendingDelete, setPendingDelete] = useState<ConnectorSummary | null>(
    null,
  );
  // Per-row Test probe state, keyed by connector id (admin Test action).
  const [testState, setTestState] = useState<Record<string, TestState>>({});

  // "Proposed by your assistant" fallback: pending authored drafts the assistant
  // proposed mid-turn (the approval-card twin for a missed/dismissed card). The
  // draft currently being approved (null = dialog closed).
  const [proposed, setProposed] = useState<PendingAuthoredConnector[]>([]);
  const [approving, setApproving] = useState<PendingAuthoredConnector | null>(null);
  // The proposed draft awaiting dismiss confirmation (null = dialog closed).
  const [dismissing, setDismissing] = useState<PendingAuthoredConnector | null>(
    null,
  );

  /**
   * Derive connected-state for a set of connectors from REAL credential presence.
   * Reads the user / global credential lists ONCE (presence is metadata, never a
   * secret value), then for each connector loads its full record to derive its
   * credential plan and check every plan slot has a stored key at its derived
   * scope+ref. A connector whose full record fails to load reads `'unknown'`.
   */
  const refreshConnectedState = useCallback(
    async (list: ConnectorSummary[]) => {
      let userCreds: CredentialMeta[] = [];
      let globalCreds: CredentialMeta[] = [];
      try {
        userCreds = await myCredentials.list();
      } catch {
        // Treat as no creds → disconnected; never block the tab.
      }
      if (isAdmin) {
        try {
          globalCreds = await adminCredentials.list();
        } catch {
          // Non-fatal — global presence just reads as absent.
        }
      }
      const hasCred = (scope: 'user' | 'global', ref: string): boolean => {
        const pool = scope === 'user' ? userCreds : globalCreds;
        return pool.some((c) => c.ref === ref && c.scope === scope);
      };
      const results = await Promise.all(
        list.map(async (summary): Promise<[string, ConnectedState]> => {
          try {
            const full = await getConnector(summary.id, base);
            const plan = deriveCredentialPlan(full);
            const ok = plan.every((entry) => hasCred(entry.scope, entry.ref));
            return [summary.id, ok ? 'connected' : 'disconnected'];
          } catch {
            return [summary.id, 'unknown'];
          }
        }),
      );
      setConnected((prev) => {
        const next = { ...prev };
        for (const [id, state] of results) next[id] = state;
        return next;
      });
    },
    [isAdmin, base],
  );

  /** Reload the pending authored drafts ("Proposed by your assistant"). Always
   *  the owner-scoped `/settings/connectors/authored` surface; best-effort — a
   *  failure just leaves the shelf empty rather than blocking the tab. */
  const refreshProposed = useCallback(() => {
    return listAuthoredPending()
      .then((drafts) => setProposed(drafts))
      .catch(() => setProposed([]));
  }, []);

  /** Reload the connector list + re-derive connected-state (after a curation
   *  write or a successful connect). */
  const refreshConnectors = useCallback(() => {
    setError(null);
    return listConnectors(base)
      .then((list) => {
        setConnectors(list);
        void refreshConnectedState(list);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setConnectors([]);
      });
  }, [refreshConnectedState, base]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listConnectors(base)
      .then((list) => {
        if (cancelled) return;
        setConnectors(list);
        void refreshConnectedState(list);
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
  }, [refreshConnectedState, base]);

  // --- admin curation actions ----------------------------------------------

  const onTest = async (id: string) => {
    setTestState((prev) => ({ ...prev, [id]: 'testing' }));
    // testConnector folds HTTP/network errors into { status: 'unreachable' },
    // so this never throws and the badge can't get stuck on "testing…".
    const result = await testConnector(id);
    setTestState((prev) => ({ ...prev, [id]: result.status }));
  };

  const onToggleDefault = async (c: ConnectorSummary) => {
    try {
      // Set-default is admin-only (it shapes the shared catalog) → the admin
      // route base. `base` is already '/admin/connectors' for an admin caller.
      await patchConnector(c.id, { defaultAttached: !c.defaultAttached }, base);
      await refreshConnectors();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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

  // --- sectioning -----------------------------------------------------------
  // A connector is "Connected" only once its presence is confirmed; everything
  // else (disconnected / unknown / still-loading) lands on the Available shelf,
  // because until proven otherwise it has no usable key to spend.
  const list = connectors ?? [];
  const isConnected = (c: ConnectorSummary) => connected[c.id] === 'connected';
  const connectedList = list.filter(isConnected);
  const availableList = list.filter((c) => !isConnected(c));

  /** One connector row. `section` tweaks the primary action label. */
  const renderTile = (c: ConnectorSummary, section: 'connected' | 'available') => {
    const state = connected[c.id];
    const source = connectorSource(c);
    // Workspace curation (Test / Set-default) is admin-only — it shapes the
    // shared catalog, which a non-admin never controls.
    const canManageWorkspace = isAdmin;
    // Edit / Delete: admins may curate any connector; a non-admin author may
    // edit/delete only the connectors they OWN AND that are private. A
    // catalog/shared connector (`source === 'catalog'`) is read-only for a
    // non-admin (mirrors the server-side 403 on the user route).
    const canEdit = isAdmin || source === 'private';
    return (
      <div key={c.id} data-testid={`connector-tile-${c.id}`}>
        <RoleCard pill="service" title={c.name} caption={needsCaption(c)}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground mr-auto">
              <StatusDot variant={presenceDotVariant(state)} />
              {STATUS_COPY[presenceStatusKey(state)]}
            </span>
            {canManageWorkspace && testState[c.id] !== undefined && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <StatusDot variant={testDotVariant(testState[c.id])} />
                {testLabel(testState[c.id])}
              </span>
            )}
            <SourceBadge source={source} />
            {canManageWorkspace && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onTest(c.id)}
                  disabled={testState[c.id] === 'testing'}
                >
                  Test
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onToggleDefault(c)}
                >
                  {c.defaultAttached ? 'Unset default' : 'Set default'}
                </Button>
              </>
            )}
            {canEdit && (
              <>
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
              </>
            )}
            <Button
              size="sm"
              variant={section === 'connected' ? 'outline' : 'default'}
              onClick={() => setConnecting(c)}
            >
              {/* Connected → the keys are already set, so this opens the
                  enter/replace-key dialog: name it for what it does ("Update
                  credentials"), not the vague "Manage" that collided with Edit. */}
              {section === 'connected' ? 'Update credentials' : 'Connect'}
            </Button>
          </div>
        </RoleCard>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Connectors</h3>
          <p className="text-xs text-muted-foreground">
            Services your assistant can reach. Each one bundles what it needs —
            a key, the data it talks to — behind a single name.
          </p>
        </div>
        {/* Every user may author their OWN private connectors (TASK-129); the
            New connector form opens the user variant for a non-admin (forces
            visibility private) and the admin variant for an admin. */}
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
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Proposed by your assistant ({proposed.length})
          </h4>
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

      {/* Connected shelf */}
      {connectors !== null && list.length > 0 && (
        <section className="flex flex-col gap-3.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Connected ({connectedList.length})
          </h4>
          {connectedList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing connected yet — connect a service from Available below.
            </p>
          ) : (
            connectedList.map((c) => renderTile(c, 'connected'))
          )}
        </section>
      )}

      {/* Available shelf */}
      {connectors !== null && list.length > 0 && (
        <section className="flex flex-col gap-3.5 pt-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Available ({availableList.length})
          </h4>
          {availableList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing left to connect.
            </p>
          ) : (
            availableList.map((c) => renderTile(c, 'available'))
          )}
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

      {/* The keyMode-aware connect handshake (personal JIT vs workspace shared
          key + consent gate). Re-derives connected-state on a successful store
          so the tile moves to the Connected shelf. */}
      {connecting && (
        <ConnectorConnectDialog
          connectorId={connecting.id}
          connectorName={connecting.name}
          // From the Connected shelf the key is already set → "manage" (the
          // title reads "Update credentials"); from Available it's a first-time
          // "connect". Derived from the same presence map the shelves split on.
          mode={isConnected(connecting) ? 'manage' : 'connect'}
          isAdmin={isAdmin}
          open
          onOpenChange={(o) => {
            if (!o) setConnecting(null);
          }}
          onConnected={() => {
            if (connectors) void refreshConnectedState(connectors);
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
    </div>
  );
}
