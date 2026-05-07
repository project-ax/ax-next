/**
 * ModelConfigTab — searchable model pickers per role.
 *
 * Fetches listProviders() on mount. Shows only configured providers'
 * models in the pickers (grouped by provider in <optgroup>).
 *
 * MVP: starts with empty selections — no read endpoint exists for
 * previously-saved selections. The admin selects fresh and hits
 * "Save changes" to write settings via adminCredentials.create().
 *
 * Each role's selected model is written as a credential with:
 *   scope='global', ownerId=null, ref=role.ref, kind='setting',
 *   payload=selectedModel
 *
 * Empty selections are silently skipped on save.
 */
import { useEffect, useState } from 'react';
import { listProviders, type ProviderEntry } from '../../lib/providers';
import { adminCredentials } from '../../lib/credentials';

const ROLES = [
  {
    id: 'fast-model',
    label: 'Fast / cheap model',
    ref: 'setting.fast-model',
    description: 'Used for conversation titles, quick classification, low-latency tasks',
  },
  {
    id: 'runner-model',
    label: 'Agent runner model',
    ref: 'setting.runner-model',
    description: 'Used for all agent sessions via the Claude SDK runner',
  },
] as const;

export function ModelConfigTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    void listProviders().then((list) => setProviders(list));
  }, []);

  const configuredProviders = providers.filter((p) => p.configured);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      for (const role of ROLES) {
        const selectedModel = selectedModels[role.ref];
        if (!selectedModel) continue;
        await adminCredentials.create({
          scope: 'global',
          ownerId: null,
          ref: role.ref,
          kind: 'setting',
          payload: selectedModel,
        });
      }
      setSavedOk(true);
      // Reset "Saved" indicator after a brief moment.
      setTimeout(() => setSavedOk(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasAnySelection = ROLES.some((r) => selectedModels[r.ref]);

  return (
    <div className="model-config-tab">
      {ROLES.map((role) => (
        <div key={role.id} className="model-config-role">
          <label htmlFor={`model-select-${role.id}`} className="model-config-label">
            {role.label}
          </label>
          <p className="model-config-description">{role.description}</p>
          <select
            id={`model-select-${role.id}`}
            value={selectedModels[role.ref] ?? ''}
            onChange={(e) =>
              setSelectedModels((prev) => ({ ...prev, [role.ref]: e.target.value }))
            }
            aria-label={role.label}
          >
            <option value="">— Select a model —</option>
            {configuredProviders.map((provider) => (
              <optgroup key={provider.id} label={provider.name}>
                {provider.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      ))}

      <div className="model-config-footer">
        <button
          type="button"
          className="model-config-save"
          onClick={() => void handleSave()}
          disabled={saving || !hasAnySelection}
        >
          {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save changes'}
        </button>
        {saveError && (
          <div className="model-config-error" role="alert">
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
