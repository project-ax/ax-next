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

/**
 * Per-agent state of one system default routine (e.g. `skill-reflection`).
 * `enabled` is default-ON: absence of an explicit per-agent override reads
 * as enabled. Drives the "Skill self-improvement" switch.
 */
export interface AgentDefaultState {
  defaultRoutineId: string;
  name: string;
  enabled: boolean;
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

/**
 * Coerce a server-supplied ISO string to a Date. Returns null when the
 * value is missing or doesn't parse (which `new Date(...)` represents as
 * an Invalid Date whose getTime() returns NaN). Without this guard, an
 * Invalid Date silently propagates: relativeTime() would call .getTime()
 * → NaN → render "NaNs ago", and FireRowsTable would call .toDateString()
 * which throws "Invalid Date" as a string but is meaningless to users.
 */
function asValidDate(s: string | null | undefined): Date | null {
  if (s === null || s === undefined) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hydrateRoutine(raw: unknown): Routine {
  const r = raw as Routine & { lastRunAt: string | null };
  return { ...r, lastRunAt: asValidDate(r.lastRunAt) };
}

function hydrateFire(raw: unknown): Fire {
  const f = raw as Fire & { firedAt: string };
  // Fall back to epoch (not null) so FireRowsTable's formatTimestamp can
  // still render *something* — `Fire.firedAt` is non-nullable per the
  // type contract, and a row missing its timestamp is a data bug we'd
  // rather surface as "Jan 1, 1970" than crash the whole panel.
  return { ...f, firedAt: asValidDate(f.firedAt) ?? new Date(0) };
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
  /** Per-agent default-routine state (owner-scoped). Drives the toggles. */
  async listAgentDefaults(agentId: string): Promise<AgentDefaultState[]> {
    const out = await get<{ defaults: AgentDefaultState[] }>(
      `/settings/routines/${encodeURIComponent(agentId)}/defaults`,
    );
    return out.defaults;
  },
  /** Flip a default routine on/off for one agent. */
  async setAgentDefaultEnabled(input: {
    agentId: string;
    defaultRoutineId: string;
    enabled: boolean;
  }): Promise<void> {
    await post<{ ok: true }>(
      `/settings/routines/${encodeURIComponent(input.agentId)}/defaults/${encodeURIComponent(input.defaultRoutineId)}`,
      { enabled: input.enabled },
    );
  },
};
