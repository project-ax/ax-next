# Manifest canonical form — Finding 4 (Codex 2026-04-29)

**Date:** 2026-05-20
**Status:** Design approved; doc-reconciliation + caveat work pending plan.
**Context:** Architectural-debt finding 4 from the Codex review of 2026-04-29
(`TODO.md` → "Architectural debt (Codex 2026-04-29)"). This finding **gates**
findings 2 (hook-bus enforcement) and 3 (workspace facade): both need to know
where a plugin's per-hook declarations live before they can be designed.

## The decision

The in-code **runtime manifest** — `PluginManifestSchema` in
`packages/core/src/plugin.ts` (`{ name, version, registers, calls,
subscribes }`), exposed as `plugin.manifest` on each plugin instance — is the
**single canonical plugin manifest**.

The `package.json` `ax` field described in the architecture spec
(`docs/plans/2026-04-22-plugin-architecture-design.md:528`) is **formally
abandoned**. It was never adopted by any package.

## Why (the audit trail)

1. **The benefits already exist against runtime manifests.** The spec credits
   the `ax` field with three uses: (a) cycle detection at load, (b) fail-fast on
   missing services, (c) a compatibility matrix. All three already run at
   bootstrap against the runtime manifest on already-imported plugin instances —
   `validateDependencyGraph`/`topologicalOrder` (`bootstrap.ts:191`/`:274`),
   `checkDuplicateRegisters` (`:212`), and `verifyCalls` (`:291`). Moving the
   read into `package.json` would only let core read manifests *before*
   importing plugin code. Every ax-next plugin is first-party and imported at
   boot regardless, so "before import" buys nothing today.

2. **Zero adoption — uniform deviation, not drift.** `grep -l '"ax":'
   packages/*/package.json` returns zero matches across all ~30 packages. The
   runtime form is the established working pattern; the spec is the outlier.

3. **package.json-canonical would actively damage finding 2.** Finding 2 needs
   each service hook to declare a return-shape **Zod schema** and a **timeout**.
   A Zod schema is a runtime JS value — it cannot be serialized into static
   JSON. So under package.json-canonical, a hook's timeout could live in JSON
   while its return schema had to stay in code: two sources of truth for one
   hook's contract, violating invariant #4 ("one source of truth per concept").
   Runtime-canonical gives finding 2 a single home.

## What changes

Two documentation reconciliations and one honesty caveat. No code migration, no
package.json read path.

### 1. Architecture spec — `2026-04-22-plugin-architecture-design.md:528-535`

Rewrite the passage "At load, core reads each plugin's manifest (the `ax` field
in their `package.json`)" and its JSON example to describe the runtime manifest:
core reads `plugin.manifest` (conforming to `PluginManifestSchema`) off each
imported plugin instance at `bootstrap()`.

Also correct two drifted details in the same block:
- The runtime manifest has **no `configSchema` field**. Plugin config is
  constructor-injected via `PluginInitContext.config`, not declared in the
  manifest. Drop `configSchema` from the manifest description.
- `subscribes` is part of the runtime manifest and should appear in the example
  (the spec's `ax` example omitted it).

### 2. `ax-conventions` skill — `SKILL.md:99-122`

Rewrite the "Plugin manifest format" section. Replace the `package.json` `ax`
example with the runtime manifest shape and a real example pulled from a current
`plugin.ts` (e.g. `workspace-git/src/plugin.ts`). Keep the `registers` / `calls`
/ `subscribes` semantics descriptions — they're accurate; only the *location*
(package.json → in-code) and the `configSchema` line change.

### 3. Honesty caveat — `ax-conventions` skill `SKILL.md:134-135` and `:278`

These lines currently assert behavior that does not exist yet:
- `:134` — "Return shape is Zod-validated; mismatches become `PluginError`."
- `:135` — "Each service hook has a timeout (configurable per hook). Exceeded =
  `PluginError`."
- `:278` — error table row "Plugin hangs | Per-hook timeout, `PluginError`."

`HookBus.call` (`hook-bus.ts:54`) does neither today — it awaits and casts.
Per the (b) decision, add a one-line caveat at each site marking these as **not
yet enforced — pending finding 2**, to be removed when finding 2 lands. This
keeps the docs honest during the window between finding 4 and finding 2.

> Note: the architecture spec's own equivalent claims live at
> `2026-04-22-plugin-architecture-design.md:638-639` (failure-mode table). The
> same caveat should be applied there for consistency.

## Gate output — what this unblocks

- **Finding 2** (hook-bus enforcement): the per-hook **return schema** and
  **timeout** declarations live **in code at the service-registration site**.
  The exact shape — an enriched `registers` entry (`string | { name, returns?,
  timeoutMs? }`) versus extra arguments to `HookBus.registerService` — is
  finding 2's plan to settle. Finding 4 fixes only the *home* (in-code runtime
  manifest / registration, never package.json).
- **Finding 3** (workspace facade): likewise lives in code; the
  rename-to-private + public-wrapper pattern needs no manifest-location change.

## Escape hatch (deliberately deferred)

If untrusted / third-party / marketplace plugin loading ever arrives, core may
want to inspect a plugin's declared capabilities **without** importing its code
(invariant #5). At that point a static pre-import manifest read can be added —
but:
- it's a small slice of the much larger untrusted-plugin **sandboxing** work,
  not a prerequisite worth pre-paying now; and
- it need not be `package.json`-shaped; a static `export const manifest` that
  core reads via a constrained loader would also satisfy it.

We are not building it now, and nothing in findings 2/3 depends on it.

## Out of scope

- Implementing finding 2 (hook-bus return validation + timeouts).
- Implementing finding 3 (workspace facade).
- Any change to `PluginManifestSchema`'s fields (finding 2 will extend it; this
  finding only blesses it as canonical).
