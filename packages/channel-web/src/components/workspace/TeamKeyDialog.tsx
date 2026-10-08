/**
 * TeamKeyDialog — "Team key" on a team agent's connector row (TASK-813,
 * saved state + remove/replace TASK-854).
 *
 * A team key is an api-key stored ON the agent: everyone using the agent uses
 * it, unless they've added their own (their own key is reached first). Only an
 * admin of the team that owns the agent may add, replace or remove one — the
 * row carries `teamKey` only for them, and every `…/connectors/:id/team-key`
 * call decides again.
 *
 * The connector is loaded the same way the Settings key dialog loads it
 * (`getConnector`, admin or settings route by role) and its slots come from
 * the same `deriveCredentialPlan`. Only api-key slots are offered: a sign-in
 * slot is not a key, and the connector's own OAuth client secret (the
 * `…:OAUTH_CLIENT_SECRET` ref, an admin's setting) is not a team key — the
 * same exclusion the server's `credentialChecks` makes. The slot NAME is all
 * the client sends; the server derives the vault ref itself.
 *
 * Alongside the connector, `workspaceApi.getTeamKeys` says which slots already
 * have a key (presence only — the key never comes back). Each slot shows
 * "Key saved" / "No key"; a saved one offers Replace (the form) and Remove
 * key (inline confirm → `removeTeamKey` → `onRemoved`, so the caller re-reads).
 * If that status read fails we say so once, show no badges and no Remove, and
 * saving still works.
 *
 * Each slot is a `CredentialSlotForm` whose `save` goes through
 * `workspaceApi.setTeamKey` — never `setDestinationCredential`, whose user /
 * admin routes would store a personal or company key instead. Once every slot
 * has a key (saved before, or now) the dialog hands back (`onSaved`): the
 * caller closes it and re-reads the list.
 *
 * DISCLOSURE (TASK-700): the key forms sit under `ConnectorAccessNotice`.
 * SECURITY: the key is a password field and is never rendered or logged.
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useId, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { CredentialSlotForm } from '@/components/credentials/CredentialSlotForm';
import { agentKeyEntries } from '@/lib/add-connector';
import { getConnector, type Connector, type ConnectorCredentialPlanEntry } from '@/lib/connectors';
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
  /** TASK-854 — a team key was removed: re-read (the dialog stays open). */
  onRemoved?: () => void;
}

/** slot → has a key. A slot missing from the map is unknown. */
type KeyState = Readonly<Record<string, boolean>>;

export function TeamKeyDialog({
  agentId,
  agentName,
  connectorId,
  connectorName,
  isAdmin,
  open,
  onOpenChange,
  onSaved,
  onRemoved,
}: TeamKeyDialogProps) {
  const base = isAdmin ? '/admin/connectors' : '/settings/connectors';
  const [connector, setConnector] = useState<Connector | null>(null);
  const [failed, setFailed] = useState(false);
  // What we know about each slot: from the status read, then this sitting's
  // saves and removes. Reset every time the dialog opens.
  const [keys, setKeys] = useState<KeyState>({});
  const [statusFailed, setStatusFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConnector(null);
    setFailed(false);
    setKeys({});
    setStatusFailed(false);
    getConnector(connectorId, base)
      .then((c) => {
        if (!cancelled) setConnector(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    workspaceApi
      .getTeamKeys(agentId, connectorId)
      .then((slots) => {
        if (cancelled) return;
        // A save or remove that landed first is newer than this read.
        setKeys((prev) => ({
          ...Object.fromEntries(slots.map((s) => [s.slot, s.saved])),
          ...prev,
        }));
      })
      .catch(() => {
        if (!cancelled) setStatusFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agentId, connectorId, base]);

  const entries = connector === null ? [] : agentKeyEntries(connector);

  function onSlotSaved(slot: string) {
    const next = { ...keys, [slot]: true };
    setKeys(next);
    if (entries.length > 0 && entries.every((e) => next[e.slot] === true)) onSaved();
  }

  function onSlotRemoved(slot: string) {
    setKeys((prev) => ({ ...prev, [slot]: false }));
    onRemoved?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Team key</DialogTitle>
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
            {statusFailed && (
              <p className="text-sm text-muted-foreground">
                We couldn’t check whether a team key is saved.
              </p>
            )}
            {entries.map((entry) => (
              <TeamKeySlot
                key={entry.slot}
                agentId={agentId}
                connector={connector}
                entry={entry}
                saved={keys[entry.slot]}
                onSaved={() => onSlotSaved(entry.slot)}
                onRemoved={() => onSlotRemoved(entry.slot)}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface TeamKeySlotProps {
  agentId: string;
  connector: Connector;
  entry: ConnectorCredentialPlanEntry;
  /** `undefined` — we don't know (the status read failed or is pending). */
  saved: boolean | undefined;
  onSaved: () => void;
  onRemoved: () => void;
}

/** One slot: its name, whether a key is saved, Remove key, and the key form. */
function TeamKeySlot({ agentId, connector, entry, saved, onSaved, onRemoved }: TeamKeySlotProps) {
  const labelId = useId();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slotMeta = connector.capabilities.credentials.find((s) => s.slot === entry.slot);

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await workspaceApi.removeTeamKey(agentId, connector.id, entry.slot);
      setConfirming(false);
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn’t remove that key. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p id={labelId} className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground">
            {humanizeSlotLabel(entry.slot, entry.service)}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{entry.slot}</span>
        </p>
        {saved !== undefined && (
          <Badge variant={saved ? 'secondary' : 'outline'} className="ml-auto">
            {saved ? 'Key saved' : 'No key'}
          </Badge>
        )}
      </div>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {saved === true &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              Remove this team key? People without their own key won’t be able to use{' '}
              {connector.name}.
            </p>
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={removing}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={removing}
                onClick={() => void remove()}
              >
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              Remove key
            </Button>
          </div>
        ))}
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
        current={{ set: saved === true }}
        save={(payload) => workspaceApi.setTeamKey(agentId, connector.id, entry.slot, payload)}
        onSaved={onSaved}
      />
    </div>
  );
}
