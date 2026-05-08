import { useState } from 'react';

interface Props { onComplete: () => void; }

const MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast)', kind: 'fast' as const },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)', kind: 'either' as const },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (capable)', kind: 'default' as const },
];

export function StepModel({ onComplete }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [fastModel, setFastModel] = useState('claude-haiku-4-5-20251001');
  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-6');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/setup/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ apiKey, models: { fast: fastModel, default: defaultModel } }),
      });
      const body = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (r.ok && body['ok'] === true) onComplete();
      else if (body['reason'] === 'credential-invalid') setErr('That API key was rejected. Double-check and try again.');
      else if (body['reason'] === 'credential-validation-timeout') setErr('Validation timed out. Network problem? Try again.');
      else if (body['reason'] === 'credential-validation-error') setErr('Validation failed. Try again.');
      else setErr(`Unexpected (${r.status})`);
    } catch { setErr('Network error'); }
    finally { setBusy(false); }
  }

  // Filter models: fast options exclude 'default'; default options exclude 'fast'.
  const fastOptions = MODELS.filter((m) => m.kind === 'fast' || m.kind === 'either');
  const defaultOptions = MODELS.filter((m) => m.kind === 'default' || m.kind === 'either');

  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Connect Anthropic</h1>
      <p>We'll validate your API key, then create a default chat agent.</p>
      <form onSubmit={(e) => void submit(e)}>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            required
            style={{ display: 'block', width: '100%', padding: '0.5rem', fontFamily: 'monospace' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Fast model (used for short tasks like titles)
          <select value={fastModel} onChange={(e) => setFastModel(e.target.value)} style={{ display: 'block', width: '100%', padding: '0.5rem' }}>
            {fastOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'block', marginTop: '1rem' }}>
          Chat model
          <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} style={{ display: 'block', width: '100%', padding: '0.5rem' }}>
            {defaultOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || apiKey.length === 0} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
          {busy ? 'Validating…' : 'Finish setup'}
        </button>
        {err !== null && <p style={{ color: 'crimson' }}>{err}</p>}
      </form>
    </main>
  );
}
