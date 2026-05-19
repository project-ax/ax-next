import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Destination } from '@ax/credentials';
import { setDestinationCredential } from '@/lib/credentials';

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
}: CredentialSlotFormProps) {
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || payload.length === 0) return;
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
        <Label htmlFor="cred-payload">
          {current.set ? 'Replace ' : ''}API key
        </Label>
        <Input
          id="cred-payload"
          type="password"
          autoComplete="off"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={busy || payload.length === 0}>
          {busy ? 'Saving…' : current.set ? 'Replace' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
