/**
 * CredentialsList — table view of credentials, shared by admin + settings
 * panels.
 *
 * `variant` decides which wire client we talk to:
 *
 *   - 'admin' → `adminCredentials.*` → `/admin/credentials*` (full scope
 *     axis: global / user / agent visible to admins).
 *   - 'user'  → `myCredentials.*`    → `/settings/credentials*` (forced
 *     scope='user', ownerId=actor.id; the actor's own credentials only).
 *
 * The component is intentionally thin: load on mount, render a table,
 * delete with a `window.confirm` gate, refetch on success. Edit isn't
 * exposed (credentials are immutable — recreate to rotate).
 *
 * Server-supplied error strings render as plain text via React's default
 * escaping — no raw HTML injection. The wire never returns the secret
 * payload, so there's nothing to redact at the UI layer.
 */
import { useEffect, useState } from 'react';
import {
  adminCredentials,
  myCredentials,
  type CredentialMeta,
} from '../../lib/credentials';

export interface CredentialsListProps {
  variant: 'admin' | 'user';
  /**
   * Optional refresh signal — bump this number from the parent (e.g.
   * after CredentialAddMenu mutates) to force a re-fetch. The list also
   * fetches on mount.
   */
  refreshKey?: number;
}

export function CredentialsList({
  variant,
  refreshKey = 0,
}: CredentialsListProps): React.ReactElement {
  const [list, setList] = useState<CredentialMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = variant === 'admin' ? adminCredentials : myCredentials;

  async function reload(): Promise<void> {
    setError(null);
    try {
      const next = await client.list();
      setList(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void reload();
    // `client` is captured from `variant`; refreshing on `refreshKey`
    // change lets parents force a re-fetch.
  }, [variant, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onDelete(c: CredentialMeta): Promise<void> {
    const ok = window.confirm(
      `Delete credential "${c.ref}"? This can't be undone — anything pointing at this ref will start failing immediately.`,
    );
    if (!ok) return;
    try {
      if (variant === 'admin') {
        await adminCredentials.delete({
          scope: c.scope,
          ownerId: c.ownerId,
          ref: c.ref,
        });
      } else {
        await myCredentials.delete(c.ref);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (list === null && error === null) {
    return <div className="admin-empty">Loading…</div>;
  }
  if (error !== null) {
    return (
      <div className="admin-error" role="alert">
        Error: {error}
      </div>
    );
  }
  return (
    <table className="credentials-list admin-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th>Owner</th>
          <th>Ref</th>
          <th>Kind</th>
          <th>Created</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list!.length === 0 ? (
          <tr>
            <td colSpan={6} className="admin-empty">
              No credentials yet.
            </td>
          </tr>
        ) : (
          list!.map((c) => (
            <tr key={`${c.scope}:${c.ownerId ?? '_'}:${c.ref}`}>
              <td>{c.scope}</td>
              <td>{c.ownerId ?? '—'}</td>
              <td>{c.ref}</td>
              <td>{c.kind}</td>
              <td>
                {(() => {
                  const t = Date.parse(c.createdAt);
                  return Number.isFinite(t)
                    ? new Date(t).toLocaleString()
                    : c.createdAt;
                })()}
              </td>
              <td>
                <button
                  type="button"
                  className="admin-btn admin-btn-danger"
                  aria-label={`Delete ${c.ref}`}
                  onClick={() => void onDelete(c)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
