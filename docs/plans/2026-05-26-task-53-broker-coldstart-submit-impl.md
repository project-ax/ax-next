# TASK-53 — JIT broker cold-start: fire `catalog:submit` on search/request miss (design §13)

**Scope:** broker-side TRIGGER only. The admit queue, the `catalog:submit` hook, and the
catalog-requests store all already exist (TASK-41, merged). Today the broker's two host
tools return a no-hit silently:

- `request_capability(skillId)` → `{ status: 'not-found', skillId }` when `skills:get` throws `skill-not-found`.
- `search_catalog(intent)` → `{ skills: [] }` when the catalog matches nothing.

Design §13: *"broker finds no catalog hit → files an admit-request (deduped) → 'I've asked
your admin to add Linear; I'll be able to do this once it's approved.' Not an error."*

This card makes both miss paths **also** fire a `catalog:submit` `kind:'cold-start'` so the
unmet need lands in the admin's admit queue. No new store / hook / migration / schema.

## Invariants honored

- **I2 (no cross-plugin imports):** the broker reaches `catalog:submit` only through the
  hook bus, like every other call. A local slug helper (no `memory-strata` import).
- **I3 (no half-wired):** `catalog:submit` is co-loaded with the broker in `presets/k8s`
  (`@ax/skills` registers it), so the wiring is live in production; a skills-package broker
  canary exercises the real queue end-to-end.
- **I4 (one source of truth):** no new wishlist concept — reuse TASK-41's cold-start path.
- **I5 (capabilities minimized + untrusted input):** the broker gains only the ability to
  FILE a request (`optionalCall`, never `calls`), never to admit one. The untrusted free-text
  `intent` rides as the request *description* (data the admin triages, never a manifest); the
  dedup `skillId` is a locally-sanitized slug re-validated against `SKILL_ID_RE`. A cold-start
  request is non-promotable (TASK-41 enforces `cold-start-not-promotable`), so injected text
  cannot forge an admitted catalog skill. `requestedByUserId` is `toolCtx.userId` (host-auth),
  never model input.

## Boundary review

No new hook surface — the broker only *calls* an existing hook (`catalog:submit`, owned by
`@ax/skills`). Manifest change: add `catalog:submit` to the broker's `optionalCalls` with a
degradation note. Firing/calling a hook needs no `subscribes`/`registers` change. No IPC
action, no wire schema. Nothing leaks (the cold-start payload is `{skillId, requestedByUserId,
description}` — all storage-agnostic).

## Tasks

### Task 1 — shared cold-start helper in the broker (`tools/coldstart.ts`)
A small internal module both tools import (same-package, not cross-plugin):

- `COLDSTART_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/` and a local `deriveColdStartSlug(intent): string`
  — lowercase, non-`[a-z0-9]`→`-`, collapse repeats, trim leading/trailing `-`, cap 64; if the
  result is empty or fails the RE, return `'capability'`.
- `CAPABILITY_NEED_MAX = 280`; `clampNeed(text)` trims + caps the description.
- `async function fireColdStartSubmit(bus, ctx, { skillId, description })`: hasService-guarded
  + best-effort. If `bus.hasService('catalog:submit')`, call it inside try/catch
  (`kind:'cold-start', skillId, requestedByUserId: ctx.userId, description`); on absence or
  throw, swallow (never bubble out of the host tool). Returns `void`.

**Tests (`__tests__/coldstart.test.ts`, TDD-first):**
- `deriveColdStartSlug` table: `'Read my Linear issues'`→`'read-my-linear-issues'`;
  `'   !!!  '`→`'capability'`; a 200-char intent → ≤64 and matches the RE; leading/trailing
  punctuation trimmed; collapses repeated dashes.
- `clampNeed`: caps at 280, trims whitespace.
- `fireColdStartSubmit`: with a stub `catalog:submit`, asserts the call payload
  (`kind:'cold-start'`, `requestedByUserId` from ctx, sanitized fields); with no service,
  is a no-op (no throw); with a throwing service, swallows (no throw).

### Task 2 — wire `request_capability` not-found → cold-start
In `tools/request-capability.ts`, on the `skill-not-found` branch (before returning
`{status:'not-found'}`), call `fireColdStartSubmit(bus, toolCtx, { skillId,
description: \`A user requested the '${skillId}' capability, which isn't in the catalog yet.\` })`.
`skillId` is already `SKILL_ID_RE`-validated at the top of the tool — pass it straight through
(it satisfies the cold-start slug too). The return value is unchanged.

**Tests (extend `plugin.test.ts`):**
- not-found path fires `catalog:submit` cold-start with the validated skillId + templated
  description + `requestedByUserId` from ctx; the tool still returns `{status:'not-found'}`.
- the *found* path fires NO cold-start submit.
- a malformed skillId still throws *before* any submit (re-assert no submit fired).
- broker with no `catalog:submit` service: not-found still returns cleanly (degrade).

### Task 3 — wire `search_catalog` empty → cold-start
In `tools/search-catalog.ts`, after forwarding to `skills:search-catalog`, when the result
`skills` array is empty AND `intent` is non-empty, call `fireColdStartSubmit(bus, toolCtx,
{ skillId: deriveColdStartSlug(intent), description: clampNeed(intent) })`. Return the
(empty) result unchanged. An empty/whitespace intent fires nothing (no signal).

**Tests (extend `plugin.test.ts`, `search_catalog` describe):**
- empty result + non-empty intent fires cold-start with the derived slug + clamped intent
  description + ctx userId.
- a hit (`skills.length > 0`) fires NO submit.
- empty intent fires NO submit.
- no `catalog:submit` service → no throw, still returns `{skills:[]}`.

### Task 4 — manifest `optionalCalls` + canary
- `plugin.ts`: add `{ hook: 'catalog:submit', degradation: 'an unmet-capability need is not
  filed to the admin admit queue; the miss is still returned to the model as not-found/empty' }`
  to `optionalCalls`. Update the broker `plugin.test.ts` manifest assertion if it pins the
  exact `optionalCalls` set (check first; the existing test uses `arrayContaining` for calls).
- skills-package broker canary (`skill-install.canary.test.ts`, the existing
  `skill-broker canary` describe): after the `not-found` miss, call `catalog:list-requests`
  on the real `@ax/skills` and assert a pending `kind:'cold-start'` request for the missed
  id exists with `requestedByUserId` from the ctx. This closes I3 over the REAL queue.

## YAGNI pass

- Helper, both wirings, manifest, canary — all load-bearing at MVP (the card's whole point is
  the trigger; the canary is the I3 gate). Nothing speculative.
- NOT doing: changing the model-facing return shape (the design says the agent narrates "I've
  asked your admin" from the existing not-found/empty — that's a system-prompt/agent concern,
  out of scope for this broker-trigger card; note as a follow-up if not already covered).

## Verify

`pnpm build && pnpm test --filter @ax/skill-broker --filter @ax/skills` + lint; then full
`pnpm build && pnpm test` for the whole-branch gate. Security-checklist (untrusted intent).
