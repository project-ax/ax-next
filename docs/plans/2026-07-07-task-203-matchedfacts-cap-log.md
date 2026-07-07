# TASK-203 — matchedFacts: soft-cap clip logging + revisit `user` stopword precision

Epic: reflect-rollup. Two small follow-ups on `packages/memory-strata/src/matched-facts.ts`
and `src/tools/memory-search.ts`.

## Problem

1. **Cap-clip logging.** The enumeration design (D2, `2026-07-03-...-enumeration-design.md`
   line 95) says the per-doc / per-response `matchedFacts` caps are *"soft; log when
   clipped."* Today `withMatchedFacts` clips silently — real traffic gives no signal on
   how often either cap binds. (Design cited 20/60; the shipped constants are **6/60**
   after the WS-A early-termination fix, PR #380 — log against the live constants.)

2. **`user` stopword precision.** `user` was pulled from `STOPWORDS` in #379 (a query of
   only `user` would otherwise short-circuit to `[]` and break the cap unit test). Because
   every fact line is written `User <did X>`, a query containing the token `user` matches
   ~every line. Card: re-evaluate against the offline e2e; special-case leading `User `
   only *if precision hurts*.

## Decisions (see `.claude/memory/decisions.md`, 2026-07-07)

- **Task 2 → leave the matcher unchanged.** Over-inclusion is bounded by the per-doc cap
  (6) + truncation marker (safe for enumeration); the offline e2e passed at orch
  78.0%/60.0% with this exact behavior; real queries rarely carry the literal token
  `user`; the reflect-rollup design already treats `user` as a generic low-salience token.
  Special-casing leading `User ` would *also* break the cap test, so the card's premise is
  mechanically wrong. The Task-1 logging is the empirical lever to revisit later.
- **Task 1 → two `ctx.logger.debug` events** (soft cap = telemetry, not a failure; `.warn`
  stays reserved for the read-throws catch).

## Tasks

### Task 1 — soft-cap clip logging (`withMatchedFacts`)
- On a per-doc clip (existing `probed.length > cap` / truncation-marker branch):
  `ctx.logger.debug('memory_strata_matched_facts_doc_clipped', { docId, shown: cap })`.
- Track rows skipped because the shared response budget was already spent
  (`total >= MAX_FACTS_PER_RESPONSE`). After the loop, if any were skipped:
  `ctx.logger.debug('memory_strata_matched_facts_response_capped', { limit: MAX_FACTS_PER_RESPONSE, rowsSkipped })`.
- No change to returned `matchedFacts` shape or the truncation-marker behavior.

**Tests** (`tools-memory-search.test.ts`, spy `logger.debug`):
- 8-fact doc → `doc_clipped` fired once with `{ docId, shown: 6 }` (marker still present).
- Doc at/under cap → `doc_clipped` NOT fired.
- 11 docs × 6 matching facts each → 11th row `matchedFacts: []` AND `response_capped`
  fired with `rowsSkipped: 1`.
- Single small doc under both caps → neither event fired (no spurious telemetry).

### Task 2 — no code change; documented re-evaluation
Add a code comment at the `STOPWORDS` `user`-omission note pointing at the clip logging as
the empirical revisit lever (keeps the "why" discoverable). No matcher/test change.

## Gate
`pnpm --filter @ax/memory-strata build && pnpm --filter @ax/memory-strata test` + lint.
Whole-branch `ax-code-reviewer` before PR.

## Boundary review
No new/changed hook surface, no IPC action, no payload field rename — purely internal
logging inside one plugin. Boundary review N/A.
