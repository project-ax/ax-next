/**
 * ConnectorConnectDialog — the user-facing connector CONNECT handshake
 * (connectors-first-class design, Phase 3). Driven by the connector's
 * `keyMode`:
 *
 *   - `personal` → prompt THIS user for their OWN key (per-user JIT,
 *     credential scope 'user'). Everyone acts as themselves.
 *   - `workspace` → an ADMIN stores ONE shared company key (scope 'global'),
 *     gated behind the explicit shared-key CONSENT moment.
 *
 * The credential plan + consent gate are derived CLIENT-SIDE from the full
 * connector (`getConnector` carries `capabilities`) via the local re-declaration
 * of TASK-96's derivation in `lib/connectors.ts` — there is no
 * `connectors:resolve` HTTP route, and a runtime cross-plugin import of
 * `@ax/connectors` is forbidden (invariant #2). Each slot's key is written to
 * the SAME `account:<service>` vault row the host resolver reads
 * (`account:<slot.account ?? connectorId>`), reusing the existing
 * `setDestinationCredential` write (no new wire surface).
 *
 * SECURITY (invariant #5): the shared-key consent gate is BLOCKING — the
 * key-entry form is not rendered until the user accepts. The workspace write
 * targets `scope:'global'`, which the server admin-gates (`requireAdmin` on
 * `/admin/destinations`); a non-admin can't store the company key and is told an
 * admin must. No secret value is ever rendered or logged — entry is a password
 * field, written base64 (CredentialSlotForm).
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CredentialSlotForm } from '@/components/credentials/CredentialSlotForm';
import {
  getConnector,
  deriveCredentialPlan,
  requiresSharedKeyConsent,
  sharedKeyConsentMessage,
  type Connector,
  type ConnectorCredentialPlanEntry,
} from '@/lib/connectors';

export interface ConnectorConnectDialogProps {
  connectorId: string;
  /** The display name (already in hand from the list — shown while loading). */
  connectorName: string;
  /** Whether the current user is an admin (gates the workspace shared-key write). */
  isAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a slot's key is stored, so the caller can re-check presence. */
  onConnected: () => void;
}

export function ConnectorConnectDialog({
  connectorId,
  connectorName,
  isAdmin,
  open,
  onOpenChange,
  onConnected,
}: ConnectorConnectDialogProps) {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The shared-key consent moment must be accepted BEFORE the key form renders.
  const [consented, setConsented] = useState(false);

  // (Re)load the full connector each time the dialog opens, and reset the
  // per-open consent so it can never be carried over from a prior session.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnector(null);
    setError(null);
    setConsented(false);
    getConnector(connectorId)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectorId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {connectorName}</DialogTitle>
          <DialogDescription>
            {connector?.description || 'Give your assistant access to this service.'}
          </DialogDescription>
        </DialogHeader>
        <ConnectBody
          connector={connector}
          error={error}
          isAdmin={isAdmin}
          consented={consented}
          onConsent={() => setConsented(true)}
          onConnected={onConnected}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectBody({
  connector,
  error,
  isAdmin,
  consented,
  onConsent,
  onConnected,
}: {
  connector: Connector | null;
  error: string | null;
  isAdmin: boolean;
  consented: boolean;
  onConsent: () => void;
  onConnected: () => void;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (connector === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const plan = deriveCredentialPlan(connector);

  // No credential slots → nothing to prompt (e.g. an MCP server that needs no
  // key). The service is reachable as soon as it's in the library.
  if (plan.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This service needs no key — your assistant can already reach it.
      </p>
    );
  }

  const needsConsent = requiresSharedKeyConsent(connector);
  const isWorkspace = connector.keyMode === 'workspace';

  // Workspace key is a single GLOBAL company key — only an admin can store it.
  // (The server admin-gates the write regardless; this is the friendly heads-up
  // so a non-admin isn't handed a raw 403.)
  if (isWorkspace && !isAdmin) {
    return (
      <p className="text-sm text-muted-foreground">
        This is a shared service — an admin provides the company key for{' '}
        {connector.name}. Once they do, your assistant can use it.
      </p>
    );
  }

  // The shared-key consent moment (design "Consent caveat"). BLOCKING: the key
  // form is not reachable until the user accepts. Surfaced for a workspace key
  // OR a key bound to a shared/team agent.
  if (needsConsent && !consented) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <AlertDescription>{sharedKeyConsentMessage(connector.name)}</AlertDescription>
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onConsent}>I understand</Button>
        </div>
      </div>
    );
  }

  return (
    <ConnectKeyForms connector={connector} plan={plan} onConnected={onConnected} />
  );
}

/**
 * One key-entry form per credential slot. Reuses the existing CredentialSlotForm
 * (password field + base64 write). The destination is the service-keyed
 * `account:<service>` vault row; the scope comes from the derived plan
 * ('user' for personal, 'global' for workspace). ownerId is null — the server
 * forces it from the session (user route) / is admin-supplied as the company key
 * (global route).
 */
function ConnectKeyForms({
  connector,
  plan,
  onConnected,
}: {
  connector: Connector;
  plan: ConnectorCredentialPlanEntry[];
  onConnected: () => void;
}) {
  const slotByName = useCallback(
    (slotName: string) =>
      connector.capabilities.credentials.find((s) => s.slot === slotName),
    [connector],
  );

  return (
    <div className="flex flex-col gap-5">
      {plan.map((entry) => {
        // ref is `account:<service>`; strip the prefix back to the service tag.
        const service = entry.ref.slice('account:'.length);
        const slotMeta = slotByName(entry.slot);
        return (
          <div key={entry.slot} className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground">{entry.slot}</p>
            <CredentialSlotForm
              destination={{ kind: 'account', service }}
              slot={{
                label: entry.slot,
                kind: 'api-key',
                // exactOptionalPropertyTypes: only include `description` when set.
                ...(slotMeta?.description !== undefined
                  ? { description: slotMeta.description }
                  : {}),
              }}
              scope={{ scope: entry.scope, ownerId: null }}
              current={{ set: false }}
              onSaved={onConnected}
              onCleared={onConnected}
            />
          </div>
        );
      })}
    </div>
  );
}
