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
import { useEffect, useRef, useState } from 'react';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  // Tracks the pending "Saved" indicator clear so unmount during the 2s
  // window doesn't trigger a setState-on-unmounted warning.
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProviders();
        if (cancelled) return;
        setProviders(list);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (savedTimeoutRef.current !== null) {
        clearTimeout(savedTimeoutRef.current);
        savedTimeoutRef.current = null;
      }
    };
  }, []);

  const configuredProviders = providers.filter((p) => p.configured);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    if (savedTimeoutRef.current !== null) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }
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
      // Reset "Saved" indicator after a brief moment; cleared on unmount.
      savedTimeoutRef.current = setTimeout(() => {
        setSavedOk(false);
        savedTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasAnySelection = ROLES.some((r) => selectedModels[r.ref]);

  if (loadError !== null) {
    return (
      <div className="model-config-load-error" role="alert">
        Couldn't load providers: {loadError}
      </div>
    );
  }

  const noProviders = configuredProviders.length === 0;

  return (
    <div className="model-config-tab">
      {noProviders && (
        <div className="model-config-hint">
          Configure a provider key first, then come back here to choose models.
        </div>
      )}
      <div className="model-config-list">
        {ROLES.map((role, idx) => {
          const selected = selectedModels[role.ref] ?? '';
          return (
            <div
              key={role.id}
              className="model-config-row"
              data-role={role.id}
              style={{ animationDelay: `${idx * 60}ms` }}
            >
              <div className="model-config-row-meta">
                <span className="model-config-eyebrow">Role · {role.id}</span>
                <label
                  htmlFor={`model-select-${role.id}`}
                  className="model-config-label"
                >
                  {role.label}
                </label>
                <p className="model-config-description">{role.description}</p>
              </div>
              <div className="model-config-row-control">
                <select
                  id={`model-select-${role.id}`}
                  value={selected}
                  onChange={(e) =>
                    setSelectedModels((prev) => ({
                      ...prev,
                      [role.ref]: e.target.value,
                    }))
                  }
                  aria-label={role.label}
                  disabled={noProviders}
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
                {selected && (
                  <span className="model-config-current">
                    Current selection · <code>{selected}</code>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="model-config-footer">
        <button
          type="button"
          className="model-config-save"
          onClick={() => void handleSave()}
          disabled={saving || !hasAnySelection}
        >
          {saving ? 'Saving…' : savedOk ? '✓ Saved' : 'Save changes'}
        </button>
        {!hasAnySelection && !saving && !savedOk && !saveError && (
          <span className="model-config-hint-inline">
            Pick a model above to enable save.
          </span>
        )}
        {saveError && (
          <div className="model-config-error" role="alert">
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
