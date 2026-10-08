import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiKeyField } from '@/components/credentials/ApiKeyField';
import type { Destination } from '@ax/credentials';
import { setDestinationCredential } from '@/lib/credentials';

export interface CredentialSlotFormProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  current: { set: boolean; rotatedAt?: string };
  onSaved: () => void;
  /**
   * TASK-813 — where the key goes instead of the destination's own route (the
   * team-key dialog saves through the agent's team-key PUT). Absent: the
   * default `setDestinationCredential` write. A rejection's message is shown.
   */
  save?: (payload: string) => Promise<void>;
}

export function CredentialSlotForm({
  destination,
  slot,
  scope,
  current,
  onSaved,
  save,
}: CredentialSlotFormProps) {
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || payload.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (save) await save(payload);
      else await setDestinationCredential({ destination, slot, scope, payload });
      setPayload('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      {slot.description && (
        <p className="text-xs text-muted-foreground">{slot.description}</p>
      )}
      {/* Saved-state cue. The secret never leaves the vault (the server returns
          presence metadata only — never the value), so we can't show even a
          masked copy; but a blank "Replace" field reads like "no key here", so we
          make the saved state unmistakable. Replacing it is then a deliberate act. */}
      {current.set && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5 text-foreground" />
          A key is saved — enter a new one to replace it.
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {/* The same field the rail's Add key form draws (ApiKeyField). */}
      <ApiKeyField
        label={current.set ? 'Replace API key' : 'API key'}
        placeholder={current.set ? 'Enter a new key' : ''}
        value={payload}
        onChange={setPayload}
      />
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={busy || payload.trim().length === 0}>
          {busy ? 'Saving…' : current.set ? 'Replace' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
