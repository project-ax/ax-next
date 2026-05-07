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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const editingIdRef = useRef<string | null>(null);

  const fetchProviders = async () => {
    try {
      const list = await listProviders();
      setProviders(list);
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
              <span className="provider-name">{provider.name}</span>
              {provider.configured ? (
                <>
                  <span className="provider-badge provider-badge-configured">Configured</span>
                  <span className="provider-key-masked">••••{provider.ref.slice(-4)}</span>
                </>
              ) : (
                <span className="provider-unconfigured">Not configured</span>
              )}
              {!isEditing && (
                <button
                  type="button"
                  className={provider.configured ? 'provider-btn-edit' : 'provider-btn-add'}
                  onClick={() => handleEdit(provider.id)}
                >
                  {provider.configured ? 'Edit' : 'Add key'}
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
