/**
 * User skills wire client — typed wrappers around `/settings/skills*`.
 *
 * Mirrors `lib/skills.ts` but points at the user-scoped settings routes.
 * The server forces `scope='user'` and `ownerUserId` from the session —
 * callers MUST NOT send scope or ownerUserId in the request body.
 *
 * Wire posture:
 *
 *   - `credentials: 'include'` on every call so the auth-better session
 *     cookie flows.
 *   - `x-requested-with: ax-admin` on writes to pass the CSRF guard.
 *   - Throws on non-2xx with status + body excerpt.
 *   - Returns undefined on 204 (DELETE); returns parsed JSON on 2xx otherwise.
 *
 * check-update / refresh-from-source routes are NOT exposed here — those
 * admin-only actions have no equivalent on `/settings/skills*`.
 */

import type {
  BundleFile,
  SkillDetail,
  SkillSummary,
  CatalogSubmitOutput,
} from '@ax/skills';

const writeHeaders = {
  'content-type': 'application/json',
  'x-requested-with': 'ax-admin',
} as const;

const csrfHeader = { 'x-requested-with': 'ax-admin' } as const;

async function handleResponse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`user-skills API ${res.status}: ${excerpt.slice(0, 200)}`);
  }
  return res.json();
}

export async function listUserSkills(): Promise<SkillSummary[]> {
  const res = await fetch('/settings/skills', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: SkillSummary[] };
  return body.skills;
}

export async function getUserSkill(skillId: string): Promise<SkillDetail> {
  const res = await fetch(`/settings/skills/${encodeURIComponent(skillId)}`, {
    credentials: 'include',
  });
  return (await handleResponse(res)) as SkillDetail;
}

/**
 * Create a user-scoped skill from a full SKILL.md string (frontmatter
 * fence + body). The server splits the fence, validates the manifest, and
 * forces scope='user' + ownerUserId from the session.
 *
 * `opts.files` are the bundle's extra (non-SKILL.md) files; sent only when
 * defined (omit = preserve current bundle, present array = replace).
 */
export async function createUserSkill(
  skillMd: string,
  opts?: { defaultAttached?: boolean; files?: BundleFile[] },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch('/settings/skills', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
      ...(opts?.files !== undefined ? { files: opts.files } : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

/**
 * Update an existing user-scoped skill. The manifest `name` field in
 * `skillMd` must match `skillId`; the server enforces this.
 *
 * `opts.files` follows the same omit-vs-replace contract as `createUserSkill`.
 */
export async function updateUserSkill(
  skillId: string,
  skillMd: string,
  opts?: { defaultAttached?: boolean; files?: BundleFile[] },
): Promise<{ skillId: string; created: boolean }> {
  const res = await fetch(`/settings/skills/${encodeURIComponent(skillId)}`, {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({
      skillMd,
      ...(opts?.defaultAttached !== undefined
        ? { defaultAttached: opts.defaultAttached }
        : {}),
      ...(opts?.files !== undefined ? { files: opts.files } : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

export async function deleteUserSkill(skillId: string): Promise<void> {
  const res = await fetch(`/settings/skills/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
    headers: csrfHeader,
    credentials: 'include',
  });
  await handleResponse(res);
}

/**
 * Submit the caller's own user-scoped skill to the org catalog (the
 * user-facing share-to-catalog producer, TASK-60 / §6D). Fires the host's
 * `catalog:submit` hook via `POST /settings/skills/:id/share` — the server
 * snapshots the skill's bytes and files an admit-queue request for an admin to
 * review. The caller's identity is the session; nothing is sent in the body.
 *
 * Returns `{ created: false }` when a request for this skill is already pending
 * review (dedup) — that's a normal, non-error result, surfaced as "already
 * submitted" in the UI.
 */
export async function shareUserSkill(
  skillId: string,
): Promise<CatalogSubmitOutput> {
  const res = await fetch(
    `/settings/skills/${encodeURIComponent(skillId)}/share`,
    {
      method: 'POST',
      headers: csrfHeader,
      credentials: 'include',
    },
  );
  return (await handleResponse(res)) as CatalogSubmitOutput;
}
