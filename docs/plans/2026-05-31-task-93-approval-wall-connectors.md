# TASK-93 — Extend the capability-approval wall to cover connectors

**Branch:** `auto-ship/TASK-93-capability-wall-connectors` · **Base:** `main` · **Epic:** connectors-first-class
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md` §"Security — reuse the existing approval wall"

## Problem

The approved-caps store (`packages/skills/src/approved-caps-store.ts`) records what a
human approved at the capability wall, keyed `(owner_user_id, agent_id, skill_id,
cap_kind, cap_value)`. An agent-authored **connector** (connectors-first-class epic) is
the same kind of model-authored capability declaration (network reach + credential
slots + binaries), and the design says reuse this exact wall rather than fork a parallel
one (invariant #4 one-source-of-truth, #5 caps explicit+minimized).

This slice lands **storage + hook surface only**. No authoring path is wired (TASK-94's
`install_authored_connector` loop gates against it). The skill capability block stays
authoritative until TASK-100 (half-wired window OPEN by design — sanctioned, TASK-91).

## Approach (chosen)

**Polymorphic subject via an additive nullable-by-sentinel column.** Keep `skill_id`
exactly as-is; add `connector_id TEXT NOT NULL DEFAULT ''`. The grant subject is exactly
one of `{skill, connector}`:

- skill grant → `skill_id='<id>'`, `connector_id=''`
- connector grant → `skill_id=''`, `connector_id='<id>'`

PK extends to `(owner_user_id, agent_id, skill_id, connector_id, cap_kind, cap_value)`.
Empty-string sentinel (not NULL) so the column stays in the PK (Postgres PK cols are
NOT NULL). Existing skill queries (`WHERE skill_id=X`) still match because every connector
row carries `skill_id=''`. Purely additive (acceptance: "additive migration"; memory:
ALTER-in-place is correct, greenfield has no prod data).

Store method input becomes a **discriminated subject ref**: callers pass `{ skillId }`
*or* `{ connectorId }` (back-compat: existing `{ skillId }` callers unchanged).

### Why not a rename to `(subject_kind, subject_id)`?

The migration header bans renames (destructive → side-table). The card itself says
"instead of (or in addition to) a skill ref" — both coexisting is explicitly fine. The
additive column is the smaller, backward-bit-compatible change and keeps every existing
skill-scoped row + query untouched.

## Boundary review (hook-surface change)

- **Alternate impl:** `@ax/skills-sqlite` — registers the same `skills:approved-caps-*`
  hooks with these shapes against a sqlite backend.
- **Leaky field names:** none. `connectorId` is a domain slug (same class as `skillId`);
  `cap_kind`/`cap_value` are already mechanism-agnostic. Backing-mechanism vocab
  (transport/url/mcp/packages) never appears — it stays inside the connector's opaque
  `capabilities` JSONB in `@ax/connectors`, never in an approved-caps field.
- **Subscriber risk:** none — `connectorId`/`skillId` are opaque ids; the projection
  matches on `(cap_kind, cap_value)` only.
- **Wire surface:** these hooks are not new IPC actions; no central schema touched.

## Security review (per security-checklist)

- **Sandbox:** N/A — adds no new reachable capability. This is the approval-RECORD store;
  the path that *consumes* a connector-scoped row to grant runtime reach lands in TASK-94.
  Per-user isolation preserved (`owner_user_id` in PK + every WHERE).
- **Injection:** `connectorId`/`value`/`kind` may be model-authored (TASK-94). Stored as
  opaque TEXT via parameterized Kysely (no SQL interpolation), never into shell/path/prompt
  in this slice. `kind` is union-constrained; the `mcp`-kind rejection guard is kept.
- **Supply chain:** N/A — no `package.json` change; all edits inside `@ax/skills`.

## Tasks (independent, testable)

### T1 — migration: add `connector_id`, extend PK (storage layer)
`packages/skills/src/migrations.ts`
- Add `connector_id TEXT NOT NULL DEFAULT ''` to the `skills_v1_approved_caps`
  `CREATE TABLE` def; PK becomes the 6-col composite (name the constraint).
- Add an idempotent post-create block: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS
  connector_id ...`, then guarded PK swap (drop old PK constraint if it's the 5-col one,
  add the 6-col PK) — so a table created by a prior migration upgrades in place. Idempotent
  on rerun (greenfield, no prod rows).
- Add `connector_id: string` to `ApprovedCapRow` (`packages/skills/src/migrations.ts`).
- **Test:** migration run is idempotent (run twice, no error); a fresh table has the
  6-col PK (covered transitively by store tests).

### T2 — store: discriminated subject ref (skill | connector)
`packages/skills/src/approved-caps-store.ts`
- `ApprovedCapSubject = { skillId: string } | { connectorId: string }` (exported).
- `set`/`clear`/`list` accept `ownerUserId`, `agentId`, the subject, plus kind/value.
- Internally normalize the subject to `(skill_id, connector_id)` with the empty-string
  sentinel for the unused side; all WHERE clauses filter BOTH columns so a skill grant
  and a connector grant with the same id never collide.
- **Test (`approved-caps-store.test.ts`):**
  - connector-scoped set→list→revoke round-trip; idempotent set.
  - skill-scoped path unchanged (existing tests stay green).
  - cross-subject isolation: a skill `linear` grant and a connector `linear` grant don't
    bleed into each other's `list`.
  - per-user isolation preserved for connector rows (uA vs uB).

### T3 — hook surface + types: connector-aware input
`packages/skills/src/types.ts`, `packages/skills/src/plugin.ts`
- `SkillsApprovedCaps{List,Set,Revoke}Input` accept a subject ref: keep `skillId?`
  optional, add `connectorId?` optional; exactly-one enforced at the handler (PluginError
  `invalid-input` if both/neither). Output schemas unchanged (list still returns
  `{ capabilities: ApprovedCapEntry[] }`; the `mcp` cap_kind union is unchanged).
- Plugin handlers pass the subject through to the store; keep the `kind:'mcp'` rejection.
- A non-test src consumer already type-depends on these inputs (orchestrator/agents call
  with `{ skillId }`) → `tsc --build` guards the type change (memory: tests aren't
  type-checked). Confirm orchestrator + agents callers still compile unchanged.
- **Test:** `plugin.test.ts` — connector-scoped set/list/revoke through the bus;
  exactly-one-subject validation (both → error, neither → error); skill path still works.
  `return-schemas.test.ts` — list output unchanged (no connector field leaks into output).

## YAGNI pass

- T1–T3 all load-bearing at MVP (the card's acceptance is exactly storage + hook surface
  accepting a connector ref). No authoring/projection/consumer code — that's TASK-94,
  deliberately out of scope. No connector-grant projection into the proxy here.

## Out of scope → follow-ups (handoff, auto-ship files cards)

- TASK-94 authoring loop (`install_authored_connector`) consumes these rows.
- Orchestrator/agents projecting connector-scoped grants into the credential proxy.
