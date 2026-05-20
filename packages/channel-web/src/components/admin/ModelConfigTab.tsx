/**
 * ModelConfigTab — pick the fast-model used by conversation auto-titling.
 *
 * Storage shape: `provider/model-id` in the kernel `storage:*` surface at
 * key `settings:fast-model`. The wizard seeds the same key during
 * onboarding; @ax/conversation-titles reads it at every chat:turn-end and
 * falls back to its plugin config when absent. The wire layer lives in
 * `lib/admin-settings.ts` (GET/PUT `/admin/settings/fast-model`).
 *
 * The previous shape had a second "runner-model" role and POSTed to a
 * deleted `/admin/credentials` endpoint; both are gone here — runner
 * model is set per-agent via the Agents tab.
 */
import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { listProviders, type ProviderEntry } from '@/lib/providers';
import { getAdminSetting, putAdminSetting } from '@/lib/admin-settings';
import { Button } from '@/components/ui/button';
import { RoleCard } from './RoleCard';
import { ModelCombobox, type ModelComboboxGroup } from './ModelCombobox';

interface RoleMeta {
  id: 'fast-model';
  pill: string;
  label: string;
  description: string;
}

const ROLE: RoleMeta = {
  id: 'fast-model',
  pill: 'fast',
  label: 'Fast / cheap model',
  description:
    'Used for conversation titles, quick classification, low-latency tasks. ' +
    'Each agent picks its own primary chat model separately on the Agents tab.',
};

interface ProviderSelection {
  providerId: string;
  modelId: string;
}

/**
 * Build a `provider/model-id` ref from the configured-providers list +
 * a chosen model id. Returns null if the model doesn't belong to any
 * configured provider (shouldn't happen, but UI input is fundamentally
 * a free-form string).
 */
function buildModelRef(
  providers: ProviderEntry[],
  modelId: string,
): ProviderSelection | null {
  if (modelId.length === 0) return null;
  for (const p of providers) {
    if (p.models.includes(modelId)) {
      return { providerId: p.id, modelId };
    }
  }
  return null;
}

/**
 * Reverse: given a stored `provider/model-id` ref, extract the model id
 * so the combobox can preselect it. Splits on the FIRST `/` to mirror
 * conversation-titles' parseModelRef.
 */
function parseStoredRef(ref: string | null): string {
  if (ref === null || ref.length === 0) return '';
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) return '';
  return ref.slice(idx + 1);
}

export function ModelConfigTab() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Run in parallel — they share no state.
        const [list, current] = await Promise.all([
          listProviders(),
          getAdminSetting('fast-model').catch(() => null),
        ]);
        if (cancelled) return;
        setProviders(list);
        setSelectedModel(parseStoredRef(current));
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
    if (selectedModel.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    if (savedTimeoutRef.current !== null) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }
    try {
      const ref = buildModelRef(configured, selectedModel);
      if (ref === null) {
        // No configured provider claims this model id — refuse to save
        // garbage. Defensive; the combobox should never offer such a value.
        throw new Error(`No configured provider supplies "${selectedModel}".`);
      }
      await putAdminSetting('fast-model', `${ref.providerId}/${ref.modelId}`);
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
          Pick the fast model used for conversation titles and other
          low-latency tasks. Only providers with a configured key appear here.
        </p>
      </div>

      {noProviders && (
        <div className="flex items-start gap-2.5 p-3.5 bg-primary-soft border border-primary/20 rounded-lg text-[13px] leading-[1.5] text-foreground/80 mb-4">
          <Info
            className="w-4 h-4 rounded-full bg-primary text-primary-foreground p-px shrink-0 mt-px"
            strokeWidth={3}
          />
          <span>
            Configure a provider key first, then come back here to choose a model.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3.5">
        <RoleCard pill={ROLE.pill} title={ROLE.label} caption={ROLE.description}>
          <ModelCombobox
            ariaLabel={ROLE.label}
            groups={groups}
            value={selectedModel}
            onChange={setSelectedModel}
            disabled={noProviders}
            placeholder={
              noProviders ? '— Configure a provider first —' : '— Select a model —'
            }
          />
          {selectedModel.length > 0 && (
            <span className="flex items-center gap-1.5 mt-2 text-[11.5px] text-muted-foreground">
              Currently ·{' '}
              <code className="font-mono text-[11.5px] text-primary tracking-[0.02em]">
                {selectedModel}
              </code>
            </span>
          )}
        </RoleCard>
      </div>

      <div className="mt-6 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || selectedModel.length === 0}
        >
          {saving ? 'Saving…' : savedOk ? '✓ Saved' : 'Save changes'}
        </Button>
        {selectedModel.length === 0 && !saving && !savedOk && !saveError && (
          <span className="text-[12.5px] text-muted-foreground">
            Pick a model above to enable save.
          </span>
        )}
        {savedOk && (
          <span className="text-[12.5px] text-muted-foreground">
            Changes apply on the next chat turn.
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
