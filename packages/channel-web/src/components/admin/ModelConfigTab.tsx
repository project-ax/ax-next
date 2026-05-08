/**
 * ModelConfigTab — searchable model pickers per role.
 *
 * Behavior contract preserved from the legacy implementation:
 *   - Fetch listProviders() on mount.
 *   - Show only configured providers.
 *   - On Save, write each non-empty selection as a credential
 *     (scope='global', ownerId=null, ref=role.ref, kind='setting',
 *     payload=selectedModel).
 *   - Empty selections are silently skipped.
 */
import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { listProviders, type ProviderEntry } from '@/lib/providers';
import { adminCredentials } from '@/lib/credentials';
import { Button } from '@/components/ui/button';
import { RoleCard } from './RoleCard';
import { ModelCombobox, type ModelComboboxGroup } from './ModelCombobox';

const ROLES = [
  {
    id: 'fast-model',
    pill: 'fast',
    label: 'Fast / cheap model',
    ref: 'setting.fast-model',
    description:
      'Used for conversation titles, quick classification, low-latency tasks.',
  },
  {
    id: 'runner-model',
    pill: 'runner',
    label: 'Agent runner model',
    ref: 'setting.runner-model',
    description: 'Used for all agent sessions via the Claude SDK runner.',
  },
] as const;

export function ModelConfigTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
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

  const configured = providers.filter((p) => p.configured);
  const noProviders = configured.length === 0;
  const groups: ModelComboboxGroup[] = configured.map((p) => ({
    providerName: p.name,
    models: p.models,
  }));

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
      <div
        role="alert"
        className="px-3 py-2 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive max-w-[640px] mx-auto"
      >
        Couldn't load providers: {loadError}
      </div>
    );
  }

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Model configuration
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Pick which model handles each role. Only providers with a configured key
          appear here.
        </p>
      </div>

      {noProviders && (
        <div className="flex items-start gap-2.5 p-3.5 bg-primary-soft border border-primary/20 rounded-lg text-[13px] leading-[1.5] text-foreground/80 mb-4">
          <Info
            className="w-4 h-4 rounded-full bg-primary text-primary-foreground p-px shrink-0 mt-px"
            strokeWidth={3}
          />
          <span>
            Configure a provider key first, then come back here to choose models.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3.5">
        {ROLES.map((role) => (
          <RoleCard
            key={role.id}
            pill={role.pill}
            title={role.label}
            caption={role.description}
          >
            <ModelCombobox
              ariaLabel={role.label}
              groups={groups}
              value={selectedModels[role.ref] ?? ''}
              onChange={(model) =>
                setSelectedModels((prev) => ({ ...prev, [role.ref]: model }))
              }
              disabled={noProviders}
              placeholder={
                noProviders ? '— Configure a provider first —' : '— Select a model —'
              }
            />
            {selectedModels[role.ref] && (
              <span className="flex items-center gap-1.5 mt-2 text-[11.5px] text-muted-foreground">
                Currently ·{' '}
                <code className="font-mono text-[11.5px] text-primary tracking-[0.02em]">
                  {selectedModels[role.ref]}
                </code>
              </span>
            )}
          </RoleCard>
        ))}
      </div>

      <div className="mt-6 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !hasAnySelection}
        >
          {saving ? 'Saving…' : savedOk ? '✓ Saved' : 'Save changes'}
        </Button>
        {!hasAnySelection && !saving && !savedOk && !saveError && (
          <span className="text-[12.5px] text-muted-foreground">
            Pick a model above to enable save.
          </span>
        )}
        {savedOk && (
          <span className="text-[12.5px] text-muted-foreground">
            Changes apply on the next session start.
          </span>
        )}
        {saveError && (
          <div
            role="alert"
            className="px-2.5 py-1.5 bg-destructive-soft border border-destructive/25 rounded-md text-[12.5px] text-destructive"
          >
            {saveError}
          </div>
        )}
      </div>
    </div>
  );
}
