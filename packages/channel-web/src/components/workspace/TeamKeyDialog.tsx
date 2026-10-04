/**
 * TeamKeyDialog — "Add team key" on a team agent's connector row (TASK-813).
 *
 * A team key is an api-key stored ON the agent: everyone using the agent uses
 * it, unless they've added their own (their own key is reached first). Only an
 * admin of the team that owns the agent may add one — the row carries
 * `teamKey` only for them, and `PUT …/connectors/:id/team-key` decides again.
 *
 * The connector is loaded the same way the Settings key dialog loads it
 * (`getConnector`, admin or settings route by role) and its slots come from
 * the same `deriveCredentialPlan`. Only api-key slots are offered: a sign-in
 * slot is not a key, and the connector's own OAuth client secret (the
 * `…:OAUTH_CLIENT_SECRET` ref, an admin's setting) is not a team key — the
 * same exclusion the server's `credentialChecks` makes. The slot NAME is all
 * the client sends; the server derives the vault ref itself.
 *
 * Each slot is a `CredentialSlotForm` whose `save` goes through
 * `workspaceApi.setTeamKey` — never `setDestinationCredential`, whose user /
 * admin routes would store a personal or company key instead. Once every slot
 * has been saved in this sitting the dialog hands back (`onSaved`): the caller
 * closes it and re-reads the list.
 *
 * DISCLOSURE (TASK-700): the key forms sit under `ConnectorAccessNotice`.
 * SECURITY: the key is a password field and is never rendered or logged.
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { CredentialSlotForm } from '@/components/credentials/CredentialSlotForm';
import { OAUTH_CLIENT_SECRET_SLOT } from '@/lib/connector-credential-slots';
import {
  deriveCredentialPlan,
  getConnector,
  type Connector,
  type ConnectorCredentialPlanEntry,
} from '@/lib/connectors';
import { humanizeSlotLabel } from '@/lib/humanize';
import { TEAM_KEY_UNAVAILABLE, workspaceApi } from '@/lib/workspace-api';

export interface TeamKeyDialogProps {
  agentId: string;
  /** The agent's display name — "Everyone using <agent> …". */
  agentName: string;
  connectorId: string;
  /** Shown while the connector loads. */
  connectorName: string;
  /** Picks the connector read route, same as the other connector dialogs. */
  isAdmin: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every offered slot now has a team key: close and re-read. */
  onSaved: () => void;
}

/** The api-key slots a team key can fill (no sign-in, no OAuth client secret). */
export function teamKeyEntries(connector: Connector): ConnectorCredentialPlanEntry[] {
  return deriveCredentialPlan(connector).filter(
    (entry) =>
      connector.capabilities.credentials.find((s) => s.slot === entry.slot)?.kind === 'api-key' &&
      !entry.ref.endsWith(`:${OAUTH_CLIENT_SECRET_SLOT}`),
  );
}

export function TeamKeyDialog({
  agentId,
  agentName,
  connectorId,
  connectorName,
  isAdmin,
  open,
  onOpenChange,
  onSaved,
}: TeamKeyDialogProps) {
  const base = isAdmin ? '/admin/connectors' : '/settings/connectors';
  const [connector, setConnector] = useState<Connector | null>(null);
  const [failed, setFailed] = useState(false);
  // Slots saved in THIS sitting. Reset every time the dialog opens.
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnector(null);
    setFailed(false);
    setSaved(new Set());
    getConnector(connectorId, base)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connectorId, base]);

  const entries = connector === null ? [] : teamKeyEntries(connector);

  function onSlotSaved(slot: string) {
    const next = new Set(saved).add(slot);
    setSaved(next);
    if (entries.length > 0 && entries.every((e) => next.has(e.slot))) onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add team key</DialogTitle>
          <DialogDescription>
            Everyone using {agentName} will use this key for{' '}
            {connector?.name ?? connectorName}, unless they’ve added their own.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>
              We couldn’t open {connectorName} just now. Please try again.
            </AlertDescription>
          </Alert>
        ) : connector === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : connector.keyMode === 'workspace' || entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{TEAM_KEY_UNAVAILABLE}</p>
        ) : (
          <div className="flex flex-col gap-5">
            <ConnectorAccessNotice kind="key" />
            {entries.map((entry) => {
              const slotMeta = connector.capabilities.credentials.find(
                (s) => s.slot === entry.slot,
              );
              return (
                <div key={entry.slot} className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2">
                    <p className="text-xs font-medium text-foreground">
                      {humanizeSlotLabel(entry.slot, entry.service)}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">{entry.slot}</p>
                  </div>
                  <CredentialSlotForm
                    destination={{
                      kind: 'account',
                      service: entry.service,
                      ...(entry.slotTag !== undefined ? { slot: entry.slotTag } : {}),
                    }}
                    slot={{
                      label: entry.slot,
                      kind: 'api-key',
                      ...(slotMeta?.kind === 'api-key' && slotMeta.description !== undefined
                        ? { description: slotMeta.description }
                        : {}),
                    }}
                    scope={{ scope: 'agent', ownerId: agentId }}
                    // Whether a team key is already stored is not read here;
                    // only a save in this sitting is known.
                    current={{ set: saved.has(entry.slot) }}
                    save={(payload) =>
                      workspaceApi.setTeamKey(agentId, connector.id, entry.slot, payload)
                    }
                    onSaved={() => onSlotSaved(entry.slot)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
