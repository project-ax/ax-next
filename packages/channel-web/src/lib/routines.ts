/**
 * Per-user routines wire client. Mirrors `lib/credentials.ts` shape:
 * a thin object exposing the three methods the UI needs.
 *
 * The server side (Phase D, new `@ax/routines-admin-routes` plugin):
 *
 *   GET    /settings/routines                  → list (caller's agents)
 *   GET    /settings/routines/:agentId/fires?path=…&limit=20
 *                                              → recent fires for one routine
 *   POST   /settings/routines/:agentId/fire    → manual fire-now;
 *                                                body: { path, payload? }
 *
 * All three are role-gated to the actor and scoped to agents owned by
 * (or shared with) the caller. The wire shape mirrors `routines:list` +
 * `routines:fire-now` service hooks 1:1 — the route layer is a thin
 * HTTP shim over the existing service hooks plus a new
 * `routines:recent-fires` hook this phase introduces.
 */

export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string; events?: string[]; hmac?: unknown };

export type FireStatus = 'ok' | 'silenced' | 'error';
export type FireSource = 'tick' | 'webhook' | 'manual';

export interface Routine {
  agentId: string;
  path: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  conversation: 'per-fire' | 'shared';
  lastStatus: FireStatus | null;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface Fire {
  id: number;
  agentId: string;
  path: string;
  firedAt: Date;
  triggerSource: FireSource;
  status: FireStatus;
  error: string | null;
  conversationId: string | null;
  renderedPrompt: string | null;
}

export interface FireNowInput {
  agentId: string;
  path: string;
  payload?: unknown;
}
export interface FireNowOutput {
  fireId: number;
  status: FireStatus;
  conversationId: string | null;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, {
    headers: { 'X-Requested-With': 'ax-admin' },
  });
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ax-admin' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await readError(r));
  return r.json() as Promise<T>;
}

async function readError(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${r.status}`;
  } catch {
    return `HTTP ${r.status}`;
  }
}

function hydrateRoutine(raw: unknown): Routine {
  const r = raw as Routine & { lastRunAt: string | null };
  return { ...r, lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null };
}

function hydrateFire(raw: unknown): Fire {
  const f = raw as Fire & { firedAt: string };
  return { ...f, firedAt: new Date(f.firedAt) };
}

export const routines = {
  async list(): Promise<Routine[]> {
    const out = await get<{ routines: unknown[] }>('/settings/routines');
    return out.routines.map(hydrateRoutine);
  },
  async recentFires(input: { agentId: string; path: string; limit?: number }): Promise<Fire[]> {
    const qs = new URLSearchParams({ path: input.path });
    if (input.limit !== undefined) qs.set('limit', String(input.limit));
    const out = await get<{ fires: unknown[] }>(
      `/settings/routines/${encodeURIComponent(input.agentId)}/fires?${qs}`,
    );
    return out.fires.map(hydrateFire);
  },
  async fireNow(input: FireNowInput): Promise<FireNowOutput> {
    return post<FireNowOutput>(
      `/settings/routines/${encodeURIComponent(input.agentId)}/fire`,
      { path: input.path, ...(input.payload !== undefined ? { payload: input.payload } : {}) },
    );
  },
};
