/**
 * Default-routines wire client — typed wrappers around `/admin/routines/defaults*`.
 *
 * Mirrors `lib/skills.ts` shape:
 *
 *   - `credentials: 'include'` on every call so the auth-better session
 *     cookie flows.
 *   - `x-requested-with: ax-admin` on writes so requests pass the
 *     http-server's CSRF guard.
 *   - Throws on non-2xx with status + body excerpt.
 *   - Returns undefined on 204 (DELETE); returns parsed JSON otherwise.
 *
 * SECURITY NOTE — every endpoint is admin-gated server-side (requireAdmin
 * in `@ax/routines-admin-routes`). UI hiding is convenience; the gate is
 * on the server.
 */

import type { DefaultRoutineDetail, DefaultRoutineSummary } from '@ax/routines';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`default-routines API ${res.status}: ${excerpt.slice(0, 200)}`);
  }
  return res.json();
}

export async function listDefaultRoutines(): Promise<DefaultRoutineSummary[]> {
  const res = await fetch('/admin/routines/defaults', { credentials: 'include' });
  const body = (await handleResponse(res)) as { defaults: DefaultRoutineSummary[] };
  return body.defaults;
}

export async function getDefaultRoutine(
  defaultRoutineId: string,
): Promise<DefaultRoutineDetail> {
  const res = await fetch(
    `/admin/routines/defaults/${encodeURIComponent(defaultRoutineId)}`,
    { credentials: 'include' },
  );
  return (await handleResponse(res)) as DefaultRoutineDetail;
}

/**
 * Create a default routine from a full routine .md (frontmatter fence + body).
 * The server parses the frontmatter and rejects webhook/cron triggers (those
 * have no agent owner to anchor them to).
 */
export async function upsertDefaultRoutine(
  sourceMd: string,
): Promise<{ defaultRoutineId: string; created: boolean }> {
  const res = await fetch('/admin/routines/defaults', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ sourceMd }),
  });
  return (await handleResponse(res)) as {
    defaultRoutineId: string;
    created: boolean;
  };
}

/**
 * Update an existing default routine identified by `defaultRoutineId`. The
 * frontmatter `name` field in `sourceMd` must match the path id; the server
 * enforces this.
 */
export async function updateDefaultRoutine(
  defaultRoutineId: string,
  sourceMd: string,
): Promise<{ defaultRoutineId: string; created: boolean }> {
  const res = await fetch(
    `/admin/routines/defaults/${encodeURIComponent(defaultRoutineId)}`,
    {
      method: 'PUT',
      headers: writeHeaders,
      credentials: 'include',
      body: JSON.stringify({ sourceMd }),
    },
  );
  return (await handleResponse(res)) as {
    defaultRoutineId: string;
    created: boolean;
  };
}

export async function deleteDefaultRoutine(
  defaultRoutineId: string,
): Promise<void> {
  const res = await fetch(
    `/admin/routines/defaults/${encodeURIComponent(defaultRoutineId)}`,
    {
      method: 'DELETE',
      headers: csrfHeader,
      credentials: 'include',
    },
  );
  await handleResponse(res);
}
