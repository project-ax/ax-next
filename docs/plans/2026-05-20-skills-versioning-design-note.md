# Skills versioning + refresh — design note

> Companion to `docs/plans/2026-05-20-skills-capability-lifecycle-impl.md`, Phase C
> (steps C-design.1, C-design.2, C-design.3). The Phase C PR description references
> this doc; readers want the locked decisions and the boundary review without scanning
> the full plan.

## C-design.1 — Attachment-pinning policy

**Locked: (a) latest-wins. No per-attachment pinned version.**

Each agent attachment is `{ skillId, credentialBindings }` — that is, the attachment names
the skill by id and binds slots. It does *not* carry a `pinnedVersion`. When an admin
refreshes a skill (via the new `/admin/skills/:id/refresh-from-source` route, or by
re-uploading via the existing PUT route), every agent's next session picks up the new
`bodyMd` / `manifestYaml`.

**Why:** The skill is admin-managed, the admin chose to refresh, and the admin owns the
agent. Pinning would solve a multi-tenant ergonomics problem we don't have yet — see
[[feedback_yagni_check_in_plans.md]]. The instant we do (e.g., when the user-installable
scope axis lands in Plan 2's Phase D), we can add `pinnedVersion?: number` to the
attachment without touching anything else.

**How to apply:** Phase C ships zero schema changes to `agents.skill_attachments`. The
admin UI's "Update" button refreshes the underlying skill row and every agent attached
to it follows on next session.

## C-design.2 — `sourceUrl` scheme allowlist

**Locked: HTTPS only. No raw IPs. Hostname must pass `HOSTNAME_RE` (same regex as
`allowedHosts`).**

Concretely, the manifest parser rejects:
- `http://` — Phase C parser returns `invalid-manifest` with message `"sourceUrl" must use https://`.
- `file://`, `gs://`, `s3://`, anything else — same rejection.
- `https://10.0.0.1/skill.md` — IPv4 literal rejected.
- `https://[::1]/skill.md` — IPv6 literal rejected (HOSTNAME_RE requires DNS-shaped labels).
- `https://localhost/skill.md` — bare-host (single label) rejected by HOSTNAME_RE.

**Why:** The `sourceUrl` becomes a live fetch target whenever an admin presses Refresh.
Letting `http://` through would silently demote the integrity of every skill that opted
in to refresh. IP literals open the door to a malicious admin uploading a skill whose
sourceUrl points at a metadata service (e.g., `169.254.169.254`) inside the cluster
network. Same posture as `allowedHosts` — the manifest parser is the enforcement point.

**How to apply:** New code in `manifest.ts` does `new URL(raw)` + `u.protocol !== 'https:'`
rejection + `HOSTNAME_RE.test(u.hostname)`. The `IPV4_RE` regex already in
`manifest.ts:54` is reused.

**Out of scope for Phase C** (tracked for future hardening):
- Per-server hostname allowlist (admin-curated list of acceptable `sourceUrl` hosts).
  Today any https host is accepted. The admin who installs a skill is the trust anchor.
- Signature / digest validation. Today we re-parse the fetched manifest and refuse
  updates whose `version` is not strictly higher than the stored row's, but we don't
  cryptographically verify the fetched body.

## C-design.3 — Boundary review for `skills:check-for-updates`

This is a new service hook signature. Per CLAUDE.md, every new hook needs the four
boundary checks before it merges.

- **Alternate impl this hook could have:** A future "skill registry index" plugin could
  implement the same hook against an internal index (e.g., a curated catalog server) instead
  of fetching the manifest from the source URL. The hook input/output stays the same:

  ```typescript
  // Input:
  { skillId: string }
  // Output:
  {
    available: boolean;
    currentVersion: number;
    latestVersion?: number;
    latestSkillMd?: string;     // present iff available === true
  }
  ```

  No backend-specific vocabulary leaks into the surface — `skillId` is a logical
  identifier, `version` is a non-negative integer, `latestSkillMd` is the full SKILL.md
  body the alternate impl produces (whether by fetching, looking up an index, or
  generating). A registry-impl simply reads `latestSkillMd` from its own store instead of
  fetching `sourceUrl`. OK.

- **Payload field names that might leak:** `sourceUrl` is in storage but NOT in this
  hook's payload — readers of the hook never see where the skill came from. `skillMd`
  is a generic doc string. `version` is opaque integer. No leakage.

- **Subscriber risk:** Nothing subscribes to this hook today. The admin-routes handler
  (`POST /admin/skills/:id/check-update`) calls `bus.call('skills:check-for-updates', …)`
  directly. If a future plugin subscribes (e.g., a nightly auto-refresh routine), it
  would key off `available` / `latestVersion` — stable fields. OK.

- **Wire surface (if this is also an IPC action):** Not an IPC action. Service hook only.
  Schema lives in `@ax/skills/src/types.ts` next to the other `Skills*Input` / `Skills*Output`
  shapes. No central registry.

**Conclusion:** Hook signature is alternate-impl-friendly, payload field names are
shape-canonical not backend-specific, no subscriber risk today, no IPC surface. Safe to
land.
