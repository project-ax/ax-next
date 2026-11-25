/**
 * AuthProvidersTab — admin OAuth identity provider CRUD.
 *
 * Lists `auth_providers` rows from `@ax/auth-better`, lets an admin add /
 * toggle / remove Google and GitHub identity providers.
 * Each mutation triggers `auth:providers-changed` server-side and the
 * better-auth handler hot-reloads — no kernel restart needed (I10).
 */
import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { SettingsActions } from '../settings/SettingsLayout';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AsyncState, ConfirmAction, Notice } from '@project-ax/ui';
import { focusAfterRemoval } from '@/lib/focus-after-removal';
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
};

/**
 * Google and GitHub are the only kinds the server signs anyone in with. The
 * list can still hold another (a leftover `oidc` row, TASK-1116): the server
 * skips it at sign-in whatever its switch says, refuses to toggle it, and
 * still lets it be removed.
 */
function isWiredKind(kind: string): kind is AuthProviderKind {
  return Object.hasOwn(KIND_LABEL, kind);
}

/** An unknown kind shows as stored. */
function labelFor(kind: string): string {
  return isWiredKind(kind) ? KIND_LABEL[kind] : kind;
}

export function AuthProvidersTab() {
  const [providers, setProviders] = useState<AuthProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuthProviderEntry | null>(null);
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
   *
   * Only Google and GitHub count. A leftover row of another kind signs nobody
   * in, enabled or not, so counting it hid this warning on the real last
   * method (TASK-1116).
   */
  const enabledCount = providers.filter((p) => p.enabled && isWiredKind(p.kind)).length;
  const isLastEnabled = (p: AuthProviderEntry): boolean =>
    p.enabled && isWiredKind(p.kind) && enabledCount === 1;

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
    // applyToggle reports its own failure on the page, so the dialog always closes.
    await applyToggle(pendingDisable);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    await deleteAuthProvider(pendingDelete.kind);
    await fetchProviders();
    // The provider's row is gone with it; park focus on the page's primary action.
    focusAfterRemoval('[data-return-focus="auth-providers"]');
  };

  return (
    <div className="font-sans">
      <SettingsActions><Button type="button" data-return-focus="auth-providers" onClick={() => setAdding(true)}>Add provider</Button></SettingsActions>

      {loading && <AsyncState status="loading" skeleton="rows" loadingLabel="Loading providers…" />}

      {/* The raw message went to the console with TASK-342; the button says "Try again", the label the audit and
          the track's copy spec settle on (TASK-341 introduced the same pair in ModelConfigTab). */}
      {loadError && (
        <AsyncState
          status="error"
          skeleton="rows"
          loadingLabel="Loading providers…"
          error={{ message: 'We couldn’t load your sign-in methods.', onRetry: () => void fetchProviders() }}
        />
      )}

      {actionError && (
        <Notice tone="danger">{actionError}</Notice>
      )}

      {!loading && !loadError && providers.length === 0 && !adding && (
        <AsyncState
          status="empty"
          skeleton="rows"
          loadingLabel="Loading providers…"
          empty={{
            title: 'No identity providers configured',
            description: 'Add one to let users sign in with Google or GitHub.',
          }}
        />
      )}

      <ul className="flex flex-col list-none m-0 p-0">
        {providers.map((p, i) => {
          const wired = isWiredKind(p.kind);
          // A leftover kind shows as off whatever its stored flag says:
          // nobody signs in through it, so it must never look like a way in.
          const on = wired && p.enabled;
          const hintId = `auth-provider-unsupported-${i}`;
          return (
            <li
              key={p.kind}
              className="flex min-h-[72px] items-center gap-4 border-b border-border px-2 py-3"
            >
              <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                <span className="text-[13px] font-medium">{labelFor(p.kind)}</span>
                {!wired && (
                  <span id={hintId} className="text-xs text-muted-foreground">
                    No longer supported, so it does nothing. You can remove it.
                  </span>
                )}
              </div>
              {/* (D5) Was a hand-rolled switch — two divs and a translate. The
                  primitive is installed and brings its own keyboard handling.
                  A leftover kind's switch is off and disabled: the server
                  skips it at sign-in and refuses to toggle it. */}
              <Switch
                checked={on}
                disabled={!wired}
                aria-describedby={wired ? undefined : hintId}
                aria-label={`${on ? 'Disable' : 'Enable'} ${labelFor(p.kind)}`}
                onCheckedChange={() => void handleToggle(p)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Details for ${labelFor(p.kind)}`}
                onClick={() => setSelected(p)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <AddProviderForm
          onSaved={() => {
            setAdding(false);
            void fetchProviders();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-[424px]">
          <SheetHeader><SheetTitle>{selected ? labelFor(selected.kind) : 'Sign-in method'}</SheetTitle><SheetDescription>Manage this sign-in method.</SheetDescription></SheetHeader>
          {selected && <div className="mt-6 flex flex-col gap-6">
            <p className="break-all text-sm text-muted-foreground">Client ID: {selected.clientId}</p>
            <Button type="button" variant="destructive" onClick={() => { setPendingDelete(selected); setSelected(null); }} aria-label={`Remove ${labelFor(selected.kind)}`}>Remove {selected ? labelFor(selected.kind) : 'method'}</Button>
          </div>}
        </SheetContent>
      </Sheet>

      {/* (D5) The last sign-in method asks before it goes. Nothing else on this
          page can lock every user, including this admin, out of the product. */}
      <ConfirmAction
        open={pendingDisable !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDisable(null);
        }}
        title="Turn off the only way to sign in?"
        description={`${labelFor(pendingDisable?.kind ?? '')} is the only sign-in method still switched on. Turning it off will lock everyone out — including you, and including this page. Add another method first if you can.`}
        confirmLabel="Turn it off anyway"
        onConfirm={confirmDisable}
      />

      <ConfirmAction
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title="Remove provider?"
        description={`Remove the ${labelFor(pendingDelete?.kind ?? '')} identity provider? Users will no longer be able to sign in with it.`}
        confirmLabel="Remove"
        errorMessage={(err) => (err instanceof Error ? err.message : String(err))}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
