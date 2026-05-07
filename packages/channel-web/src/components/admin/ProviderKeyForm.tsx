/**
 * ProviderKeyForm — inline edit/add form for a provider API key.
 *
 * Renders inline inside a ProviderKeysTab row when the user clicks
 * "Edit" or "Add key". Delegates save/cancel to the parent.
 */
import { useState } from 'react';

export interface ProviderKeyFormProps {
  onSave: (key: string) => Promise<void>;
  onCancel: () => void;
  error?: string;
  saving?: boolean;
}

export function ProviderKeyForm({ onSave, onCancel, error, saving }: ProviderKeyFormProps) {
  const [key, setKey] = useState('');

  return (
    <div className="provider-key-form">
      <input
        type="password"
        className="provider-key-input"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Paste your API key"
        disabled={saving}
        aria-label="API key"
      />
      {error && (
        <div className="provider-key-error" role="alert">
          {error}
        </div>
      )}
      <div className="provider-key-actions">
        <button
          type="button"
          className="provider-key-save"
          onClick={() => void onSave(key)}
          disabled={saving || key.trim().length === 0}
        >
          {saving ? 'Validating…' : error ? 'Retry' : 'Save'}
        </button>
        <button
          type="button"
          className="provider-key-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
