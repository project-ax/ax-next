/**
 * OAuthFlowForm — paste-flow for OAuth-style credentials.
 *
 * Two-step UX, mirroring the server's start/finish handlers:
 *
 *   1. Operator types a `ref`, picks `scope`/`ownerId` (admin variant),
 *      clicks "Open" → POST /…/credentials/oauth/start. We open the
 *      provider's authorize URL in a new tab (`noopener,noreferrer` —
 *      the new tab can't reach back into our window) and stash the
 *      pendingId in component state.
 *   2. Operator signs in at the provider, copies the code from the
 *      redirect page, pastes it into the "Code" field, clicks "Finish"
 *      → POST /…/credentials/oauth/finish with `{ pendingId, code }`.
 *
 * No automatic redirect-listener: this is the deliberately-low-tech web
 * paste flow that doesn't require a registered redirect URI for every
 * deployment topology.
 */
import { useState } from 'react';
import {
  adminCredentials,
  myCredentials,
} from '../../lib/credentials';

export interface OAuthFlowFormProps {
  variant: 'admin' | 'user';
  kind: string;
  onAdded: () => void;
  onCancel: () => void;
}

type Scope = 'global' | 'user' | 'agent';

interface PendingState {
  pendingId: string;
  authorizeUrl: string;
  instructions: string;
}

export function OAuthFlowForm({
  variant,
  kind,
  onAdded,
  onCancel,
}: OAuthFlowFormProps) {
  const [scope, setScope] = useState<Scope>('global');
  const [ownerId, setOwnerId] = useState('');
  const [ref, setRef] = useState('');
  const [pending, setPending] = useState<PendingState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    if (busy) return;
    if (ref.trim().length === 0) {
      setError('ref is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out =
        variant === 'admin'
          ? await adminCredentials.oauthStart({
              scope,
              ownerId:
                scope === 'global'
                  ? null
                  : ownerId.trim().length > 0
                    ? ownerId.trim()
                    : null,
              ref: ref.trim(),
              kind,
            })
          : await myCredentials.oauthStart({
              ref: ref.trim(),
              kind,
            });
      setPending(out);
      // `noopener,noreferrer` denies the new tab access to our window
      // (no `window.opener`, no Referer header to the provider). Same
      // posture as any external link in a security-sensitive UI.
      window.open(out.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (pending === null) return;
    if (code.trim().length === 0) {
      setError('code is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = { pendingId: pending.pendingId, code: code.trim() };
      if (variant === 'admin') {
        await adminCredentials.oauthFinish(input);
      } else {
        await myCredentials.oauthFinish(input);
      }
      setCode('');
      setPending(null);
      setRef('');
      setOwnerId('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="admin-form credentials-form"
      onSubmit={(e) => void finish(e)}
    >
      {error !== null && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      <div className="admin-form-grid">
        {variant === 'admin' && (
          <>
            <label htmlFor="oauth-scope">Scope</label>
            <select
              id="oauth-scope"
              value={scope}
              disabled={pending !== null}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="global">global</option>
              <option value="user">user</option>
              <option value="agent">agent</option>
            </select>

            {scope !== 'global' && (
              <>
                <label htmlFor="oauth-owner">Owner ID</label>
                <input
                  id="oauth-owner"
                  type="text"
                  value={ownerId}
                  disabled={pending !== null}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder={
                    scope === 'user' ? 'e.g. alice' : 'e.g. agt-12345'
                  }
                />
              </>
            )}
          </>
        )}

        <label htmlFor="oauth-ref">Ref</label>
        <input
          id="oauth-ref"
          type="text"
          value={ref}
          disabled={pending !== null}
          onChange={(e) => setRef(e.target.value)}
          placeholder="e.g. anthropic"
          required
        />

        {pending !== null && (
          <>
            <label htmlFor="oauth-code">Code</label>
            <input
              id="oauth-code"
              type="text"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste the code from the provider page"
              required
            />
          </>
        )}
      </div>

      {pending !== null && (
        <p className="admin-form-hint">{pending.instructions}</p>
      )}

      <div className="admin-form-buttons">
        <button
          type="button"
          className="admin-btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        {pending === null ? (
          <button
            type="button"
            className="admin-btn admin-btn-primary"
            onClick={() => void start()}
            disabled={busy}
          >
            {busy ? 'Opening…' : 'Open'}
          </button>
        ) : (
          <button
            type="submit"
            className="admin-btn admin-btn-primary"
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Finish'}
          </button>
        )}
      </div>
    </form>
  );
}
