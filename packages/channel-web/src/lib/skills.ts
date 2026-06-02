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

import type { BundleFile, SkillDetail, SkillSummary, SkillTier } from '@ax/skills';

/** A catalog row as the admin Catalog tab sees it: a summary plus the
 * server-derived risk tier (the set the broker proposes from). `tier` is
 * computed server-side via classifyTier — never re-derived on the client.
 * Typed optional so existing fixtures stay valid; the server always sets it. */
export type CatalogSkillSummary = SkillSummary & { tier?: SkillTier };

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

export async function listSkills(): Promise<CatalogSkillSummary[]> {
  const res = await fetch('/admin/skills', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: CatalogSkillSummary[] };
  return body.skills;
}

/**
 * List the CALLER'S OWN user-scoped skills via the user-facing
 * `GET /settings/skills` route (requireUser, owner-scoped) — same
 * `{ skills }` shape as {@link listSkills}, but for a non-admin who can't reach
 * the admin `/admin/skills` catalog. Used by the per-agent skill-attachment
 * picker in the user Settings → Agents surface: a non-admin attaches THEIR OWN
 * skills to THEIR OWN agents (the server's owner-scoped attachment guard also
 * rejects any skill that would pull in a workspace/shared connector).
 */
export async function listUserSkills(): Promise<CatalogSkillSummary[]> {
  const res = await fetch('/settings/skills', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: CatalogSkillSummary[] };
  return body.skills;
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    credentials: 'include',
  });
  return (await handleResponse(res)) as SkillDetail;
}

/** Like getSkill, but resolves to null for a missing skill instead of throwing
 * (used by the Admit-queue review's diff: a share request for a brand-new id has
 * no existing catalog version).
 *
 * Sends `?missingOk=1` so the server answers a missing skill with a clean
 * `200 { skill: null }` rather than a `404`. That matters because the browser
 * auto-logs every failed (4xx/5xx) request to the console regardless of how
 * `fetch` handles the resolved Response — a plain 404 here would surface as a
 * red console error for an outcome that is entirely expected. The 200 keeps the
 * net-new-skill diff probe silent. */
export async function getSkillOrNull(skillId: string): Promise<SkillDetail | null> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}?missingOk=1`, {
    credentials: 'include',
  });
  const body = (await handleResponse(res)) as { skill: SkillDetail | null };
  return body.skill;
}

/** Flip a catalog skill's org-default flag without re-sending SKILL.md.
 * Server re-upserts preserving the bundle (PATCH route, bundle-safe). */
export async function setSkillDefaultAttached(
  skillId: string,
  defaultAttached: boolean,
): Promise<void> {
  const res = await fetch(`/admin/skills/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ defaultAttached }),
  });
  await handleResponse(res);
}

/**
 * Create a skill from a full SKILL.md string (frontmatter fence + body).
 * The server splits the fence and validates the manifest.
 *
 * `opts.defaultAttached` flips the skill onto every agent at session-open
 * (admin-only). Skills declaring credential slots cannot be default-attached;
 * the server rejects such writes with `default-attached-requires-no-credentials`.
 *
 * `opts.files` are the bundle's extra (non-SKILL.md) files. The key is sent
 * ONLY when defined — omitting it tells the server to leave the current bundle
 * unchanged; a present array (even `[]`) replaces it. The server re-validates
 * paths/bytes via validateBundleFiles.
 */
export async function upsertSkill(
  skillMd: string,
  opts?: { defaultAttached?: boolean; files?: BundleFile[] },
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
      ...(opts?.files !== undefined ? { files: opts.files } : {}),
    }),
  });
  return (await handleResponse(res)) as { skillId: string; created: boolean };
}

/**
 * Update an existing skill identified by `skillId`. The manifest `name`
 * field in `skillMd` must match `skillId`; the server enforces this.
 *
 * `opts.files` follows the same omit-vs-replace contract as `upsertSkill`.
 */
export async function updateSkill(
  skillId: string,
  skillMd: string,
  opts?: { defaultAttached?: boolean; files?: BundleFile[] },
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
      ...(opts?.files !== undefined ? { files: opts.files } : {}),
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
