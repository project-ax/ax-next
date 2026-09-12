import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetupShell, SETUP_UNEXPECTED } from './SetupShell';

/**
 * What the wizard says for each rejection `@ax/onboarding` can return from
 * `POST /setup/admin` (`routes.ts`: `invalid-json`, `missing-name`,
 * `invalid-email`). Anything unrecognised falls back to a plain sentence, and
 * the code goes to the console.
 *
 * A `Map`, not an object, for the reason TASK-334's security checklist turned
 * up: the key is a SERVER-CONTROLLED string, and a plain-object lookup on
 * `constructor` or `valueOf` resolves through `Object.prototype` and hands back
 * a function where a string was expected — which React then throws on, taking
 * out the screen that was trying to report an error.
 */
const ADMIN_FIELD_ERRORS = new Map<string, string>([
  ['missing-name', 'Please add your name.'],
  ['invalid-email', 'That email address doesn’t look right. Check it and try again.'],
  ['invalid-json', 'Something went wrong sending that. Give it another try in a moment.'],
]);

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
        // (TASK-340 follow-up, found walking the wizard against the kind
        // cluster.) This used to render the server's error CODE verbatim, so
        // typing an address without a TLD showed a first-run user the word
        // "invalid-email". TASK-340 dropped the raw HTTP status for exactly
        // this reason and left this branch alone as out of scope; the walk
        // showed it is the same defect one layer down.
        const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        const code = typeof body['error'] === 'string' ? body['error'] : '';
        console.warn('[setup] admin create rejected', code || r.status);
        setErr(ADMIN_FIELD_ERRORS.get(code) ?? 'Check the details above and try again.');
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
