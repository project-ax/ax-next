/**
 * ApiKeyForm — paste-flow form for credentials with `flow: 'paste'`.
 *
 * Two variants:
 *
 *   - 'admin' → POST /admin/credentials with the operator-chosen scope
 *     and ownerId (full axis: global / user / agent). Scope=global means
 *     ownerId is null; scope=user|agent requires an ownerId.
 *   - 'user'  → POST /settings/credentials. Scope/ownerId are forced to
 *     scope='user' + ownerId=actor.id by the server, so we omit them
 *     from the form entirely.
 *
 * The api-key bytes are base64-encoded by the wire client before they
 * leave this component — they never traverse fetch logs as plaintext.
 *
 * State is vanilla `useState` (no react-hook-form — not in deps and the
 * form is small enough that the deduplication isn't worth the dep).
 */
import { useState } from 'react';
import {
  adminCredentials,
  myCredentials,
} from '../../lib/credentials';

export interface ApiKeyFormProps {
  variant: 'admin' | 'user';
  /** Defaults to 'api-key'; override for paste-flow kinds we don't yet
   *  enumerate (the server's list-kinds tells the menu what's accepted). */
  kind?: string;
  onAdded: () => void;
  onCancel: () => void;
}

type Scope = 'global' | 'user' | 'agent';

export function ApiKeyForm({
  variant,
  kind = 'api-key',
  onAdded,
  onCancel,
}: ApiKeyFormProps) {
  const [scope, setScope] = useState<Scope>('global');
  const [ownerId, setOwnerId] = useState('');
  const [ref, setRef] = useState('');
  const [payload, setPayload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (ref.trim().length === 0) {
      setError('ref is required');
      return;
    }
    if (payload.length === 0) {
      setError('api key is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (variant === 'admin') {
        const ownerIdForCall = scope === 'global' ? null : ownerId.trim();
        if (ownerIdForCall !== null && ownerIdForCall.length === 0) {
          setError(`ownerId is required when scope='${scope}'`);
          setBusy(false);
          return;
        }
        await adminCredentials.create({
          scope,
          ownerId: ownerIdForCall,
          ref: ref.trim(),
          kind,
          payload,
        });
      } else {
        await myCredentials.create({
          ref: ref.trim(),
          kind,
          payload,
        });
      }
      // Clear secret material from component state immediately on
      // success — there's no reason for it to outlive the submit.
      setPayload('');
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
      onSubmit={(e) => void submit(e)}
    >
      {error !== null && (
        <div className="admin-error" role="alert">
          {error}
        </div>
      )}
      <div className="admin-form-grid">
        {variant === 'admin' && (
          <>
            <label htmlFor="cred-scope">Scope</label>
            <select
              id="cred-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="global">global</option>
              <option value="user">user</option>
              <option value="agent">agent</option>
            </select>

            {scope !== 'global' && (
              <>
                <label htmlFor="cred-owner">Owner ID</label>
                <input
                  id="cred-owner"
                  type="text"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder={
                    scope === 'user' ? 'e.g. alice' : 'e.g. agt-12345'
                  }
                />
              </>
            )}
          </>
        )}

        <label htmlFor="cred-ref">Ref</label>
        <input
          id="cred-ref"
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="e.g. anthropic"
          required
        />

        <label htmlFor="cred-payload">API key</label>
        <input
          id="cred-payload"
          type="password"
          autoComplete="off"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          required
        />
      </div>
      <div className="admin-form-buttons">
        <button
          type="button"
          className="admin-btn"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="admin-btn admin-btn-primary"
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
