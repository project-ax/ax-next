import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetupShell } from './SetupShell';

interface Props {
  autoToken: string | null;
  onClaimed: () => void;
}

export function StepGate({ autoToken, onClaimed }: Props) {
  const [token, setToken] = useState(autoToken ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(t: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/setup/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ token: t }),
      });
      if (r.ok) onClaimed();
      else if (r.status === 401) setErr('Invalid token');
      else if (r.status === 410) setErr('Setup already completed.');
      else if (r.status === 429) setErr('Too many attempts. Wait a minute and try again.');
      else setErr(`Unexpected (${r.status})`);
    } catch {
      setErr('Network error');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoToken !== null && autoToken.length > 0) void submit(autoToken);
    // submit is stable within this render and only depends on the autoToken
    // captured at mount time; intentionally one-shot on autoToken arrival.
  }, [autoToken]);

  return (
    <SetupShell
      title="Welcome to ax"
      description="Paste the bootstrap token from your terminal to continue."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(token);
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-token">Bootstrap token</Label>
          <Input
            id="setup-token"
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ax_bs_..."
            autoFocus
            className="font-mono"
          />
        </div>
        {err !== null && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy || token.length === 0}>
          {busy ? 'Verifying…' : 'Continue'}
        </Button>
      </form>
    </SetupShell>
  );
}
