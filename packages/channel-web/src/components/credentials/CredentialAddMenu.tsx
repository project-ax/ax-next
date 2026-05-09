/**
 * CredentialAddMenu — kind-picker that mounts the API-key form.
 *
 * Click the "+ Add credential" button → a dropdown opens with the
 * kinds catalog fetched from `/admin/credentials/kinds`. Each kind
 * with `flow === 'paste'` becomes a menu item; clicking it renders
 * `<ApiKeyForm kind={kind} ...>`.
 *
 * I12 (provider credentials are API-key-only) is enforced here as
 * defense-in-depth: kinds with `flow !== 'paste'` are filtered out
 * client-side even if a custom preset loads an OAuth credential
 * plugin and the server returns them.
 *
 * On successful add, the form calls `onAdded` and we collapse back to
 * the button state — the parent `CredentialsList` listens to `onAdded`
 * via its `refreshKey` to re-fetch.
 *
 * The kinds catalog is fetched lazily on first open to avoid the
 * round-trip for sessions that never click "+ Add credential".
 */
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  adminCredentials,
  myCredentials,
  type CredentialKind,
} from '../../lib/credentials';
import { ApiKeyForm } from './ApiKeyForm';

export interface CredentialAddMenuProps {
  variant: 'admin' | 'user';
  /** Called after a successful create — parent should re-fetch. */
  onAdded: () => void;
}

type Mode =
  | { kind: 'closed' }
  | { kind: 'menu' }
  | { kind: 'paste'; credentialKind: string };

export function CredentialAddMenu({
  variant,
  onAdded,
}: CredentialAddMenuProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const [kinds, setKinds] = useState<CredentialKind[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Lazy-load the catalog the first time the menu opens — most sessions
  // never click "+ Add credential", so we don't pay for the round-trip
  // up front.
  useEffect(() => {
    if (mode.kind !== 'menu') return;
    if (kinds !== null) return;
    const client = variant === 'admin' ? adminCredentials : myCredentials;
    client
      .listKinds()
      .then((k) => setKinds(k))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [mode, kinds, variant]);

  const close = (): void => {
    setMode({ kind: 'closed' });
    setError(null);
  };

  const handleAdded = (): void => {
    onAdded();
    close();
  };

  if (mode.kind === 'closed') {
    return (
      <div className="inline-flex">
        <Button
          onClick={() => setMode({ kind: 'menu' })}
        >
          <Plus className="h-3.5 w-3.5" /> Add credential
        </Button>
      </div>
    );
  }

  if (mode.kind === 'menu') {
    const pasteKinds = (kinds ?? []).filter((k) => k.flow === 'paste');
    return (
      <div className="flex flex-col gap-2">
        {error !== null && (
          <div
            role="alert"
            className="px-3 py-2 bg-destructive/10 border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {error}
          </div>
        )}
        <div className="relative inline-block">
          <Button onClick={close}>
            <Plus className="h-3.5 w-3.5" /> Add credential
          </Button>
          <div
            ref={menuRef}
            role="menu"
            className="absolute right-0 top-full mt-1 z-50 min-w-[10rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {kinds === null && error === null ? (
              <div
                role="menuitem"
                aria-disabled="true"
                className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
              >
                Loading…
              </div>
            ) : pasteKinds.length === 0 ? (
              <div
                role="menuitem"
                aria-disabled="true"
                className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
              >
                No API-key credential kinds available
              </div>
            ) : (
              pasteKinds.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  role="menuitem"
                  className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                  onClick={() =>
                    setMode({ kind: 'paste', credentialKind: k.kind })
                  }
                >
                  {k.kind}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  // mode.kind === 'paste'
  return (
    <ApiKeyForm
      variant={variant}
      kind={mode.credentialKind}
      onAdded={handleAdded}
      onCancel={close}
    />
  );
}
