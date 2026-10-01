/**
 * Models wire client — the wire and nothing else; sentences live in models-copy.ts.
 * Every endpoint is admin-gated server-side; hiding the tab is convenience only.
 */

const writeHeaders = { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' } as const;

export type ProviderStatus = 'live' | 'cached' | 'fallback' | 'no-key' | 'error';
const STATUSES: ReadonlySet<string> = new Set(['live', 'cached', 'fallback', 'no-key', 'error']);

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
export interface ModelPolicy {
  source: 'admin' | 'builtin';
  version: number;
  allowed: string[];
  default: string;
  updatedAt?: string;
  updatedBy?: string;
  warning?: 'saved-policy-unreadable';
}
export interface ImpactRow {
  model: string;
  agentCount: number;
}

export class ModelsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverError?: string,
  ) {
    super(serverError !== undefined && serverError.length > 0 ? serverError : `models request failed: ${status}`);
    this.name = 'ModelsHttpError';
  }
}

async function failure(res: Response): Promise<ModelsHttpError> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') serverError = body.error;
  } catch {
    /* non-JSON body */
  }
  return new ModelsHttpError(res.status, serverError);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const bad = (status: number): ModelsHttpError => new ModelsHttpError(status, 'unexpected-response');

function asProvider(v: unknown): CatalogProvider | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  if (typeof v.status !== 'string' || !STATUSES.has(v.status) || !Array.isArray(v.models)) return null;
  const models: CatalogModel[] = [];
  for (const m of v.models) {
    if (!isObj(m) || typeof m.ref !== 'string' || typeof m.label !== 'string') return null;
    models.push({ ref: m.ref, label: m.label });
  }
  return {
    id: v.id,
    name: v.name,
    status: v.status as ProviderStatus,
    ...(typeof v.fetchedAt === 'string' ? { fetchedAt: v.fetchedAt } : {}),
    models,
  };
}

function asPolicy(v: unknown): ModelPolicy | null {
  if (!isObj(v) || (v.source !== 'admin' && v.source !== 'builtin')) return null;
  if (typeof v.version !== 'number' || !isStrings(v.allowed) || typeof v.default !== 'string') return null;
  return {
    source: v.source,
    version: v.version,
    allowed: v.allowed,
    default: v.default,
    ...(typeof v.updatedAt === 'string' ? { updatedAt: v.updatedAt } : {}),
    ...(typeof v.updatedBy === 'string' ? { updatedBy: v.updatedBy } : {}),
    ...(v.warning === 'saved-policy-unreadable' ? { warning: 'saved-policy-unreadable' as const } : {}),
  };
}

export async function fetchCatalog(opts: { refresh?: boolean } = {}): Promise<CatalogProvider[]> {
  const res = await fetch(`/admin/models/catalog${opts.refresh === true ? '?refresh=1' : ''}`, {
    credentials: 'include',
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isObj(body) || !Array.isArray(body.providers)) throw bad(res.status);
  const providers: CatalogProvider[] = [];
  for (const p of body.providers) {
    const parsed = asProvider(p);
    if (parsed === null) throw bad(res.status);
    providers.push(parsed);
  }
  return providers;
}

export async function fetchPolicy(): Promise<ModelPolicy> {
  const res = await fetch('/admin/models/policy', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const policy = asPolicy(await res.json());
  if (policy === null) throw bad(res.status);
  return policy;
}

export async function savePolicy(input: {
  baseVersion: number;
  allowed: string[];
  default: string;
}): Promise<ModelPolicy> {
  const res = await fetch('/admin/models/policy', {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res);
  const policy = asPolicy(await res.json());
  if (policy === null) throw bad(res.status);
  return policy;
}

/** How many agents use each model an admin is about to remove (counts only). */
export async function fetchImpact(remove: string[]): Promise<ImpactRow[]> {
  const res = await fetch('/admin/agents/models/impact', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ remove }),
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isObj(body) || !Array.isArray(body.affected)) throw bad(res.status);
  const rows: ImpactRow[] = [];
  for (const r of body.affected) {
    if (!isObj(r) || typeof r.model !== 'string' || typeof r.agentCount !== 'number') throw bad(res.status);
    rows.push({ model: r.model, agentCount: r.agentCount });
  }
  return rows;
}
