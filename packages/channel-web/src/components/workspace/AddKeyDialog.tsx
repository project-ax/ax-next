/**
 * AddKeyDialog — the form for a connector's per-agent keys (slice 3). Two
 * callers, one form:
 *
 *   - `purpose: 'add'` — the rail Add subview. Saving IS the Add: one request
 *     carries every key the connector needs and adds it to the agent (`onSave`
 *     → `workspaceApi.attachConnector(…, keys)`), so the agent ends up with
 *     the connector AND its keys, or with neither.
 *   - `purpose: 'add-key'` — a connector row's **Add key**, when the agent's
 *     key is missing (`AgentKeyDialog`: `onSave` → `workspaceApi.setAgentKey`
 *     per slot). The connector may still be loading (`connector: null`) or
 *     have failed to (`failed`); the dialog says so in place of the form.
 *
 * Either way this collects values only — it never writes a key on its own,
 * the way `CredentialSlotForm` does. Each slot is the same `ApiKeyField` the
 * per-slot forms draw. Save stays disabled until every slot has a key.
 *
 * A refusal keeps the dialog open with what was typed, so trying again is one
 * click; `onSave` turns the refusal into a fixed sentence (never server text).
 *
 * DISCLOSURE (TASK-700): the fields sit under `ConnectorAccessNotice kind="key"`.
 * SECURITY: password fields; the keys never leave this component except in
 * `onSave`, and are never rendered or logged.
 * shadcn primitives + semantic tokens only (invariant #6).
 */
import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { ApiKeyField } from '@/components/credentials/ApiKeyField';
import { ConnectorAccessNotice } from '@/components/credentials/ConnectorAccessNotice';
import { agentKeyEntries } from '@/lib/add-connector';
import type { Connector } from '@/lib/connectors';
import { humanizeSlotLabel } from '@/lib/humanize';
import type { AgentConnectorKey } from '@/lib/workspace-api';

export interface AddKeyDialogProps {
  /** `null` while it loads (`'add-key'` only). */
  connector: Connector | null;
  /** Shown while the connector loads, or when it failed to. */
  connectorName?: string;
  /** The connector didn't load: say so, with no form. */
  failed?: boolean;
  /** `'add'` (default): the Add subview. `'add-key'`: a row's Add key. */
  purpose?: 'add' | 'add-key';
  /** The agent's display name. */
  agentName: string;
  /** A team agent: everyone using it uses this key. */
  teamAgent: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Save these keys (and, for `'add'`, add the connector). Resolves once
   * saved; rejects with an `Error` whose message is the sentence to show.
   */
  onSave: (keys: AgentConnectorKey[]) => Promise<void>;
}

export function AddKeyDialog({
  connector,
  connectorName,
  failed = false,
  purpose = 'add',
  agentName,
  teamAgent,
  open,
  onOpenChange,
  onSave,
}: AddKeyDialogProps) {
  const entries = connector === null ? [] : agentKeyEntries(connector);
  const name = connector?.name ?? connectorName ?? '';
  const adding = purpose === 'add';
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form every time it opens: no key outlives the dialog.
  useEffect(() => {
    if (!open) return;
    setValues({});
    setError(null);
    setBusy(false);
  }, [open, connector?.id]);

  const complete =
    entries.length > 0 && entries.every((e) => (values[e.slot] ?? '').trim().length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !complete) return;
    setBusy(true);
    setError(null);
    try {
      // Leading/trailing spaces and newlines are never part of a key (a paste
      // often brings a trailing newline), so they are trimmed before anything
      // is encoded or sent — for the Add form and the rail's Add key alike.
      await onSave(
        entries.map((entry) => ({ slot: entry.slot, payload: (values[entry.slot] ?? '').trim() })),
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : adding
            ? 'We couldn’t add it just now. Please try again.'
            : 'We couldn’t save the key just now. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{adding ? `Add ${name}` : `Add a key for ${name}`}</DialogTitle>
          <DialogDescription>
            {teamAgent
              ? `Everyone using ${agentName} will use this key for ${name}.`
              : `${agentName} will use this key for ${name}.`}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>We couldn’t open {name} just now. Please try again.</AlertDescription>
          </Alert>
        ) : connector === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
            <ConnectorAccessNotice kind="key" />
            <FieldGroup>
              {entries.map((entry) => {
                const meta = connector.capabilities.credentials.find((s) => s.slot === entry.slot);
                return (
                  <ApiKeyField
                    key={entry.slot}
                    label={humanizeSlotLabel(entry.slot, entry.service)}
                    value={values[entry.slot] ?? ''}
                    onChange={(v) => setValues((prev) => ({ ...prev, [entry.slot]: v }))}
                    disabled={busy}
                    {...(meta?.kind === 'api-key' && meta.description !== undefined
                      ? { description: meta.description }
                      : {})}
                  />
                );
              })}
            </FieldGroup>
            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !complete}>
                {adding ? (busy ? 'Adding…' : 'Add') : busy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
