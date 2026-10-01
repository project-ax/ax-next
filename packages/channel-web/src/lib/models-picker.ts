/**
 * Pure logic behind the Models tab: search, selection, the Default, and what
 * changed. No React, no fetch, so every rule is unit-tested on its own.
 */
import type { CatalogProvider } from './models-admin';

export interface Draft {
  allowed: string[];
  default: string;
}

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Every word must appear in the label, the ref, or the provider name. Empty query keeps everything. */
export function filterProviders(providers: readonly CatalogProvider[], query: string): CatalogProvider[] {
  const words = terms(query);
  if (words.length === 0) return providers.map((p) => p);
  const out: CatalogProvider[] = [];
  for (const p of providers) {
    const models = p.models.filter((m) => {
      const hay = `${m.label} ${m.ref} ${p.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (models.length > 0) out.push({ ...p, models });
  }
  return out;
}

export function countModels(providers: readonly CatalogProvider[]): number {
  return providers.reduce((n, p) => n + p.models.length, 0);
}

export function toggleModel(draft: Draft, ref: string): Draft {
  return draft.allowed.includes(ref) ? removeModel(draft, ref) : addModels(draft, [ref]);
}

export function removeModel(draft: Draft, ref: string): Draft {
  if (!draft.allowed.includes(ref)) return draft;
  const allowed = draft.allowed.filter((r) => r !== ref);
  const def = draft.default === ref ? (allowed[0] ?? '') : draft.default;
  return { allowed, default: def };
}

export function addModels(draft: Draft, refs: readonly string[]): Draft {
  const allowed = [...draft.allowed];
  for (const ref of refs) if (!allowed.includes(ref)) allowed.push(ref);
  if (allowed.length === draft.allowed.length) return draft;
  return { allowed, default: draft.default !== '' && draft.allowed.includes(draft.default) ? draft.default : (allowed[0] ?? '') };
}

export function setDefault(draft: Draft, ref: string): Draft {
  return draft.allowed.includes(ref) ? { allowed: draft.allowed, default: ref } : draft;
}

export function isDirty(saved: Draft, draft: Draft): boolean {
  if (saved.default !== draft.default) return true;
  if (saved.allowed.length !== draft.allowed.length) return true;
  const have = new Set(saved.allowed);
  return draft.allowed.some((r) => !have.has(r));
}

/** Models in the saved list that the draft no longer has. */
export function removedModels(saved: Draft, draft: Draft): string[] {
  const keep = new Set(draft.allowed);
  return saved.allowed.filter((r) => !keep.has(r));
}

function find(ref: string, providers: readonly CatalogProvider[]) {
  for (const p of providers) {
    const m = p.models.find((x) => x.ref === ref);
    if (m !== undefined) return { provider: p, model: m };
  }
  return null;
}

export function labelFor(ref: string, providers: readonly CatalogProvider[]): string {
  return find(ref, providers)?.model.label ?? ref;
}

export interface SelectedInfo {
  label: string;
  providerName: string;
  noLongerListed: boolean;
  needsKey: boolean;
}

export function selectedInfo(ref: string, providers: readonly CatalogProvider[]): SelectedInfo {
  const hit = find(ref, providers);
  if (hit !== null) {
    return { label: hit.model.label, providerName: hit.provider.name, noLongerListed: false, needsKey: hit.provider.status === 'no-key' };
  }
  const providerId = ref.split('/')[0] ?? ref;
  const provider = providers.find((p) => p.id === providerId);
  return {
    label: ref,
    providerName: provider?.name ?? providerId,
    // Only claim "no longer listed" when the provider's list is the real one
    // (live or recently cached); a fallback or failed list proves nothing.
    noLongerListed: provider !== undefined && (provider.status === 'live' || provider.status === 'cached'),
    needsKey: provider?.status === 'no-key',
  };
}
