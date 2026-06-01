# TASK-111 — Skill→connector cap-resolution bridge

**Branch:** `auto-ship/TASK-111-skill-connector-cap-bridge`
**Design:** `docs/plans/2026-05-31-connectors-first-class-design.md`
**Prereq for:** TASK-100 (removes the capability block + adds the reject-validator)

## Problem

The connectors-first-class epic built connectors PARALLEL to skill caps but never
bridged skill→connector cap resolution. A skill's `connectors[]` (TASK-92) is
parsed + stored (`ResolvedSkill.connectors`) but **never resolved into sandbox
caps**. TASK-97's `connector-union.ts` resolves the AGENT's effective connector
set (defaults ∪ owner's private), NOT the connectors a skill in the union
declares. So `skill.connectors` is dead-on-arrival.

This card builds the missing bridge — WITHOUT removing the capability block
(TASK-100 does that). Both paths stay live (invariant #3 — no half-wired).

## Constraints

- **Additive.** `skill.capabilities` parsing + materialization stays FULLY
  FUNCTIONAL. Both paths work this card.
- **One fold path.** Reuse TASK-97's `foldConnectorCaps` verbatim — no second
  materialization path (invariant #4).
- **No cross-plugin imports** (invariant #2) — caps flow via the hook bus.
- **NON-FATAL** connector resolution (additive reach; a failure yields fewer
  connectors, never terminates).
- **postgres-testcontainer tests** use `stopPostgresContainer()` (TASK-104) — only
  relevant if any new test spins a container; the orchestrator unit tests don't.

## Tasks (independent, testable)

### Task 1 — Thread `connectors[]` onto the orchestrator's skill mirror

`ResolvedSkillForOrch` (orchestrator.ts:321) drops the `connectors` field that
`skills:resolve` (@ax/skills `ResolvedSkill.connectors`) already returns. Add it:

```ts
export interface ResolvedSkillForOrch {
  id: string;
  capabilities: {...};
  /** Soft-dependency connector-id references (TASK-92). Optional + `?? []` for
   *  back-compat with a skills:resolve that predates the field. */
  connectors?: string[];
  bodyMd: string;
  manifestYaml: string;
  files?: {...}[];
}
```

`loadBuiltinSkills` (`presets/k8s/src/builtin-skills/index.ts`) and
`AuthoredResolvedSkillForOrch` inherit it (the latter extends the former). The
builtin loader can also populate `connectors` from the parsed manifest (the
builtins declare none today, so `[]`, but wiring it keeps the loader honest).

**Test:** type-level — a `ResolvedSkillForOrch` with `connectors: ['linear']`
compiles; one without compiles (optional). Covered by Task 2/4 runtime tests.

### Task 2 — `resolveSkillReferencedConnectors` helper in connector-union.ts

New exported function, the twin of `resolveEffectiveConnectors` but driven by an
explicit id list (the union of every `unionedSkills[].connectors`), deduped
against the already-resolved effective-set ids:

```ts
export async function resolveSkillReferencedConnectors(
  bus: HookBus,
  ctx: AgentContext,
  connectorIds: Iterable<string>,
  alreadyResolved: Set<string>,   // ids already in the effective set
): Promise<ResolvedConnectorForOrch[]>
```

- hasService-gated on `connectors:resolve`.
- For each unique id NOT in `alreadyResolved`, call `connectors:resolve`
  ({ userId: ctx.userId, connectorId }); a per-id resolve failure logs
  (`skill_connector_resolve_failed`) + skips that id (NON-FATAL).
- A pending authored draft is never returned by `connectors:resolve` (it reads
  only the LIVE table — TASK-94), so an unapproved connector grants no reach — the
  zero-reach posture is preserved for free.
- Returns the resolved connectors (id + capabilities + usageNote) for the caller
  to append to `effectiveConnectors` before the single `foldConnectorCaps` call.

**Tests** (connector-union.test.ts, pure unit):
- resolves a skill-referenced id not in the effective set;
- dedups: an id already in `alreadyResolved` is NOT re-resolved;
- NON-FATAL: a per-id resolve failure skips just that id;
- returns [] when `connectors:resolve` is unregistered (stripped preset);
- returns [] for an empty id list.

### Task 3 — Wire the helper into orchestrator materialization

In orchestrator.ts, right after the TASK-97 `effectiveConnectors` resolution
(~1809) and BEFORE `foldConnectorCaps`:

1. Collect `skillConnectorIds = new Set(unionedSkills.flatMap(s => s.connectors ?? []))`.
   (Use `unionedSkills` — the full materialized set: attachments + defaults +
   builtins + active authored drafts — so every skill the model sees contributes.)
2. `alreadyResolved = new Set(effectiveConnectors.map(c => c.id))`.
3. `const skillConnectors = await resolveSkillReferencedConnectors(bus, ctx, skillConnectorIds, alreadyResolved);`
4. `const allConnectors = [...effectiveConnectors, ...skillConnectors];`
5. Feed `allConnectors` into the single existing `foldConnectorCaps(...)` call.

No second fold, no new sandbox plumbing — the fold's installedEntries / slot
env-names / registry flags / credential stamping all already thread through.

**Tests** (orchestrator.test.ts, end-to-end with stub bus):
- an agent with a skill declaring `connectors: ['linear']` (the connector
  registered via `connectors:resolve`) gets the connector's hosts in the
  proxy:open-session allowlist + its credential slot in the credential map +
  its synthetic SKILL.md installed entry → **the core acceptance test**;
- dedup: a connector that is BOTH a skill reference AND in the agent effective
  set is folded once (no duplicate installed entry);
- **no-regression**: a skill using the legacy `capabilities:` block (no
  `connectors[]`) still materializes its hosts/slots unchanged.

### Task 4 — `request_capability` routes through connector-derived caps

`request-capability.ts` reads the catalog skill (`skills:get` → `SkillDetail`,
which carries `connectors`). When the skill references connectors, resolve each
via `connectors:resolve` and union its hosts/slots/packages into the
`PermissionRequestEvent` card surface (so the user approves the connector's
reach). The skill's OWN `capabilities` block still contributes (both paths live).

- hasService-gated on `connectors:resolve` + best-effort (a failed resolve just
  omits that connector's reach from the card — never blocks it).
- Add `connectors:resolve` to the broker manifest `optionalCalls` with a
  degradation note.
- The `account`-tagged slots from the connector keep their `account` so
  `haveExisting` works (mirror the existing slot mapping).
- Dedup hosts/slots/packages so a host declared both by the skill block and the
  connector appears once.

**Tests** (skill-broker plugin.test.ts):
- a requested skill with `connectors: ['linear']` → the fired card includes the
  connector's hosts + slots (connector path);
- no-regression: a skill with a `capabilities` block + no connectors → card
  unchanged (legacy path);
- NON-FATAL: a throwing `connectors:resolve` still fires the card with the
  skill's own caps.

## Out of scope / follow-ups (return in handoff)

- Removing the capability block + the reject-validator → **TASK-100** (depends on
  this card; the half-wired window is now closeable).
- Per-agent connector attachment in `AgentForm` (the other half of design Phase
  4) — already a deferred follow-up from TASK-97.
- The JIT `applyCapabilityGrant` (catalog-skill approval) binds the skill's own
  slots; a connector-subject grant for a request_capability'd skill's connectors
  is the authored-connector grant path (already exists). If a catalog skill's
  referenced connector needs a key the user lacks, the connector's own connect
  flow (TASK-96) handles it — no new grant path needed this card.

## Security note (Phase 5 — security-checklist)

Touches: capability/credential resolution + model-authored proposals (skill_propose)
+ the approval wall. Run security-checklist in Phase 5. Key invariants to assert:
zero-reach for unapproved/pending connectors (connectors:resolve reads live table
only); connector slots stay namespaced (`connector:<id>:<slot>`) so they can't
hijack a trusted credential; the legacy path is unchanged (no widening).
