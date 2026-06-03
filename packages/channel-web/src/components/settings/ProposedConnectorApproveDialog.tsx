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
import {
  approveAuthoredConnector,
  serviceTagForSlot,
  accountRef,
  type PendingAuthoredConnector,
} from '@/lib/connectors';
import { myCredentials, setDestinationCredential } from '@/lib/credentials';
import type { Destination } from '@ax/credentials';

/**
 * The Settings-side twin of the in-chat connector approval card
 * (`PermissionCard`, kind:'connector'). Surfaces a connector the assistant
 * PROPOSED mid-turn (a pending authored draft) so the user can approve it
 * outside chat — the fallback for a missed/dismissed card.
 *
 * Same handshake as the card: collect a key per declared slot (a slot already in
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
  const isMulti = slots.length >= 2;
  // The user's secret lands at user scope (mirrors the in-chat card, which always
  // writes scope:'user'); a connector owns its key keyed by its id.
  const refFor = (slotName: string): string =>
    accountRef(serviceTagForSlot({ slot: slotName, kind: 'api-key' }, draft.connectorId), isMulti ? slotName : undefined);

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
          ...(isMulti ? { slot: s.slot } : {}),
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
      setError(err instanceof Error ? err.message : String(err));
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
          {hosts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">Will access</p>
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
                <Badge variant="secondary">{s.slot}</Badge>
                <span>Using your existing key</span>
              </div>
            ) : (
              <div key={s.slot} className="grid gap-1.5">
                <Label htmlFor={`approve-cred-${s.slot}`}>{s.slot}</Label>
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
          {(npm.length > 0 || pypi.length > 0) && (
            <p className="text-sm text-muted-foreground" data-testid="proposed-packages">
              {npm.length > 0 && (
                <>Installs npm packages → reaches <code>registry.npmjs.org</code>. </>
              )}
              {pypi.length > 0 && (
                <>Installs Python packages → reaches <code>pypi.org</code>, <code>files.pythonhosted.org</code>.</>
              )}
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
