import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetupShell, SETUP_UNEXPECTED } from './SetupShell';

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
      } else if (r.status === 401) setErr('Setup timed out. Reload the page to start again.');
      else {
        console.warn('[setup] admin create failed', r.status);
        setErr(SETUP_UNEXPECTED);
      }
    } catch (err) {
      console.warn('[setup] admin create request failed', err);
      setErr('We couldn’t reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SetupShell
      step={2}
      title="Create your admin account"
      // (B8) Say what this is FOR, and promise no mechanism. The previous copy
      // committed us to "other authentication methods later", which is a
      // roadmap rather than an explanation and may simply not happen. This
      // wording stays true whichever way audit open question 2 (can an
      // email-created admin lock themselves out of a Google-only sign-in?) is
      // eventually answered — deliberately NOT answering it here.
      description="You're the first person here. We'll use this to set up your account and sign you back in later."
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
