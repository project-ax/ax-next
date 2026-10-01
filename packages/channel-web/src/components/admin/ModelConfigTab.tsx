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
import { fetchCatalog, fetchPolicy, type CatalogProvider } from '@/lib/models-admin';
import { labelFor } from '@/lib/models-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
  label: 'Helper model',
  description:
    'Used for conversation titles, quick classification, low-latency tasks. ' +
    'Each agent picks its own primary chat model separately on the Agents tab.',
};

export function ModelConfigTab() {
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [enabledModels, setEnabledModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // (D7) Bumping this re-runs the load effect — what the Retry button needs.
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // Policy and setting failures must not become an empty picker.
        // Catalog labels are optional: the enabled refs remain usable when
        // discovery fails, just as they do in the Models tab's selected list.
        const [policy, current, catalog] = await Promise.all([
          fetchPolicy(),
          getAdminSetting('fast-model'),
          fetchCatalog().catch((err: unknown) => {
            console.warn('[model-config] could not load model labels', err);
            return []; // The saved enabled refs remain the authority.
          }),
        ]);
        if (cancelled) return;
        setProviders(catalog);
        setEnabledModels(policy.allowed);
        setSelectedModel(current ?? '');
        setLoadError(false);
      } catch (err) {
        if (cancelled) return;
        // The dev detail stays in the console. An admin gets a sentence and
        // a way to try again — which this pane had no way to do at all.
        console.warn('[model-config] could not load providers', err);
        setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (savedTimeoutRef.current !== null) {
        clearTimeout(savedTimeoutRef.current);
        savedTimeoutRef.current = null;
      }
    };
  }, [reloadTick]);

  const byProvider = new Map<string, string[]>();
  for (const ref of enabledModels) {
    const id = ref.split('/')[0]!;
    const refs = byProvider.get(id) ?? [];
    refs.push(ref);
    byProvider.set(id, refs);
  }
  const groups: ModelComboboxGroup[] = [...byProvider].map(([id, refs]) => ({
    providerName: providers.find((p) => p.id === id)?.name ?? id,
    models: refs,
    labels: new Map(refs.map((ref) => [ref, labelFor(ref, providers)])),
  }));
  const noModels = enabledModels.length === 0;
  const selectedEnabled = enabledModels.includes(selectedModel);
  const selectedLabel = labelFor(selectedModel, providers);

  const handleSave = async () => {
    if (!selectedEnabled) return;
    setSaving(true);
    setSaveError(false);
    setSavedOk(false);
    if (savedTimeoutRef.current !== null) {
      clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }
    try {
      await putAdminSetting('fast-model', selectedModel);
      setSavedOk(true);
      savedTimeoutRef.current = setTimeout(() => {
        setSavedOk(false);
        savedTimeoutRef.current = null;
      }, 2000);
    } catch (err) {
      console.warn('[model-config] could not save the helper model', err);
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p role="status" className="text-sm text-muted-foreground">Loading enabled models…</p>;
  }

  if (loadError) {
    // (D7) This used to be a dead end: the raw error message interpolated into
    // the banner, and no way to try again short of reloading the page.
    // AuthProvidersTab has had an error+retry pair for a while; this matches it.
    return (
      <Alert variant="destructive" className="mx-auto max-w-[640px]">
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>We couldn’t load your enabled models.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="max-w-[640px] mx-auto font-sans">
      <div className="mb-5">
        {/* (TASK-341 / audit D3) This tab was called "Default AI model", in the
            nav and here. It is not: it picks the small, fast model used for
            conversation titles and other quick jobs, while each agent's CHAT
            model is chosen on the Agents tab. An admin reading the old name had
            every reason to think they were setting what their agents think
            with — actively misleading, not merely vague. */}
        <h2 className="text-2xl font-medium tracking-[-0.018em] mb-1.5">
          Helper model
        </h2>
        <p className="text-sm leading-[1.55] text-muted-foreground max-w-[56ch]">
          Used for conversation titles and quick tasks. Each agent picks its own
          chat model on the Agents tab. Choose from the models enabled in
          Settings → Models.
        </p>
      </div>

      {noModels && (
        <Alert className="mb-4">
          <AlertDescription>Enable a model in Settings → Models, then choose it here.</AlertDescription>
        </Alert>
      )}
      {selectedModel.length > 0 && !selectedEnabled && (
        <Alert className="mb-4">
          <AlertDescription>
            The saved helper model isn’t enabled in Settings → Models. Choose an enabled model to change it.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3.5">
        <RoleCard pill={ROLE.pill} title={ROLE.label} caption={ROLE.description}>
          <ModelCombobox
            ariaLabel={ROLE.label}
            groups={groups}
            value={selectedModel}
            valueLabel={selectedLabel}
            onChange={setSelectedModel}
            disabled={noModels || saving}
            placeholder={
              noModels ? '— Enable a model first —' : '— Select a model —'
            }
          />
          {selectedModel.length > 0 && (
            <span className="flex items-center gap-1.5 mt-2 text-[11.5px] text-muted-foreground">
              Currently ·{' '}
              <code className="font-mono text-[11.5px] text-primary tracking-[0.02em]">
                {selectedLabel}
              </code>
            </span>
          )}
        </RoleCard>
      </div>

      <div className="mt-6 pt-4 border-t border-rule-soft flex items-center gap-3">
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !selectedEnabled}
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
          // (D7) Was the raw thrown message — including the internal
          // "unavailable or ambiguous across configured providers" string,
          // which describes our resolver rather than anything the reader did.
          <Alert variant="destructive">
            <AlertDescription>We couldn’t save that. Give it another try in a moment.</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
