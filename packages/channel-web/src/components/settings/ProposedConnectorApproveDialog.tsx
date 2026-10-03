import { humanizeId, humanizeSlotLabel } from '@/lib/humanize';
import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { ConnectorKeyModeNotice } from '@/components/credentials/ConnectorKeyModeNotice';
import {
  approveAuthoredConnector,
  isToolPermissionsResetFailure,
  TOOL_PERMISSIONS_RESET_FAILED_APPROVE_MESSAGE,
  serviceTagForSlot,
  accountRef,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { myCredentials, setDestinationCredential } from '@/lib/credentials';
import type { Destination } from '@ax/credentials';

/**
 * The Settings-side twin of the workspace's connector grant row (`GrantRow`,
 * kind:'connector'). Surfaces a connector the assistant PROPOSED mid-turn (a
 * pending authored draft) so the user can approve it from Settings too — the
 * fallback for a missed/dismissed row.
 *
 * Same handshake as the row: collect a key per declared slot (a slot already in
 * the user's vault is offered as "use existing"), write each entered key STRAIGHT
 * to the host credential store under the connector's `account:<service>[:<slot>]`
 * row (never the model, never the approve POST — §10), then POST the approval
 * (domain ids + the `shown` TOCTOU guard only). On success the draft is promoted
 * into the registry and lands on the normal Connected/Available shelves.
 *
 * shadcn primitives + semantic tokens only (invariant #6).
 */
export function ProposedConnectorApproveDialog({
  draft,
  open,
  onOpenChange,
  onApproved,
}: {
  draft: PendingAuthoredConnector;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApproved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [haveExisting, setHaveExisting] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = draft.proposal.credentials;
  const isMulti = slots.filter(c => c.kind !== 'api-key' || !c.headerName).length >= 2;
  // The user's secret lands at user scope (mirrors the in-chat card, which always
  // writes scope:'user'); a connector owns its key keyed by its id.
  const refFor = (slotName: string): string =>
    accountRef(serviceTagForSlot({ slot: slotName, kind: 'api-key' }, draft.connectorId), isMulti || slots.some(c => c.slot === slotName && c.kind === 'api-key' && c.headerName) ? slotName : undefined);

  // Mark slots whose key is already in the user's vault ("use existing"). A
  // failed lookup just means every slot prompts — never blocks approval.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setValues({});
    setError(null);
    void myCredentials
      .list()
      .then((creds) => {
        if (cancelled) return;
        const present: Record<string, boolean> = {};
        for (const s of slots) {
          present[s.slot] = creds.some((c) => c.ref === refFor(s.slot) && c.scope === 'user');
        }
        setHaveExisting(present);
      })
      .catch(() => {
        if (!cancelled) setHaveExisting({});
      });
    return () => {
      cancelled = true;
    };
  }, [open, draft.connectorId]);

  const allSlotsFilled = slots.every(
    (s) => haveExisting[s.slot] === true || (values[s.slot] ?? '').trim().length > 0,
  );

  async function connect(): Promise<void> {
    if (busy || !allSlotsFilled) return;
    setBusy(true);
    setError(null);
    try {
      for (const s of slots) {
        if (haveExisting[s.slot] === true) continue; // already vaulted
        const payload = (values[s.slot] ?? '').trim();
        if (payload.length === 0) continue;
        const service = serviceTagForSlot({ slot: s.slot, kind: 'api-key' }, draft.connectorId);
        const destination: Destination = {
          kind: 'account',
          service,
          ...(isMulti || Boolean(s.kind === 'api-key' && s.headerName) ? { slot: s.slot } : {}),
        };
        await setDestinationCredential({
          destination,
          slot: { kind: 'api-key' },
          scope: { scope: 'user', ownerId: null },
          payload,
        });
      }
      await approveAuthoredConnector(draft.connectorId, {
        agentId: draft.agentId,
        shown: {
          hosts: draft.proposal.allowedHosts,
          slots: slots.map((s) => s.slot),
          npm: draft.proposal.packages.npm,
          pypi: draft.proposal.packages.pypi,
        },
      });
      onApproved();
      onOpenChange(false);
    } catch (err) {
      // TASK-771 — the server refuses the approve with 503
      // `tool-permissions-reset-failed` when the promotion moved a server to a
      // new address and couldn't reset its tool permissions first. Say that in
      // words; every other failure keeps its own message.
      setError(
        isToolPermissionsResetFailure(err)
          ? TOOL_PERMISSIONS_RESET_FAILED_APPROVE_MESSAGE
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  const hosts = draft.proposal.allowedHosts;
  const { npm, pypi } = draft.proposal.packages;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onOpenChange(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {draft.name}</DialogTitle>
          <DialogDescription>
            Your assistant proposed this connector. Approve the access below only
            if you expected it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {/*
            (TASK-344) THE AUDIT MISSED THIS FILE. It was a near-copy of the
            (now-deleted) chat `PermissionCard`'s reach renderer and carried the
            same three defects TASK-334 fixed there — a bare "Will access" host
            list (A12), raw slot ids as field labels (A1), and the npm/pypi
            registry line (A5). Fixing one and not the other would have left
            the product saying two different things about the same decision,
            so the copy is now identical.
          */}
          {/* (TASK-711) Who supplies the key — same words, same place (before the
              reach) as the in-chat grant row this dialog is the twin of. */}
          <ConnectorKeyModeNotice keyMode={draft.keyMode} />
          {hosts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                To do this, it needs to reach:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {hosts.map((h) => (
                  <Badge key={h} variant="secondary">
                    {h}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {slots.map((s) =>
            haveExisting[s.slot] === true ? (
              <div key={s.slot} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">{humanizeId(s.slot)}</Badge>
                <span>Using the {humanizeSlotLabel(s.slot)} you already saved.</span>
              </div>
            ) : (
              <div key={s.slot} className="grid gap-1.5">
                <Label htmlFor={`approve-cred-${s.slot}`}>
                  {humanizeSlotLabel(s.slot)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  We store this key on the server. The agent never sees it, and it
                  never appears in your conversation.
                </p>
                <Input
                  id={`approve-cred-${s.slot}`}
                  type="password"
                  autoComplete="off"
                  value={values[s.slot] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [s.slot]: e.target.value }))}
                />
              </div>
            ),
          )}
          {/* (TASK-700) What the key lets the assistant do — the same words, in the
              same place (after the key, before Connect), as the in-chat grant row
              this dialog is the twin of. Keyed on the key, like the row: a
              proposal that takes no key hands over none. */}
          {slots.length > 0 && <ConnectorAccessNotice kind="key" />}
          {(npm.length > 0 || pypi.length > 0) && (
            <p className="text-sm text-muted-foreground" data-testid="proposed-packages">
              It will download some extra software it needs from the internet to
              do this.
            </p>
          )}
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Not now
            </Button>
            <Button disabled={busy || !allSlotsFilled} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
