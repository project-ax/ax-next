/**
 * TASK-1247 — the calls behind the sharing settings: who can use an agent,
 * who owns it, and the by-name people search. All go through `httpFetch`, so a
 * 401 trips the session latch. A refusal throws `SharingRequestError`, which
 * carries the server's machine code (`forbidden`, `unknown-person`,
 * `rate-limited`, ...) for the UI to turn into words. The code is never shown.
 */
import type { AgentAudience, SharingView } from '@ax/agents';
import { httpFetch } from './http';
import { SHARING_COPY } from './sharing-copy';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
};

/** A sharing call the server refused (or answered in a shape we can't use). */
export class SharingRequestError extends Error {
  readonly status: number;
  /** The body's `error`, when it is a string. */
  readonly code: string | null;
  constructor(path: string, status: number, code: string | null) {
    super(`${path} -> ${status}${code === null ? '' : ` (${code})`}`);
    this.name = 'SharingRequestError';
    this.status = status;
    this.code = code;
  }
}

/** A person the search found. Display name only: never an email. */
export interface PersonMatch {
  id: string;
  displayName: string;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function codeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { error } = body as { error?: unknown };
  return typeof error === 'string' ? error : null;
}

async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await httpFetch(path, init);
  const body = await readJson(res);
  if (!res.ok) throw new SharingRequestError(path, res.status, codeOf(body));
  if (typeof body !== 'object' || body === null) {
    throw new SharingRequestError(path, res.status, null);
  }
  return body as Record<string, unknown>;
}

async function putSharing(path: string, payload: unknown): Promise<SharingView> {
  const body = await call(path, {
    method: 'PUT',
    headers: writeHeaders,
    body: JSON.stringify(payload),
  });
  if (typeof body.sharing !== 'object' || body.sharing === null) {
    throw new SharingRequestError(path, 200, null);
  }
  return body.sharing as SharingView;
}

/** Who can use the agent (owners only). Answers with the settings as saved. */
export function setAudience(agentId: string, audience: AgentAudience): Promise<SharingView> {
  return putSharing(`/admin/agents/${encodeURIComponent(agentId)}/audience`, audience);
}

/** The agent's whole owner list, creator included (owners only). */
export function setOwners(agentId: string, userIds: string[]): Promise<SharingView> {
  return putSharing(`/admin/agents/${encodeURIComponent(agentId)}/owners`, { userIds });
}

/** Find people by name for the picker. */
export async function searchPeople(query: string, signal?: AbortSignal): Promise<PersonMatch[]> {
  const path = `/admin/people?q=${encodeURIComponent(query)}`;
  const body = await call(path, signal === undefined ? {} : { signal });
  if (!Array.isArray(body.people)) throw new SharingRequestError(path, 200, null);
  // Keep only what the picker uses: a string id and a string name. Anything
  // else on an entry (an email, say) is dropped here and never travels on.
  const people: PersonMatch[] = [];
  for (const entry of body.people as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, displayName } = entry as { id?: unknown; displayName?: unknown };
    if (typeof id === 'string' && typeof displayName === 'string') people.push({ id, displayName });
  }
  return people;
}

/** The words for a sharing write that didn't land. The server's code picks the
 *  line; the code itself is never shown. Shared by the audience and owners
 *  dialogs. */
export function sharingErrorMessage(error: unknown, agentName: string): string {
  if (!(error instanceof SharingRequestError)) return SHARING_COPY.errors.generic;
  if (error.status === 403) return SHARING_COPY.errors.forbidden(agentName);
  if (error.code === 'unknown-person') return SHARING_COPY.errors.unknownPerson;
  if (error.code === 'duplicate-person') return SHARING_COPY.errors.duplicatePerson;
  if (error.code === 'creator-required') return SHARING_COPY.errors.creatorRequired;
  if (error.status === 503) return SHARING_COPY.errors.accountsUnavailable;
  if (error.status === 404) return SHARING_COPY.errors.notFound(agentName);
  return SHARING_COPY.errors.generic;
}
