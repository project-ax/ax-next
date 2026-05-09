import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SetupShell } from './SetupShell';

interface Props {
  onComplete: () => void;
}

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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/setup/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' },
        body: JSON.stringify({ apiKey, models: { fast: fastModel, default: defaultModel } }),
      });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok && body['ok'] === true) onComplete();
      else if (body['reason'] === 'credential-invalid') setErr('That API key was rejected. Double-check and try again.');
      else if (body['reason'] === 'credential-validation-timeout') setErr('Validation timed out. Network problem? Try again.');
      else if (body['reason'] === 'credential-validation-error') setErr('Validation failed. Try again.');
      else setErr(`Unexpected (${r.status})`);
    } catch {
      setErr('Network error');
    } finally {
      setBusy(false);
    }
  }

  // Filter models: fast options exclude 'default'; default options exclude 'fast'.
  const fastOptions = MODELS.filter((m) => m.kind === 'fast' || m.kind === 'either');
  const defaultOptions = MODELS.filter((m) => m.kind === 'default' || m.kind === 'either');

  return (
    <SetupShell
      title="Connect Anthropic"
      description="We'll validate your API key, then create a default chat agent."
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-api-key">API key</Label>
          <Input
            id="setup-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            required
            autoFocus
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-fast-model">Fast model (titles, short tasks)</Label>
          <Select value={fastModel} onValueChange={setFastModel}>
            <SelectTrigger id="setup-fast-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fastOptions.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="setup-default-model">Chat model</Label>
          <Select value={defaultModel} onValueChange={setDefaultModel}>
            <SelectTrigger id="setup-default-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {defaultOptions.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {err !== null && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy || apiKey.length === 0}>
          {busy ? 'Validating…' : 'Finish setup'}
        </Button>
      </form>
    </SetupShell>
  );
}
