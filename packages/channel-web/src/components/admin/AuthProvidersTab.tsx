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
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  // Providers awaiting confirmation (null = no dialog). Styled-confirm pattern
  // (TASK-117: project-wide styled Dialog) — no OS `window.confirm`.
  // `pendingDisable` is the last-enabled-provider lockout guard (TASK-342/D5).
  const [pendingDisable, setPendingDisable] = useState<AuthProviderEntry | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<AuthProviderEntry | null>(
    null,
  );

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const list = await listAuthProviders();
      setProviders(list);
      setLoadError(null);
    } catch (err) {
      // The detail belongs in the console, not in a banner an admin has to
      // read past to find the Try again button.
      console.warn('[auth-providers] could not load sign-in methods', err);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchProviders();
  }, []);

  /**
   * (TASK-342 / audit D5) Disabling the last enabled provider locks EVERY user
   * out of this deployment, including the admin doing it — there is no other
   * way in, and no way back through the UI once you are out. It used to be one
   * unremarkable click on a toggle that looked exactly like the other toggles.
   *
   * So the last one asks first. Any other toggle still flips immediately: a
   * confirmation on every switch would train people to click through this one.
   */
  const enabledCount = providers.filter((p) => p.enabled).length;
  const isLastEnabled = (p: AuthProviderEntry): boolean =>
    p.enabled && enabledCount === 1;

  const applyToggle = async (p: AuthProviderEntry) => {
    setActionError(null);
    try {
      await setAuthProviderEnabled(p.kind, !p.enabled);
      await fetchProviders();
    } catch (err) {
      console.warn('[auth-providers] could not change that sign-in method', err);
      setActionError('We couldn’t change that sign-in method. Give it another try in a moment.');
    }
  };

  const handleToggle = async (p: AuthProviderEntry) => {
    if (isLastEnabled(p)) {
      setPendingDisable(p);
      return;
    }
    await applyToggle(p);
  };

  const confirmDisable = async () => {
    if (!pendingDisable) return;
    const p = pendingDisable;
    setPendingDisable(null);
    await applyToggle(p);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    try {
      await deleteAuthProvider(pendingDelete.kind);
      await fetchProviders();
      setPendingDelete(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setPendingDelete(null);
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
          {/* The raw message went to the console with TASK-342; and the button
              says "Try again" now, which is the label the audit and the track's
              copy spec settle on. TASK-341 introduced the same pair in
              ModelConfigTab and flagged that this one still read "Retry" —
              this is that alignment. */}
          <span>We couldn’t load your sign-in methods.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchProviders()}
          >
            Try again
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
            {/* (D5) Was a hand-rolled switch — two divs and a translate. The
                primitive is installed and brings its own keyboard handling. */}
            <Switch
              checked={p.enabled}
              aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${KIND_LABEL[p.kind]}`}
              onCheckedChange={() => void handleToggle(p)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${KIND_LABEL[p.kind]}`}
              onClick={() => setPendingDelete(p)}
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

      {/* (D5) The last sign-in method asks before it goes. Nothing else on this
          page can lock every user, including this admin, out of the product. */}
      {pendingDisable !== null && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v) setPendingDisable(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Turn off the only way to sign in?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {KIND_LABEL[pendingDisable.kind]}
              </span>{' '}
              is the only sign-in method still switched on. Turning it off will
              lock everyone out — including you, and including this page. Add
              another method first if you can.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingDisable(null)}>
                Keep it on
              </Button>
              <Button variant="destructive" onClick={() => void confirmDisable()}>
                Turn it off anyway
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirmation dialog (styled — no OS confirm). */}
      {pendingDelete !== null && (
        <Dialog
          open={true}
          onOpenChange={(v) => {
            if (!v) setPendingDelete(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove provider?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Remove the{' '}
              <span className="font-medium text-foreground">
                {KIND_LABEL[pendingDelete.kind]}
              </span>{' '}
              identity provider? Users will no longer be able to sign in with it.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void confirmDelete()}>
                Remove
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
