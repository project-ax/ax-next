import { useState, type FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { upsertAuthProvider, type AuthProviderKind } from '@/lib/auth-providers';
import { cn } from '@/lib/utils';

export interface AddProviderFormProps {
  onSaved: () => void;
  onCancel: () => void;
}

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * (TASK-342 / audit D4) One muted line under a field, wired to its control with
 * `aria-describedby` so it reaches a screen reader rather than only a pair of
 * eyes.
 *
 * This form asked a non-technical admin for a Client ID, a Client secret and a
 * Discovery URL, and explained none of them. Those are not guessable: an admin
 * who has never registered an OAuth app has no way to know that two of the
 * three arrive together on one screen, or that "Discovery URL" is the same
 * thing their provider's docs call the well-known configuration.
 */
function FieldHint({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-xs leading-[1.45] text-muted-foreground">
      {children}
    </p>
  );
}

export function AddProviderForm({ onSaved, onCancel }: AddProviderFormProps) {
  const [kind, setKind] = useState<AuthProviderKind>('google');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOidc = kind === 'oidc';
  const canSave =
    !saving &&
    clientId.trim().length > 0 &&
    clientSecret.trim().length > 0 &&
    (!isOidc || discoveryUrl.trim().length > 0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await upsertAuthProvider({
        kind,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(isOidc ? { discoveryUrl: discoveryUrl.trim() } : {}),
        ...(allowedDomains.trim().length > 0
          ? { allowedDomains: allowedDomains.trim() }
          : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3.5 p-3.5 bg-muted border border-rule-soft rounded-lg flex flex-col gap-3 animate-form-in"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="auth-provider-kind">Provider</Label>
        <select
          id="auth-provider-kind"
          className={SELECT_CLASS}
          value={kind}
          disabled={saving}
          onChange={(e) => setKind(e.target.value as AuthProviderKind)}
          aria-describedby="auth-provider-kind-hint"
        >
          <option value="google">Google</option>
          <option value="github">GitHub</option>
          <option value="oidc">Generic OIDC</option>
        </select>
        <FieldHint id="auth-provider-kind-hint">
          The service people will use to sign in. Pick Generic OIDC if your
          company uses its own single sign-on.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="auth-provider-client-id">Client ID</Label>
        <Input
          id="auth-provider-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={saving}
          autoComplete="off"
          aria-describedby="auth-provider-client-id-hint"
        />
        <FieldHint id="auth-provider-client-id-hint">
          You get this when you register ax as an application with the provider
          above. It identifies ax, and it isn't a secret.
        </FieldHint>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="auth-provider-client-secret">Client secret</Label>
        <Input
          id="auth-provider-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={saving}
          autoComplete="off"
          className="font-mono text-[13px] tracking-[0.02em]"
          aria-describedby="auth-provider-client-secret-hint"
        />
        <FieldHint id="auth-provider-client-secret-hint">
          Issued alongside the Client ID, on the same screen. Treat it like a
          password.
        </FieldHint>
      </div>

      {isOidc && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="auth-provider-discovery-url">Discovery URL</Label>
          <Input
            id="auth-provider-discovery-url"
            value={discoveryUrl}
            onChange={(e) => setDiscoveryUrl(e.target.value)}
            disabled={saving}
            placeholder="https://issuer.example.com/.well-known/openid-configuration"
            aria-describedby="auth-provider-discovery-url-hint"
          />
          <FieldHint id="auth-provider-discovery-url-hint">
            The address ax checks sign-ins against. Your provider's docs may call
            it the discovery URL, the OIDC URL, or the well-known configuration —
            they all mean this one.
          </FieldHint>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="auth-provider-allowed-domains">
          Allowed email domains{' '}
          <span className="text-muted-foreground text-[11.5px]">(optional)</span>
        </Label>
        <Input
          id="auth-provider-allowed-domains"
          value={allowedDomains}
          onChange={(e) => setAllowedDomains(e.target.value)}
          disabled={saving}
          placeholder="example.com, partner.com"
          aria-describedby="auth-provider-allowed-domains-hint"
        />
        <FieldHint id="auth-provider-allowed-domains-hint">
          Leave this blank and anyone with an account at that provider can sign
          in. List your own domains to keep it to your organisation.
        </FieldHint>
      </div>

      {error && (
        <div
          role="alert"
          className={cn(
            'inline-flex items-center gap-2 px-2.5 py-2 self-start',
            'bg-destructive-soft border border-destructive/25 rounded-md',
            'text-[12.5px] text-destructive',
          )}
        >
          <AlertCircle className="w-3 h-3 shrink-0" strokeWidth={2.5} />
          <span>{error}</span>
        </div>
      )}

      <div className="flex gap-2 items-center">
        <Button type="submit" disabled={!canSave}>
          {saving ? 'Saving…' : error ? 'Retry' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
