import { replaceSurfaceRewriters } from '@ax/core/surface-text';
import { PROVIDER_ENDPOINTS, isModelRef, parseModelRef, type AgentContext, type HookBus } from '@ax/core';
import { MAX_REF_CHARS } from './shared.js';

export type ProviderStatus = 'live' | 'cached' | 'fallback' | 'no-key' | 'error';

export interface CatalogModel {
  ref: string;
  label: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  status: ProviderStatus;
  fetchedAt?: string;
  models: CatalogModel[];
}

export interface CatalogResult {
  providers: CatalogProvider[];
}

export interface Catalog {
  get(ctx: AgentContext, opts: { refresh: boolean }): Promise<CatalogResult>;
}

export interface CatalogDeps {
  bus: HookBus;
  /** Defaults to every provider in `PROVIDER_ENDPOINTS`. */
  providers?: ReadonlyArray<{ id: string; name: string }>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  minRefreshMs?: number;
}

const LABEL_MAX = 120;
const MODELS_PER_PROVIDER_MAX = 2000;
// Control characters, soft hyphen, zero-width, bidirectional overrides/isolates, BOM.
// A ref is a routing key, so it gets a strict allow-list rather than a block-list.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

export function sanitizeLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = replaceSurfaceRewriters(raw).replace(/\p{Cf}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Accepts `{ ref, label }` (list-available) and `{ id, label }` (list-supported). Drops anything unsafe. */
export function normalizeModels(provider: string, raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const item of raw) {
    if (out.length >= MODELS_PER_PROVIDER_MAX) break;
    if (typeof item !== 'object' || item === null) continue;
    const { ref, id, label } = item as { ref?: unknown; id?: unknown; label?: unknown };
    const candidate = typeof ref === 'string' ? ref : typeof id === 'string' ? id : undefined;
    if (candidate === undefined || candidate.length > MAX_REF_CHARS) continue;
    if (!SAFE_REF.test(candidate) || !isModelRef(candidate)) continue;
    if (parseModelRef(candidate).provider !== provider || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push({ ref: candidate, label: sanitizeLabel(label, candidate) });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface ProviderState {
  good?: { models: CatalogModel[]; at: number };
  lastForcedAt?: number;
  pending?: Promise<CatalogProvider>;
  lastResult?: { provider: CatalogProvider; at: number };
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const providers =
    deps.providers ?? Object.values(PROVIDER_ENDPOINTS).map((p) => ({ id: p.id, name: p.name }));
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 600_000;
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const minRefreshMs = deps.minRefreshMs ?? 15_000;
  const states = new Map<string, ProviderState>();

  async function fallbackFor(
    ctx: AgentContext,
    p: { id: string; name: string },
    st: ProviderState,
  ): Promise<CatalogProvider> {
    if (st.good !== undefined) {
      return {
        id: p.id,
        name: p.name,
        status: 'cached',
        fetchedAt: new Date(st.good.at).toISOString(),
        models: st.good.models,
      };
    }
    const hook = `models:list-supported:${p.id}`;
    if (deps.bus.hasService(hook)) {
      try {
        const out = await withTimeout(deps.bus.call<Record<string, never>, { models?: unknown }>(hook, ctx, {}), timeoutMs);
        const models = normalizeModels(p.id, out.models);
        if (models.length > 0) return { id: p.id, name: p.name, status: 'fallback', models };
      } catch (err) {
        ctx.logger.warn('model_catalog_fallback_failed', {
          provider: p.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { id: p.id, name: p.name, status: 'error', models: [] };
  }

  async function loadOne(
    ctx: AgentContext,
    p: { id: string; name: string },
    refresh: boolean,
  ): Promise<CatalogProvider> {
    // Provider keys may be personal, so cache identity follows credential resolution.
    const identity = JSON.stringify([ctx.userId, p.id]);
    const st = states.get(identity) ?? {};
    states.set(identity, st);
    if (st.pending !== undefined) return st.pending;
    const t = now();
    let force = false;
    if (refresh && (st.lastForcedAt === undefined || t - st.lastForcedAt >= minRefreshMs)) {
      force = true;
      st.lastForcedAt = t;
    }
    if (!force && st.lastResult !== undefined && t - st.lastResult.at < minRefreshMs) {
      return structuredClone(st.lastResult.provider);
    }
    if (!force && st.good !== undefined && t - st.good.at < ttlMs) {
      return {
        id: p.id,
        name: p.name,
        status: st.lastResult?.provider.status === 'cached' ? 'cached' : 'live',
        fetchedAt: new Date(st.good.at).toISOString(),
        models: [...st.good.models],
      };
    }
    async function fetchOne(): Promise<CatalogProvider> {
      let out: { status?: unknown; models?: unknown } | undefined;
      try {
        out = await withTimeout(
          deps.bus.call<Record<string, never>, { status?: unknown; models?: unknown }>(
            `models:list-available:${p.id}`,
            ctx,
            {},
          ),
          timeoutMs,
        );
      } catch (err) {
        ctx.logger.warn('model_catalog_provider_failed', {
          provider: p.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (out?.status === 'no-key') {
        delete st.good; // A known missing key cannot reuse a formerly live result.
        return { id: p.id, name: p.name, status: 'no-key', models: [] };
      }
      if (out?.status === 'live') {
        const models = normalizeModels(p.id, out.models);
        if (models.length > 0) {
          const at = now();
          st.good = { models, at };
          return { id: p.id, name: p.name, status: 'live', fetchedAt: new Date(at).toISOString(), models };
        }
      }
      return fallbackFor(ctx, p, st);
    }
    const pending = fetchOne();
    st.pending = pending;
    try {
      const provider = await pending;
      st.lastResult = { provider: structuredClone(provider), at: now() };
      return provider;
    } finally {
      delete st.pending;
    }
  }

  return {
    async get(ctx, opts) {
      const active = providers.filter((p) => deps.bus.hasService(`models:list-available:${p.id}`));
      return { providers: await Promise.all(active.map((p) => loadOne(ctx, p, opts.refresh))) };
    },
  };
}
