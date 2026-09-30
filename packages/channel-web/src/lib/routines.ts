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
import { STORAGE_FULL_ROUTINE_REMOVE, STORAGE_FULL_ROUTINE_SAVE } from './storage-copy';
import { storageFullFromBody } from './storage-full';

export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string; events?: string[]; hmac?: unknown };

export type FireStatus = 'ok' | 'silenced' | 'error';
export type FireSource = 'tick' | 'webhook' | 'manual';

export interface ActiveHours {
  start: string;
  end: string;
  tz: string;
}

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
  // The editable fields. All already returned by `routines:list`
  // (RoutineRow) and relayed whole by the route — the editor seeds its form
  // from these when editing an existing routine.
  promptBody: string;
  activeHours: ActiveHours | null;
  silenceToken: string | null;
  silenceMaxChars: number;
}

/**
 * One row of the admin fires table, as it arrives over
 * `GET /settings/routines/:agentId/fires`.
 *
 * There is no `id`: the store's `BIGSERIAL` primary key is storage vocabulary
 * and `routines:recent-fires` no longer declares it, so the bus strips it
 * (TASK-312). Nothing here is keyed off a row id — `FireRowsTable` keys off
 * `firedAt` plus the list position.
 */
export interface Fire {
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
  status: FireStatus;
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
  if (!r.ok) throw await readFailure(path, r);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ax-admin' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await readFailure(path, r);
  return r.json() as Promise<T>;
}

// `put` and `del` are the two verbs the storage limit can turn away (they write
// through `workspace:apply`), so each names the sentence to wear if the server's
// own is missing. `get` and `post` never are, and do not look for the refusal.
async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ax-admin' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await readFailure(path, r, STORAGE_FULL_ROUTINE_SAVE);
  return r.json() as Promise<T>;
}

async function del(path: string): Promise<void> {
  const r = await fetch(path, {
    method: 'DELETE',
    headers: { 'X-Requested-With': 'ax-admin' },
  });
  // 204 No Content — nothing to parse on success.
  if (!r.ok) throw await readFailure(path, r, STORAGE_FULL_ROUTINE_REMOVE);
}

/**
 * The words in a failed response, or null when it carries none a person could
 * use. Both shapes are read, string first because it is the one the server
 * really sends: `@ax/routines-admin-routes` answers `{ error: '<reason>' }`
 * (a validator's veto, 'forbidden', ...). `{ error: { message } }` is kept for
 * anything that speaks that way.
 *
 * This used to read ONLY the object shape, so every string error read as a bare
 * "HTTP 400" and a validator's "interval.every: minimum is 60s" never reached
 * the person. Anything that is not a non-blank string is not a message: it falls
 * back to the status, and a body is never printed as JSON.
 */
function messageIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { error } = body as { error?: unknown };
  const text =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && !Array.isArray(error)
        ? (error as { message?: unknown }).message
        : undefined;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/**
 * What a failed request throws. The body is read ONCE (the hand-built responses
 * in the tests, and a real one, can only be read once), then the same body is
 * asked three things in order:
 *
 *   1. Is it the storage refusal (`413 { error: 'storage-full', message }`)?
 *      Then the error is a `StorageFullError`, whose `message` IS the sentence:
 *      the server's when it sent one, else `storageFullFallback`. Only asked
 *      when the caller named a fallback, i.e. for a save or a delete.
 *   2. Does it carry a message (string or object `error`)? Then that.
 *   3. Otherwise `HTTP <status>`. Never a body printed as JSON.
 *
 * The callers render `err.message` as it is, so no component needs a branch.
 */
async function readFailure(
  path: string,
  r: Response,
  storageFullFallback?: string,
): Promise<Error> {
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return new Error(`HTTP ${r.status}`);
  }
  if (storageFullFallback !== undefined) {
    const full = storageFullFromBody(path, r.status, body, storageFullFallback);
    if (full !== null) return full;
  }
  return new Error(messageIn(body) ?? `HTTP ${r.status}`);
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
  /**
   * Create or update a routine by writing its `.ax/routines/<name>.md` file
   * into the agent workspace. `path` is the full file path the editor derives
   * from the routine name; the server writes the bytes and @ax/routines syncs
   * the row. Returns the path the server wrote.
   */
  async save(input: { agentId: string; path: string; sourceMd: string }): Promise<{ path: string }> {
    return put<{ path: string }>(
      `/settings/routines/${encodeURIComponent(input.agentId)}`,
      { path: input.path, sourceMd: input.sourceMd },
    );
  },
  /** Delete a routine by removing its `.ax/routines/<name>.md` file. */
  async remove(input: { agentId: string; path: string }): Promise<void> {
    await del(
      `/settings/routines/${encodeURIComponent(input.agentId)}?path=${encodeURIComponent(input.path)}`,
    );
  },
  /**
   * The agent's webhook receiver token — one token serves every webhook
   * routine on the agent. The full receiver URL is
   * `<origin>/webhooks/<token><routine-webhook-path>`.
   */
  async webhookToken(agentId: string): Promise<{ token: string }> {
    return get<{ token: string }>(
      `/settings/routines/${encodeURIComponent(agentId)}/webhook-token`,
    );
  },
};
