import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Destination } from '@ax/credentials';
import {
  setDestinationCredential,
  clearDestinationCredential,
} from '@/lib/credentials';

export interface CredentialSlotFormProps {
  destination: Destination;
  slot: { label: string; kind: 'api-key'; description?: string };
  scope: { scope: 'global' | 'user' | 'agent'; ownerId: string | null };
  current: { set: boolean; rotatedAt?: string };
  onSaved: () => void;
  onCleared: () => void;
}

export function CredentialSlotForm({
  destination,
  slot,
  scope,
  current,
  onSaved,
  onCleared,
}: CredentialSlotFormProps) {
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TASK-124 — a multi-slot connector renders one CredentialSlotForm PER slot, so
  // a static input id would collide across slots (ambiguous <label htmlFor>). A
  // per-instance id keeps each field's label association unique and accessible.
  const inputId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || payload.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await setDestinationCredential({ destination, slot, scope, payload });
      setPayload('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Remove the stored key (only offered when one is set). Clears the vault row
  // and lets the caller re-check presence (the connector tile flips back to
  // "needs a key"). 404 is treated as already-gone by clearDestinationCredential.
  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await clearDestinationCredential({ destination, scope });
      onCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)}>
      {slot.description && (
        <p className="text-xs text-muted-foreground">{slot.description}</p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>
          {current.set ? 'Replace ' : ''}API key
        </Label>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        {current.set && (
          <Button
            type="button"
            variant="ghost"
            disabled={removing || busy}
            onClick={() => void remove()}
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        )}
        <Button type="submit" disabled={busy || removing || payload.trim().length === 0}>
          {busy ? 'Saving…' : current.set ? 'Replace' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
