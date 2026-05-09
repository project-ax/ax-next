import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetupShell } from './SetupShell';

interface Props {
  onCreated: () => void;
}

export function StepAdmin({ onCreated }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/setup/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ name, email }),
      });
      if (r.ok) onCreated();
      else if (r.status === 400) {
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        setErr(typeof body['error'] === 'string' ? body['error'] : 'Invalid input');
      } else if (r.status === 401) setErr('Bootstrap session expired. Reload to start over.');
      else setErr(`Unexpected (${r.status})`);
    } catch {
      setErr('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupShell
      title="Create your admin account"
      description="You'll be the first admin. We'll add other authentication methods later."
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-admin-name">Name</Label>
          <Input
            id="setup-admin-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-admin-email">Email</Label>
          <Input
            id="setup-admin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {err !== null && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <Button
          type="submit"
          disabled={busy || name.length === 0 || email.length === 0}
        >
          {busy ? 'Creating…' : 'Continue'}
        </Button>
      </form>
    </SetupShell>
  );
}
