/**
 * AuthProvidersTab — admin OAuth identity provider CRUD.
 *
 * Lists `auth_providers` rows from `@ax/auth-better`, lets an admin add /
 * toggle / remove Google, GitHub, and generic OIDC identity providers.
 * Each mutation triggers `auth:providers-changed` server-side and the
 * better-auth handler hot-reloads — no kernel restart needed (I10).
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaneStatus } from '../PaneStatus';
import {
  listAuthProviders,
  setAuthProviderEnabled,
  deleteAuthProvider,
  type AuthProviderEntry,
  type AuthProviderKind,
} from '@/lib/auth-providers';
import { AddProviderForm } from './AddProviderForm';

const KIND_LABEL: Record<AuthProviderKind, string> = {
  google: 'Google',
  github: 'GitHub',
  oidc: 'Generic OIDC',
};

export function AuthProvidersTab() {
  const [providers, setProviders] = useState<AuthProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const list = await listAuthProviders();
      setProviders(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, []);

  const handleToggle = async (p: AuthProviderEntry) => {
    setActionError(null);
    try {
      await setAuthProviderEnabled(p.kind, !p.enabled);
      await fetchProviders();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (p: AuthProviderEntry) => {
    if (!window.confirm(`Remove the ${KIND_LABEL[p.kind]} provider?`)) return;
    setActionError(null);
    try {
      await deleteAuthProvider(p.kind);
      await fetchProviders();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Sign-in methods
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Configure OAuth identity providers users can sign in with. Client
          secrets are encrypted at rest and never returned in plaintext.
        </p>
      </div>

      {loading && <PaneStatus variant="loading">Loading providers…</PaneStatus>}

      {loadError && (
        <PaneStatus variant="error" className="mb-3 flex items-center justify-between gap-3">
          <span>Couldn't load providers: {loadError}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchProviders()}
          >
            Retry
          </Button>
        </PaneStatus>
      )}

      {actionError && (
        <PaneStatus variant="error" className="mb-3">
          {actionError}
        </PaneStatus>
      )}

      {!loading && !loadError && providers.length === 0 && !adding && (
        <PaneStatus variant="empty">
          No identity providers configured. Add one to let users sign in with
          Google, GitHub, or any OIDC issuer.
        </PaneStatus>
      )}

      <ul className="flex flex-col gap-2 list-none m-0 p-0">
        {providers.map((p) => (
          <li
            key={p.kind}
            className="flex items-center gap-3 px-3.5 py-3 bg-muted border border-rule-soft rounded-lg"
          >
            <div className="flex flex-col min-w-0 flex-1 gap-0.5">
              <span className="text-[13px] font-medium">{KIND_LABEL[p.kind]}</span>
              <span className="font-mono text-[11.5px] text-muted-foreground truncate">
                {p.clientId}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={p.enabled}
              aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${KIND_LABEL[p.kind]}`}
              onClick={() => void handleToggle(p)}
              className={
                'inline-flex items-center h-6 w-11 px-0.5 rounded-full transition-colors ' +
                (p.enabled ? 'bg-primary' : 'bg-input')
              }
            >
              <span
                className={
                  'block h-5 w-5 bg-background rounded-full shadow transition-transform ' +
                  (p.enabled ? 'translate-x-5' : 'translate-x-0')
                }
              />
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${KIND_LABEL[p.kind]}`}
              onClick={() => void handleDelete(p)}
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.6} />
            </Button>
          </li>
        ))}
      </ul>

      {adding ? (
        <AddProviderForm
          onSaved={() => {
            setAdding(false);
            void fetchProviders();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        !loading && (
          <div className="mt-4">
            <Button type="button" onClick={() => setAdding(true)}>
              Add provider
            </Button>
          </div>
        )
      )}
    </div>
  );
}
