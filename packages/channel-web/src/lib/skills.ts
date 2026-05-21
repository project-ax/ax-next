/**
 * Skills wire client — typed wrappers around `/admin/skills*`.
 *
 * Path convention matches `lib/credentials.ts` (`/admin/...`, no `/api`
 * prefix). Server-side routes live in `@ax/skills`.
 *
 * Wire posture:
 *
 *   - `credentials: 'include'` on every call so the auth-better session
 *     cookie flows. Same posture as `lib/credentials.ts`.
 *   - `x-requested-with: ax-admin` on writes so requests pass the
 *     http-server's CSRF guard. Same posture as `lib/credentials.ts`.
 *   - Throws on non-2xx with status + body excerpt.
 *   - Returns undefined on 204 (DELETE); returns parsed JSON on 2xx otherwise.
 *
 * SECURITY NOTE — every endpoint is admin-gated server-side. UI hiding is
 * convenience; the gate is on the server.
 */

import type { SkillDetail, SkillSummary } from '@ax/skills';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`skills API ${res.status}: ${excerpt.slice(0, 200)}`);
  }
  return res.json();
}

export async function listSkills(): Promise<SkillSummary[]> {
  const res = await fetch('/admin/skills', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: SkillSummary[] };
  return body.skills;
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    credentials: 'include',
  });
  return (await handleResponse(res)) as SkillDetail;
}

/**
 * Create a skill from a full SKILL.md string (frontmatter fence + body).
 * The server splits the fence and validates the manifest.
 *
 * `opts.defaultAttached` flips the skill onto every agent at session-open
 * (admin-only). Skills declaring credential slots cannot be default-attached;
 * the server rejects such writes with `default-attached-requires-no-credentials`.
 */
export async function upsertSkill(
  skillMd: string,
  opts?: { defaultAttached?: boolean },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch('/admin/skills', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

/**
 * Update an existing skill identified by `skillId`. The manifest `name`
 * field in `skillMd` must match `skillId`; the server enforces this.
 */
export async function updateSkill(
  skillId: string,
  skillMd: string,
  opts?: { defaultAttached?: boolean },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

export async function deleteSkill(skillId: string): Promise<void> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
    headers: csrfHeader,
    credentials: 'include',
  });
  await handleResponse(res);
}

export interface CheckUpdateResult {
  available: boolean;
  currentVersion: number;
  latestVersion?: number;
  latestSkillMd?: string; // present iff available === true
}

export async function checkSkillForUpdates(
  skillId: string,
): Promise<CheckUpdateResult> {
  const res = await fetch(
    `/admin/skills/${encodeURIComponent(skillId)}/check-update`,
    { method: 'POST', headers: csrfHeader, credentials: 'include' },
  );
  return (await handleResponse(res)) as CheckUpdateResult;
}

export interface RefreshResult {
  updated: boolean;
  currentVersion?: number;
  newVersion?: number;
}

export async function refreshSkillFromSource(
  skillId: string,
): Promise<RefreshResult> {
  const res = await fetch(
    `/admin/skills/${encodeURIComponent(skillId)}/refresh-from-source`,
    { method: 'POST', headers: csrfHeader, credentials: 'include' },
  );
  return (await handleResponse(res)) as RefreshResult;
}
