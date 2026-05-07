/**
 * CredentialAddMenu — kind-picker that mounts the right form.
 *
 * Click the "+ Add credential" button → fetches the kinds catalog from
 * `/admin/credentials/kinds` (shared between admin + settings panels;
 * see `lib/credentials.ts` and `@ax/credentials-admin-routes`). Each
 * supported kind becomes a button:
 *
 *   - flow='paste'  → click renders `<ApiKeyForm kind={kind} ...>`
 *   - flow='oauth'  → click renders `<OAuthFlowForm kind={kind} ...>`
 *
 * On successful add, the form calls `onAdded` and we collapse back to
 * the menu state — the parent `CredentialsList` listens to `onAdded`
 * via its `refreshKey` to re-fetch.
 */
import { useEffect, useState } from 'react';
import {
  adminCredentials,
  myCredentials,
  type CredentialKind,
} from '../../lib/credentials';
import { ApiKeyForm } from './ApiKeyForm';
import { OAuthFlowForm } from './OAuthFlowForm';

export interface CredentialAddMenuProps {
  variant: 'admin' | 'user';
  /** Called after a successful create — parent should re-fetch. */
  onAdded: () => void;
}

type Mode =
  | { kind: 'closed' }
  | { kind: 'menu' }
  | { kind: 'paste'; credentialKind: string }
  | { kind: 'oauth'; credentialKind: string };

export function CredentialAddMenu({
  variant,
  onAdded,
}: CredentialAddMenuProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const [kinds, setKinds] = useState<CredentialKind[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <div className="credentials-add-menu-wrap">
        <button
          type="button"
          className="admin-btn admin-btn-primary"
          onClick={() => setMode({ kind: 'menu' })}
        >
          + Add credential
        </button>
      </div>
    );
  }

  if (mode.kind === 'menu') {
    return (
      <div className="credentials-add-menu" role="menu">
        <div className="credentials-add-menu-header">
          <span>Choose credential type</span>
          <button
            type="button"
            className="admin-btn"
            onClick={close}
            aria-label="Close"
          >
            Cancel
          </button>
        </div>
        {error !== null && (
          <div className="admin-error" role="alert">
            {error}
          </div>
        )}
        {kinds === null && error === null ? (
          <div className="admin-empty">Loading…</div>
        ) : (
          <ul className="credentials-add-menu-list">
            {(kinds ?? []).map((k) => (
              <li key={k.kind}>
                <button
                  type="button"
                  className="admin-btn"
                  onClick={() =>
                    setMode(
                      k.flow === 'oauth'
                        ? { kind: 'oauth', credentialKind: k.kind }
                        : { kind: 'paste', credentialKind: k.kind },
                    )
                  }
                >
                  {k.kind}
                </button>
                <span className="credentials-add-menu-flow">{k.flow}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (mode.kind === 'paste') {
    return (
      <ApiKeyForm
        variant={variant}
        kind={mode.credentialKind}
        onAdded={handleAdded}
        onCancel={close}
      />
    );
  }

  // mode.kind === 'oauth'
  return (
    <OAuthFlowForm
      variant={variant}
      kind={mode.credentialKind}
      onAdded={handleAdded}
      onCancel={close}
    />
  );
}
