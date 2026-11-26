/**
 * ModelsTab — the admin picks which models people may use in their agents.
 *
 * Two panes: every model the providers offer (search, tick) and the ones that
 * will be available (one marked Default). Saving asks first only when agents
 * use a model being removed; those agents run on the Default from their next
 * chat (resolved at chat time on the server, never rewritten).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { SettingsActions } from '../settings/SettingsLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AsyncState, Notice } from '@project-ax/ui';
import {
  fetchCatalog,
  fetchImpact,
  fetchPolicy,
  savePolicy,
  type CatalogProvider,
  type ModelPolicy,
} from '@/lib/models-admin';
import {
  BUILTIN_NOTICE,
  CATALOG_LOAD_FAILED,
  POLICY_LOAD_FAILED,
  SAVED_DETAIL,
  SAVED_TITLE,
  UNREADABLE_NOTICE,
  saveFailure,
} from '@/lib/models-copy';
import {
  addModels,
  filterProviders,
  isDirty,
  labelFor,
  removeModel,
  removedModels,
  setDefault,
  toggleModel,
  type Draft,
} from '@/lib/models-picker';
import { toast } from '@project-ax/ui';
import { ModelCatalogPane } from './ModelCatalogPane';
import { SaveImpactDialog, type ImpactLine } from './SaveImpactDialog';
import { SelectedModelsPane } from './SelectedModelsPane';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; policy: ModelPolicy; providers: CatalogProvider[]; catalogFailed: boolean };

const draftOf = (p: ModelPolicy): Draft => ({ allowed: [...p.allowed], default: p.default });

export function ModelsTab({ onOpenKeys }: { onOpenKeys?: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [category, setCategory] = useState('enabled');
  const [query, setQuery] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; stale: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ lines: ImpactLine[] | null } | null>(null);
  const readSeq = useRef(0);

  const loadAll = useCallback(async () => {
    const mine = ++readSeq.current;
    setLoad({ kind: 'loading' });
    const [pol, cat] = await Promise.allSettled([fetchPolicy(), fetchCatalog()]);
    if (mine !== readSeq.current) return; // a newer read (or an unmount) owns the screen
    if (pol.status === 'rejected') {
      console.warn('models: could not load the saved policy', pol.reason);
      setLoad({ kind: 'error', message: POLICY_LOAD_FAILED });
      return;
    }
    if (cat.status === 'rejected') console.warn('models: could not load the catalog', cat.reason);
    setLoad({
      kind: 'ready',
      policy: pol.value,
      providers: cat.status === 'fulfilled' ? cat.value : [],
      catalogFailed: cat.status === 'rejected',
    });
    setDraft(draftOf(pol.value));
    setSaveError(null);
  }, []);

  useEffect(() => {
    void loadAll();
    return () => {
      readSeq.current += 1; // ignore anything still in flight after unmount
    };
  }, [loadAll]);

  const policy = load.kind === 'ready' ? load.policy : null;
  const dirty = policy !== null && draft !== null && isDirty(draftOf(policy), draft);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function retryCatalog() {
    setRetrying(true);
    try {
      const providers = await fetchCatalog({ refresh: true });
      setLoad((prev) => (prev.kind === 'ready' ? { ...prev, providers, catalogFailed: false } : prev));
    } catch (err) {
      console.warn('models: catalog refresh failed', err);
    } finally {
      setRetrying(false);
    }
  }

  async function commit() {
    if (policy === null || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await savePolicy({ baseVersion: policy.version, allowed: draft.allowed, default: draft.default });
      setLoad((prev) => (prev.kind === 'ready' ? { ...prev, policy: saved } : prev));
      setDraft(draftOf(saved));
      setConfirm(null);
      toast.show({ title: SAVED_TITLE, description: SAVED_DETAIL });
    } catch (err) {
      console.warn('models: save failed', err);
      setConfirm(null);
      setSaveError(saveFailure(err));
    } finally {
      setSaving(false);
    }
  }

  async function onSave() {
    if (policy === null || draft === null) return;
    const removed = removedModels(draftOf(policy), draft);
    if (removed.length === 0) {
      await commit();
      return;
    }
    setChecking(true);
    try {
      const rows = await fetchImpact(removed);
      if (rows.length === 0) {
        setChecking(false);
        await commit();
        return;
      }
      const providers = load.kind === 'ready' ? load.providers : [];
      setConfirm({ lines: rows.map((r) => ({ label: labelFor(r.model, providers), agentCount: r.agentCount })) });
    } catch (err) {
      console.warn('models: could not count the agents on removed models', err);
      setConfirm({ lines: null });
    } finally {
      setChecking(false);
    }
  }

  if (load.kind === 'loading' || load.kind === 'error') {
    return (
      <div className="mx-auto max-w-[960px] font-sans">
        <AsyncState
          status={load.kind}
          skeleton="block"
          loadingLabel="Loading models…"
          error={{ message: load.kind === 'error' ? load.message : '', onRetry: () => void loadAll() }}
        />
      </div>
    );
  }

  const { providers } = load;
  const current = draft ?? draftOf(load.policy);
  const defaultLabel = labelFor(current.default, providers);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 pb-4 font-sans">
      <SettingsActions><Button type="button" onClick={() => setCategory('catalog')}>Add models</Button></SettingsActions>

      {load.policy.warning === 'saved-policy-unreadable' ? (
        <Notice tone="info">{UNREADABLE_NOTICE}</Notice>
      ) : (
        load.policy.source === 'builtin' && (
          <Notice tone="info">{BUILTIN_NOTICE}</Notice>
        )
      )}
      {load.catalogFailed && (
        <Notice tone="info" action={{ label: 'Try again', busy: retrying, onClick: () => void retryCatalog() }}>
          {CATALOG_LOAD_FAILED}
        </Notice>
      )}

      <Tabs value={category} onValueChange={setCategory} className="settings-tabs">
        <TabsList aria-label="Model categories"><TabsTrigger value="enabled">Enabled</TabsTrigger><TabsTrigger value="catalog">Catalog</TabsTrigger></TabsList>
      <FieldSet disabled={checking || saving || confirm !== null}>
        <TabsContent value="catalog" forceMount hidden={category !== 'catalog'}>
        <ModelCatalogPane
          providers={providers}
          shown={filterProviders(providers, query)}
          selected={new Set(current.allowed)}
          query={query}
          onQueryChange={setQuery}
          onToggle={(ref) => setDraft((d) => toggleModel(d ?? current, ref))}
          onSelectAllShown={(refs) => setDraft((d) => addModels(d ?? current, refs))}
          onRetry={() => void retryCatalog()}
          retrying={retrying}
          {...(onOpenKeys !== undefined ? { onOpenKeys } : {})}
          nowMs={Date.now()}
        />
        </TabsContent>
        <TabsContent value="enabled" forceMount hidden={category !== 'enabled'}>
        <SelectedModelsPane
          draft={current}
          providers={providers}
          onSetDefault={(ref) => setDraft((d) => setDefault(d ?? current, ref))}
          onRemove={(ref) => setDraft((d) => removeModel(d ?? current, ref))}
        />
        </TabsContent>
      </FieldSet>
      </Tabs>

      {saveError !== null && (
        <Notice
          tone="danger"
          {...(saveError.stale ? { action: { label: 'Reload and discard my changes', onClick: () => void loadAll() } } : {})}
        >
          {saveError.message}
        </Notice>
      )}

      {dirty && <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background px-1 py-3">
        {dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
        <Button type="button" variant="outline" disabled={!dirty || saving || checking || confirm !== null} onClick={() => setDraft(draftOf(load.policy))}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!dirty || saving || checking || current.allowed.length === 0}
          onClick={() => void onSave()}
        >
          {saving || checking ? 'Saving…' : 'Save changes'}
        </Button>
      </div>}

      <SaveImpactDialog
        open={confirm !== null}
        lines={confirm?.lines ?? null}
        defaultLabel={defaultLabel}
        saving={saving}
        onConfirm={() => void commit()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
