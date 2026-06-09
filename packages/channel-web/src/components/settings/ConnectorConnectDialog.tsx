/**
 * ConnectorConnectDialog — the user-facing connector MANAGE surface (grown from
 * a connect-only handshake). Driven by the connector's `keyMode`:
 *
 *   - `personal` → prompt THIS user for their OWN key (per-user JIT,
 *     credential scope 'user'). Everyone acts as themselves.
 *   - `workspace` → an ADMIN stores ONE shared company key (scope 'global'),
 *     gated behind the explicit shared-key CONSENT moment.
 *
 * Each slot reads its REAL presence on open (the user/global credential list vs
 * the slot's derived ref): a slot with a stored key shows a clear "key is saved"
 * cue + Replace, an empty one shows enter. The secret itself is never shown (it
 * never leaves the vault). Saving the LAST empty slot closes the dialog — an
 * unambiguous "it worked" — and the tile moves to the Connected shelf. There is
 * NO per-key Remove here: to drop a connector entirely the user Deletes it from
 * the Connectors tab (Delete is the single "uninstall" action).
 *
 * The credential plan + consent gate are derived CLIENT-SIDE from the full
 * connector (`getConnector` carries `capabilities`) via the local re-declaration
 * of the derivation in `lib/connectors.ts` — there is no `connectors:resolve`
 * HTTP route, and a runtime cross-plugin import of `@ax/connectors` is forbidden
 * (invariant #2). Each connector owns its own key: the slot's key is written to
 * the `account:<connectorId>` (single-slot) / `account:<connectorId>:<slot>`
 * (multi-slot) vault row the host resolver reads, reusing the existing
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
import {
  myCredentials,
  adminCredentials,
  type CredentialMeta,
} from '@/lib/credentials';

export interface ConnectorConnectDialogProps {
  connectorId: string;
  /** The display name (already in hand from the list — shown while loading). */
  connectorName: string;
  /**
   * Which shelf opened the dialog. `'connect'` (Available — no key yet) titles it
   * "Connect <name>"; `'manage'` (Connected — key already set, so this is the
   * enter/replace surface) titles it "Update credentials for <name>". The body is
   * identical either way (it always reflects per-slot presence). Defaults to
   * `'connect'` for back-compat with callers that predate the prop.
   */
  mode?: 'connect' | 'manage';
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
  mode = 'connect',
  isAdmin,
  open,
  onOpenChange,
  onConnected,
}: ConnectorConnectDialogProps) {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The shared-key consent moment must be accepted BEFORE the key form renders.
  const [consented, setConsented] = useState(false);
  // Real per-slot presence (metadata only — never a secret value): the user's
  // own vault + (for an admin) the global company vault. A slot whose derived
  // ref already has a stored key renders a "key is saved" cue + Replace instead
  // of enter.
  const [userCreds, setUserCreds] = useState<CredentialMeta[]>([]);
  const [globalCreds, setGlobalCreds] = useState<CredentialMeta[]>([]);

  // Load credential PRESENCE for this user (+ global if admin). Re-run after a
  // save so a slot flips to its saved state without reopening the dialog, and
  // RETURNED so a caller can decide synchronously whether every slot is now set.
  // A list failure reads as "absent" — it never blocks the connect flow.
  const loadCreds = useCallback(async (): Promise<{
    user: CredentialMeta[];
    global: CredentialMeta[];
  }> => {
    let user: CredentialMeta[] = [];
    let global: CredentialMeta[] = [];
    try {
      user = await myCredentials.list();
    } catch {
      user = [];
    }
    if (isAdmin) {
      try {
        global = await adminCredentials.list();
      } catch {
        global = [];
      }
    }
    setUserCreds(user);
    setGlobalCreds(global);
    return { user, global };
  }, [isAdmin]);

  // (Re)load the full connector + presence each time the dialog opens, and reset
  // the per-open consent so it can never be carried over from a prior session.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnector(null);
    setError(null);
    setConsented(false);
    setUserCreds([]);
    setGlobalCreds([]);
    getConnector(connectorId)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    void loadCreds();
    return () => {
      cancelled = true;
    };
  }, [open, connectorId, loadCreds]);

  // Whether a slot's derived (scope, ref) already has a stored key.
  const hasCred = useCallback(
    (scope: 'user' | 'global', ref: string): boolean =>
      (scope === 'user' ? userCreds : globalCreds).some(
        (c) => c.ref === ref && c.scope === scope,
      ),
    [userCreds, globalCreds],
  );

  // A slot's key was saved: refresh our own presence (so a just-saved slot flips
  // to its "saved" state in place) AND tell the parent so the connector tile
  // re-derives Connected/Available. Once EVERY slot in the plan has a stored key,
  // close the dialog — an unambiguous "it worked" (and the tile moves to the
  // Connected shelf). For a multi-key connector we only close once the LAST slot
  // is filled, so a partly-filled connector stays open to finish.
  const onSaved = useCallback(async () => {
    const fresh = await loadCreds();
    onConnected();
    if (connector === null) return;
    const allSet = deriveCredentialPlan(connector).every((entry) =>
      (entry.scope === 'user' ? fresh.user : fresh.global).some(
        (c) => c.ref === entry.ref && c.scope === entry.scope,
      ),
    );
    if (allSet) onOpenChange(false);
  }, [loadCreds, onConnected, connector, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'manage'
              ? `Update credentials for ${connectorName}`
              : `Connect ${connectorName}`}
          </DialogTitle>
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
          hasCred={hasCred}
          onSaved={onSaved}
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
  hasCred,
  onSaved,
}: {
  connector: Connector | null;
  error: string | null;
  isAdmin: boolean;
  consented: boolean;
  onConsent: () => void;
  hasCred: (scope: 'user' | 'global', ref: string) => boolean;
  onSaved: () => void;
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
    <ConnectKeyForms
      connector={connector}
      plan={plan}
      hasCred={hasCred}
      onSaved={onSaved}
    />
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
  hasCred,
  onSaved,
}: {
  connector: Connector;
  plan: ConnectorCredentialPlanEntry[];
  hasCred: (scope: 'user' | 'global', ref: string) => boolean;
  onSaved: () => void;
}) {
  const slotByName = useCallback(
    (slotName: string) =>
      connector.capabilities.credentials.find((s) => s.slot === slotName),
    [connector],
  );

  return (
    <div className="flex flex-col gap-5">
      {plan.map((entry) => {
        // TASK-124 — build the destination from the plan's STRUCTURED fields, not
        // by slicing the ref: a multi-slot connector's ref is
        // `account:<service>:<slot>`, which `.slice('account:')` would mangle into
        // an invalid `service`. `entry.service` is the bare tag; `entry.slotTag`
        // (present only for a multi-slot connector) becomes the optional `slot` so
        // the WRITE lands in the SAME row the host resolver READS.
        const slotMeta = slotByName(entry.slot);
        return (
          <div key={entry.slot} className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground">{entry.slot}</p>
            <CredentialSlotForm
              destination={{
                kind: 'account',
                service: entry.service,
                ...(entry.slotTag !== undefined ? { slot: entry.slotTag } : {}),
              }}
              slot={{
                label: entry.slot,
                kind: 'api-key',
                // exactOptionalPropertyTypes: only include `description` when set.
                // Narrow to api-key slots — oauth slots have no `description` field.
                ...(slotMeta?.kind === 'api-key' && slotMeta.description !== undefined
                  ? { description: slotMeta.description }
                  : {}),
              }}
              scope={{ scope: entry.scope, ownerId: null }}
              current={{ set: hasCred(entry.scope, entry.ref) }}
              onSaved={onSaved}
            />
          </div>
        );
      })}
    </div>
  );
}
