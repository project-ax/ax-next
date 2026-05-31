# TASK-87 — Align admin agent-global skill-attach validator with per-skill credential-slot namespacing

Follow-up to TASK-86 (per-skill credential-slot namespacing, PR #244, merged `1ead108c`).

## Problem

TASK-86 namespaced credential slots per-skill (`skill:<id>:<slot>`) in the
orchestrator's host-side credential map, so two active authored skills declaring the
same bare slot name (e.g. both `LINEAR_API_KEY`) coexist instead of fatally colliding
(`skill-slot-collision` lockout). TASK-86 already dropped the cross-skill collision
check in the **per-user** validator (`skills/attachment-validation.ts`). The **admin
agent-global** validator (`agents/skill-attachments-validation.ts`,
`validateNewAttachments`) still rejects attaching two skills that share a slot name
with `slot-collision` — a false rejection now that the runtime never collides.

## Scope (one file + its test)

`packages/agents/src/skill-attachments-validation.ts` and its test
`packages/agents/src/__tests__/skill-attachments-validation.test.ts`.

## Tasks

### Task 1 (TDD) — relax collision, preserve genuine validation

**Tests first** (`skill-attachments-validation.test.ts`):

1. Update case #6: two attachments sharing a slot → **`ok: true`** (coexist), not
   `slot-collision`. Rename to reflect coexistence.
2. Update case #7: an attachment whose slot is in `reservedAgentSlots` → **`ok: true`**
   (trusted bare name wins at runtime; benign suppression, not a fatal collision).
3. New: two skills sharing slot `LINEAR_API_KEY` resolve to **distinct
   `skill:<id>:<slot>` keys** — assert the namespaced format inline (mirror, no
   cross-plugin import of `skillCredentialEnvName`).
4. New: a declared slot that is **malformed** (`'not a slot'`, `''`, `'lower_case'`)
   → **`invalid-slot`** rejection (genuine validation preserved).
5. Keep cases 1–5 + the disjoint-slots case green.

**Then implement** (`skill-attachments-validation.ts`):

- Remove the `slot-collision` rejection loop and the `slotOwners` map seeded from
  `agentRequiredCredentialSlots`. Keep the `agentRequiredCredentialSlots` PARAM
  (forward-compat seam used by the admin route + `TODO(orchestrator-grows-…)`), now
  unused for rejection; re-document it.
- Add an `invalid-slot` rejection: for each declared slot on each resolved skill,
  reject if it fails `SLOT_RE = /^[A-Z][A-Z0-9_]{0,63}$/` (the manifest parser's
  contract; re-checked here as a defense-in-depth drift guard — slot values are
  untrusted).
- Drop `'slot-collision'` from the `ValidationResult` code union; add `'invalid-slot'`.
- Update the file's doc comment to describe the namespacing rationale.

### Verification

- `pnpm -F @ax/agents build && pnpm -F @ax/agents test` green.
- Whole-repo `pnpm build && pnpm test` + lint green (the code union changed, so check
  downstream consumers of `ValidationResult.code` — `admin-routes.ts` reads
  `validation.code`/`.message` opaquely, no exhaustive switch).
- `ax-code-reviewer` whole-branch review clean.

## Boundary review

No hook surface change. `validateNewAttachments` is a pure internal function of
`@ax/agents`; its signature is preserved (param kept). No new dependency, no new IPC
action. This is an internal-implementation patch → no boundary-review block required.
It DOES sit on the credential boundary (I5) → security-checklist runs.

## YAGNI

- Keeping the unused `agentRequiredCredentialSlots` param: load-bearing as a documented
  forward-compat seam wired through the admin route; removing it would churn the route
  + drop the TODO seam. Kept.
- `invalid-slot` check: load-bearing — the card explicitly requires malformed slots
  stay rejected, and relaxing collision routes declared slots straight into the
  namespace.
