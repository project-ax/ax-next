/**
 * ModelsTab — the admin picks which models people may use in their agents.
 *
 * Two panes: every model the providers offer (search, tick) and the ones that
 * will be available (one marked Default). Saving asks first only when agents
 * use a model being removed; those agents run on the Default from their next
 * chat (resolved at chat time on the server, never rewritten).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
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
  TAB_INTRO,
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
import { toastActions } from '@/lib/toast-store';
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
      toastActions.show({ title: SAVED_TITLE, detail: SAVED_DETAIL, kind: 'info' });
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

  if (load.kind === 'loading') {
    return (
      <div className="mx-auto max-w-[960px] font-sans" role="status">
        <span className="sr-only">Loading models…</span>
        <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (load.kind === 'error') {
    return (
      <div className="mx-auto max-w-[960px] font-sans">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{load.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { providers } = load;
  const current = draft ?? draftOf(load.policy);
  const defaultLabel = labelFor(current.default, providers);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 pb-4 font-sans">
      <p className="text-sm text-muted-foreground">{TAB_INTRO}</p>

      {load.policy.warning === 'saved-policy-unreadable' ? (
        <Alert>
          <AlertDescription>{UNREADABLE_NOTICE}</AlertDescription>
        </Alert>
      ) : (
        load.policy.source === 'builtin' && (
          <Alert>
            <AlertDescription>{BUILTIN_NOTICE}</AlertDescription>
          </Alert>
        )
      )}
      {load.catalogFailed && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{CATALOG_LOAD_FAILED}</span>
            <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={() => void retryCatalog()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <FieldSet disabled={checking || saving || confirm !== null} className="grid items-start gap-4 md:grid-cols-2">
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
        <SelectedModelsPane
          draft={current}
          providers={providers}
          onSetDefault={(ref) => setDraft((d) => setDefault(d ?? current, ref))}
          onRemove={(ref) => setDraft((d) => removeModel(d ?? current, ref))}
        />
      </FieldSet>

      {saveError !== null && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{saveError.message}</span>
            {saveError.stale && (
              <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
                Reload
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background px-1 py-3">
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
      </div>

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
