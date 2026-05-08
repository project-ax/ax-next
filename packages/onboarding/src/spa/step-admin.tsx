import { useState } from 'react';

interface Props { onCreated: () => void; }

export function StepAdmin({ onCreated }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
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
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        setErr(typeof body['error'] === 'string' ? body['error'] : 'Invalid input');
      } else if (r.status === 401) setErr('Bootstrap session expired. Reload to start over.');
      else setErr(`Unexpected (${r.status})`);
    } catch { setErr('Network error'); }
    finally { setBusy(false); }
  }

  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Create your admin account</h1>
      <p>You'll be the first admin. We'll add other authentication methods later.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ display: 'block', width: '100%', padding: '0.5rem' }} />
        </label>
        <button type="submit" disabled={busy || name.length === 0 || email.length === 0} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
          {busy ? 'Creating…' : 'Continue'}
        </button>
        {err !== null && <p style={{ color: 'crimson' }}>{err}</p>}
      </form>
    </main>
  );
}
