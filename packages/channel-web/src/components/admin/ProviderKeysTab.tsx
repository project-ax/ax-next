/**
 * ProviderKeysTab — provider list with validation states.
 *
 * Fetches GET /admin/credentials/providers on mount. Each provider row
 * shows:
 *
 *   - idle-configured:   green "Configured" badge, masked key placeholder,
 *                        "Edit" button.
 *   - idle-unconfigured: "Not configured" label, blue "Add key" button.
 *   - editing:           ProviderKeyForm expanded inline, blue border.
 *   - validating:        Spinner on Save (delegated to ProviderKeyForm via
 *                        saving={true}).
 *   - error:             Red border, ProviderKeyForm with error= prop.
 *
 * Only one row is open at a time — opening a row collapses any other.
 */
import { useEffect, useRef, useState } from 'react';
import { listProviders, validateProviderKey, type ProviderEntry } from '../../lib/providers';
import { ProviderKeyForm } from './ProviderKeyForm';

export function ProviderKeysTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const editingIdRef = useRef<string | null>(null);

  const fetchProviders = async () => {
    try {
      const list = await listProviders();
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

  const handleEdit = (providerId: string) => {
    // Clear error for any previously-open row when switching rows.
    setRowError({});
    setEditingId(providerId);
    editingIdRef.current = providerId;
  };

  const handleCancel = (providerId: string) => {
    setEditingId(null);
    editingIdRef.current = null;
    setRowError((prev) => ({ ...prev, [providerId]: '' }));
  };

  const handleSave = async (provider: ProviderEntry, key: string) => {
    setValidating(true);
    try {
      await validateProviderKey(provider.id, key);
      // Guard: bail if user navigated away from this row while we were validating.
      if (editingIdRef.current !== provider.id) {
        setValidating(false);
        return;
      }
      // Refetch so the row switches to "configured" state.
      const list = await listProviders();
      setProviders(list);
      setEditingId(null);
      editingIdRef.current = null;
      setRowError((prev) => ({ ...prev, [provider.id]: '' }));
    } catch (err) {
      setValidating(false);
      // Guard: bail if user navigated away from this row while we were validating.
      if (editingIdRef.current !== provider.id) {
        return;
      }
      setRowError((prev) => ({
        ...prev,
        [provider.id]: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  if (loading) {
    return <div className="provider-keys-loading">Loading providers…</div>;
  }

  if (loadError !== null) {
    return (
      <div className="provider-keys-error" role="alert">
        Couldn't load providers: {loadError}
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="provider-keys-empty">
        No providers registered. Wire one in via{' '}
        <code>credentials:list-providers</code>.
      </div>
    );
  }

  return (
    <div className="provider-keys-tab">
      {providers.map((provider) => {
        const isEditing = editingId === provider.id;
        const error = rowError[provider.id];
        const rowClass = [
          'provider-row',
          isEditing ? 'editing' : '',
          error ? 'error' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={provider.id} className={rowClass} data-provider-id={provider.id}>
            <div className="provider-row-header">
              <div className="provider-row-identity">
                <span className="provider-name">{provider.name}</span>
                <span className="provider-row-meta">
                  {provider.configured ? (
                    <>
                      <span
                        className="provider-status provider-status-configured"
                        aria-hidden="true"
                      />
                      <span className="provider-status-label">Configured</span>
                      <span className="provider-status-sep" aria-hidden="true">
                        ·
                      </span>
                      <span className="provider-key-masked">key ••••••••</span>
                    </>
                  ) : (
                    <>
                      <span
                        className="provider-status provider-status-empty"
                        aria-hidden="true"
                      />
                      <span className="provider-status-label">Not configured</span>
                    </>
                  )}
                </span>
              </div>
              {!isEditing && (
                <button
                  type="button"
                  className={provider.configured ? 'provider-btn-edit' : 'provider-btn-add'}
                  onClick={() => handleEdit(provider.id)}
                >
                  {provider.configured ? 'Edit key' : 'Add key →'}
                </button>
              )}
            </div>
            {isEditing && (
              <ProviderKeyForm
                key={provider.id}
                onSave={(key) => handleSave(provider, key)}
                onCancel={() => handleCancel(provider.id)}
                {...(error ? { error } : {})}
                saving={validating}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
