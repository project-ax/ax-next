import { useEffect, useState } from 'react';

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
  }, [autoToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Welcome to ax</h1>
      <p>Paste the bootstrap token from your terminal to continue.</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(token); }}>
        <input
          type="text"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ax_bs_..."
          autoFocus
          style={{ width: '100%', padding: '0.5rem', fontFamily: 'monospace' }}
        />
        <button type="submit" disabled={busy || token.length === 0} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
          {busy ? 'Verifying…' : 'Continue'}
        </button>
        {err !== null && <p style={{ color: 'crimson' }}>{err}</p>}
      </form>
    </main>
  );
}
