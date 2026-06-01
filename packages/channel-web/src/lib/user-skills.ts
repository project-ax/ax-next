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
  AuthoredSkillListing,
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

/**
 * List the caller's agent-AUTHORED skills (TASK-85). The host aggregates
 * `skills_v1_authored` across the caller's personal agents and returns the
 * user-facing `active` + `pending` rows (quarantined drafts are withheld).
 * "My Skills" surfaces these alongside the user's catalog skills.
 */
export async function listAuthoredSkills(): Promise<AuthoredSkillListing[]> {
  const res = await fetch('/settings/skills/authored', { credentials: 'include' });
  const body = (await handleResponse(res)) as { skills: AuthoredSkillListing[] };
  return body.skills;
}

/** Wire shape of the adopt-&-edit result (TASK-134). Declared locally — invariant
 * I2 (no @ax/skills runtime import; the inter-plugin contract is the route, not a
 * TS import). */
export interface AdoptAuthoredResult {
  /** The id of the user-scoped skill the draft was copied into. */
  skillId: string;
  /** Whether the user-scoped copy was created (false = overwrote an existing one). */
  created: boolean;
  /** Whether this call flipped the draft to `adopted`. */
  adopted: boolean;
}

/**
 * Adopt-&-edit (TASK-134): copy an agent-authored draft into the caller's OWN
 * editable user-scoped skill (manifest + body + extra files), then mark the draft
 * adopted so it drops off the "Authored by your agents" listing. The server forces
 * the owner from the session and ACL-checks that `agentId` is one of the caller's
 * own personal agents; nothing is sent in the body. On success the caller opens
 * the form-first editor on the returned `skillId` (a user-scoped skill).
 */
export async function adoptAuthoredSkill(
  agentId: string,
  skillId: string,
): Promise<AdoptAuthoredResult> {
  const res = await fetch(
    `/settings/skills/authored/${encodeURIComponent(agentId)}/${encodeURIComponent(skillId)}/adopt`,
    {
      method: 'POST',
      headers: csrfHeader,
      credentials: 'include',
    },
  );
  return (await handleResponse(res)) as AdoptAuthoredResult;
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

/**
 * Approve a PENDING agent-authored cap-skill EARLY, before the agent's first use
 * (TASK-83 / JIT discoverability). The "My Skills" panel calls this after the
 * user has entered any required keys (which post straight to the credential
 * store via `setDestinationCredential`, never through this call). This is the
 * out-of-band twin of the in-chat approval card's POST to
 * `/api/chat/permission-decision` — same authored grant, no conversation.
 *
 * NO secret on this wire — only domain ids + the `shown` TOCTOU guard (exactly
 * what the panel displayed). The server ACL-checks the agent and re-resolves the
 * skill as one of THAT agent's pending drafts before approving. A 409
 * 'not-authored' means the skill isn't a pending draft of this agent.
 */
export async function approveAuthoredSkill(input: {
  agentId: string;
  skillId: string;
  shown?: { hosts: string[]; slots: string[]; npm: string[]; pypi: string[] };
}): Promise<void> {
  const res = await fetch('/api/chat/approve-authored-skill', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const excerpt = await res.text().catch(() => '');
    throw new Error(`approve failed: ${res.status} ${excerpt.slice(0, 200)}`);
  }
}
