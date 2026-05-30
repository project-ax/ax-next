# TASK-74 — Skills Part D: skill_propose chokepoint + /ephemeral authoring + hybrid gate + workspace-draft retirement

**Date:** 2026-05-30
**Card:** PVTI_lADOD4dXMc4BYpfZzguQoBo (remainder of TASK-69; Part D2 merged as #229)
**Design:** docs/plans/2026-05-30-out-of-git-design.md (Part D, §D1–D6)

## Problem

Today an agent "authors" a skill by writing `.ax/draft-skills/<id>/SKILL.md` into its
git workspace; `@ax/validator-skill` scans it on `workspace:pre-apply` (accept-but-
annotate → quarantine); and `agents:resolve-authored-skills` *re-scans the workspace*
(`listAuthoredBundles`) at every session open to project the drafts. That is the LAST
skill substrate still in git — a split-brain (DB rows for catalog/default/attached;
git workspace for authored drafts) and it rides the per-turn commit/bundle hot loop
(Part D §C2). Part D moves authoring onto the SAME DB+blob substrate as every other
skill, behind a single write chokepoint: `skill_propose`.

## Approach (chosen)

Mirror the merged `artifact_publish` shape (TASK-68) exactly:

- A small **`@ax/tool-skill-propose`** package: the `skill_propose` ToolDescriptor
  (`executesIn: 'sandbox'`, name `skill_propose`), a `/ephemeral/skill-draft/**` path
  allowlist, and a host-side plugin that registers the descriptor via `tool:register`.
- A runner-side **`skill-propose-executor.ts`**: validates the draft dir structurally
  (read `SKILL.md` + extra files, `parseSkillManifest`, `validateBundleFiles`, path
  safety), streams the bundle EXTRA-file bytes to `blob.put` (callBinaryUpload, mirror
  artifact_publish), and posts the JSON envelope via a new `skill.propose` IPC action.
- A new **`skill.propose` IPC action** in `@ax/ipc-protocol` (JSON request:
  `{ manifestYaml, bodyMd, files[]-as-metadata-only? , capabilityProposal, origin, bundleSha256? }`;
  response `{ skillId, status }`). The bundle EXTRA-file bytes already went up via
  `blob.put`; the JSON envelope carries the manifest/body + the blob sha (a content
  hash, not backend vocab) so the host re-reads the extra files via the bundle store.
- A new host IPC handler `skill-propose.ts` calling a new **`skills:propose` host hook**.
- **`skills:propose`** (in `@ax/skills`) is the gate + the single-source-of-truth write:
  - re-validate structurally (defense-in-depth: `parseSkillManifest`, `validateBundleFiles`);
  - fire a **`skills:scan`** subscriber hook (NEW — the validator-skill veto/scan moves
    here from `workspace:pre-apply`) carrying `{ skillId, manifestYaml, bodyMd, files }`;
    a subscriber returns a scan verdict (clean | hit{reason}) — accept-but-annotate;
  - classify per the hybrid gate (D3):
    - clean scan ∧ origin=authored ∧ capabilityProposal=∅ → `status='active'`
    - any capability OR origin∈{imported,attached} → `status='pending'`
    - scan hit → `status='quarantined'` (reason returned to agent)
  - write ONE `skills_v1_skills`-family row with new columns `origin`, `status`,
    `scan_verdict` (additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), the manifest/body,
    the capability proposal (frontmatter is the proposal SoT), and the bundle blob sha.
- **Retire** `listAuthoredBundles` (the `.ax/draft-skills` workspace scan) and the
  validator-skill `workspace:pre-apply` SKILL.md scan branch (the SDK-config hard veto
  STAYS — it guards `.claude/settings.json` etc., unrelated to skills). Re-back
  `agents:resolve-authored-skills` onto a new `skills:list-authored` DB read + the bundle
  store (`blob:get`) instead of the workspace scan.
- **Re-spawn on next turn**: the existing `respawnSessions` machinery is keyed off a
  `.ax/draft-skills/` `workspace:applied`. With authoring off git there is no
  `workspace:applied` to key on, so the orchestrator's `agent:apply-authored-capability-
  grant` (pending→active approval) already terminates the warm session (existing). For
  the FREE path (active immediately at propose), the propose response tells the runner
  it's active-next-turn; the runner's session is already marked dirty by the existing
  session-dirty trigger? No — must add: on a successful `skill.propose` the runner emits
  a turn-end that the host treats as dirty. Simpler: the orchestrator marks the session
  dirty when `skills:propose` produced a new active/pending row this turn. Use a
  `skills:proposed` notify the host hook fires → orchestrator subscriber marks the
  conversation's session dirty (re-spawn next turn). Mirrors onWorkspaceApplied.
- **System-prompt guidance**: a fixed runner-authored line — "a skill you propose this
  turn becomes available next turn; tell the user it's ready on their next message;
  don't try to invoke it now" (design §D6 build requirement).

## Key scoping decisions (see decisions.md)

1. Authored skills are stored in `skills_v1_user_skills` (user-scoped) with the new
   `origin/status/scan_verdict` columns, NOT a new table — they ARE user skills with a
   provenance tag. Per-agent scoping (quarantine/approved-caps already keyed by
   user+agent+skill) stays in those side-tables; the skill row itself is user-scoped
   (matches today's authored→user-skill promote path).
2. The `skills:scan` hook is the validator veto's new home: storage/transport-agnostic
   payload `{ skillId, manifestYaml, bodyMd, files }` → `{ verdict: 'clean' } | { verdict:
   'hit', reason }`. NOT `workspace:pre-apply` (that's git-coupled and fires on every
   commit; the chokepoint is now `skills:propose`).
3. Keep `agents:resolve-authored-skills` hook NAME + output shape; swap its backing from
   `listAuthoredBundles` (workspace) to `skills:list-authored` (DB) + bundle store. The
   orchestrator union + approval-card flow are untouched.

## Tasks (independent, testable)

- **T1 — ipc-protocol `skill.propose` action.** Schemas + types; no leak (origin enum,
  capabilityProposal skill-domain, bundleSha256 content hash). Tests: schema round-trip.
- **T2 — `@ax/tool-skill-propose` package.** Descriptor + `/ephemeral/skill-draft/**`
  path allowlist + host-tool-register plugin (mirror tool-artifact-publish). Tests: path
  allowlist, descriptor shape.
- **T3 — `@ax/skills` schema + gate.** Add `origin/status/scan_verdict` columns; add
  `skills:propose` (gate + write) + `skills:list-authored` (read for the projection) +
  fire `skills:scan`. Retire nothing yet. Tests: gate classification (3 paths), row write.
- **T4 — `@ax/validator-skill` → `skills:scan`.** Move the SKILL.md scan/quarantine from
  `workspace:pre-apply` to a `skills:scan` subscriber; DELETE the SKILL.md branch from
  pre-apply (keep the SDK-config hard veto). Tests: scan hit/clean, pre-apply no longer
  scans SKILL.md.
- **T5 — runner `skill-propose-executor.ts` + wiring.** Mirror artifact-publish-executor;
  wire in main.ts; system-prompt guidance line. Tests: executor validation + IPC calls.
- **T6 — host IPC handler `skill-propose.ts`.** Mirror artifact-publish handler; register
  in dispatcher; dependencies note. Tests: handler maps hook output, validation, authz.
- **T7 — re-back `agents:resolve-authored-skills` on DB; retire `listAuthoredBundles`.**
  Swap backing; delete `listAuthoredBundles` + the `.ax/draft-skills` scan; orchestrator
  re-spawn keyed off a `skills:proposed` notify instead of `workspace:applied` draft path.
  Tests: projection from DB rows; re-spawn fires.
- **T8 — preset wiring.** Register `@ax/tool-skill-propose` in presets/k8s; canary
  reachability. Tests: chart-shape / bootstrap.
- **T9 — security-checklist + boundary review in PR body.** Whole-branch.

## YAGNI

- No new UI: the approval card (TASK-35) + Skills affordance already exist; D5 UX is the
  existing pending→card→active flow. No channel-web changes beyond what the gate emits
  through the existing card path.
- MCP capability approval stays deferred (existing `approved-caps-set` rejects `mcp`).
- No `skill_propose` for `imported`/`attached` origins from the runner — the runner only
  ever proposes `origin='authored'` (it composed the bundle); imported/attached are
  host-side admin/catalog actions that already exist. The gate still classifies all three
  for completeness, but the runner chokepoint hard-codes `origin='authored'`.
