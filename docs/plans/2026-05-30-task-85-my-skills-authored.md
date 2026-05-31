# TASK-85 — My Skills lists authored/approved skills + downgrade divergence log

## Problem

1. The "My Skills" panel (`UserSkillsPanel.tsx`) reads only user-installed CATALOG
   skills via `GET /settings/skills` (`skills:list scope:'user'`). Agent-authored /
   approved skills (`skills_v1_authored`) are invisible, so a user who has authored
   skills sees "No skills installed".
2. Host logs `transcript_display_divergence` at ERROR per resume. Per TASK-67 it is
   alarm-only (never throws). A benign by-design resume should not log at ERROR.

## Design

### Item 1 — authored skills in My Skills

Authored skills are keyed `(owner_user_id, agent_id)` in `skills_v1_authored`. The
My Skills panel is per-user with no agent selector. So the new read aggregates the
caller's authored skills **across all of the caller's PERSONAL agents** (team agents
have no single-owner authored namespace — `agents:list-authored-skills` already
returns `[]` for them).

**New route:** `GET /settings/skills/authored` in `@ax/skills` `settings-routes.ts`.
- Authenticate → `actor.id`.
- `agents:list-for-user({ userId: actor.id })` (soft, hasService-guarded — a preset
  without `@ax/agents` simply yields no authored skills). Filter to
  `ownerType === 'user'` (personal, owner == actor).
- For each personal agent, call the existing `skills:list-authored({ ownerUserId:
  actor.id, agentId })` hook (same plugin; reuses the projection).
- Drop `quarantined` rows (a flagged draft is not a user-facing "installed" skill);
  keep `active` + `pending`. Tag each with its `agentId` and `status`.
- Return `{ skills: AuthoredSkillListing[] }` where `AuthoredSkillListing` is a
  storage-agnostic projection: `{ skillId, agentId, description, status }` (NO
  manifest/body bytes — the listing is a summary surface, not an editor).

**Wire client:** `lib/user-skills.ts` grows `listAuthoredSkills()` →
`AuthoredSkillListing[]`.

**Panel:** `UserSkillsPanel` fetches both lists in `refresh()`. Renders authored
skills in a second, read-only section (a labeled table) under the catalog skills,
each row showing id, the owning agent, description, and a status Badge
(`active` / `pending review`). Authored skills have NO edit/share/delete actions
here (they are authored in chat; My Skills only surfaces them). The empty state
("No skills installed") only shows when BOTH lists are empty.

#### Boundary review (new read surface)

- **Hook surface change?** No new *hook* — `GET /settings/skills/authored` is an HTTP
  route that calls EXISTING hooks (`agents:list-for-user`, `skills:list-authored`).
  No new bus service is registered.
- **Alternate impl:** the aggregation could equally live in the channel-web BFF
  (`routes-chat.ts`) instead of `@ax/skills`. Chosen `@ax/skills` because all
  `/settings/skills*` routes + the `user-skills.ts` wire client live there and the
  authored store is `@ax/skills`-owned (one source of truth).
- **Payload field names that might leak:** none. `AuthoredSkillListing` is
  `{ skillId, agentId, description, status }` — no `bundle_tree_sha`, `row`, table
  vocab. `status` is the design's stable lifecycle enum.
- **Subscriber risk:** none — it's a leaf HTTP read, no subscribers.
- **Capabilities (I5):** the route forces `ownerUserId = actor.id` for every authored
  read and filters agents to `ownerType==='user' && ownerId===actor.id` — a user can
  only ever see their OWN authored skills. No client-supplied user/agent id.

### Item 2 — downgrade divergence log

`packages/conversations/src/plugin.ts:702` — change `ctx.logger.error(
'transcript_display_divergence', …)` to `ctx.logger.warn(…)`. The alarm is still
emitted (a real divergence is still visible), just not at ERROR. Update the docstring
("a loud `logger.error`" → warn) and the existing tests that assert
`logRecords.find(r => r.msg === 'transcript_display_divergence')` to assert it is a
`warn` record, not `error`.

## Tasks

1. **`@ax/skills`: authored listing type + route.** Add `AuthoredSkillListing` +
   `SettingsAuthoredSkillsOutput` to `types.ts`. Add `GET /settings/skills/authored`
   handler + registration in `settings-routes.ts`. Tests: route returns active+pending
   authored skills across the user's personal agents, drops quarantined, forces
   ownerUserId=actor, returns [] when `agents:list-for-user` absent. (TDD)
2. **channel-web wire + panel.** Add `listAuthoredSkills()` to `lib/user-skills.ts`.
   Update `UserSkillsPanel.tsx` to fetch + render authored skills section with status
   badges; empty state only when both empty. Test (Bug Fix Policy): panel lists an
   authored/approved skill (fails before the fix). (TDD)
3. **conversations: error→warn.** Flip the log level + docstring; update the 4
   divergence tests to assert warn. (TDD — assert warn, not error.)

## YAGNI pass

- No edit/delete/share for authored skills in My Skills (out of scope; authored in
  chat). Cut.
- No manifest/body bytes in the listing (summary surface only). Cut.
- No agent selector / per-agent grouping beyond an "agent" column. Cut.
