# TASK-262 — `request_capability` freshness digests resolved connector reach

**Status:** implementing. Branch `auto-ship/TASK-262-freshness-resolved-reach`, base `main` @ `d36665e7`.

## Problem

`request_capability`'s freshness predicate
(`packages/skill-broker/src/tools/capability-freshness.ts`) digests the *catalog entry* only —
`{description, connectors:[sorted ids]}`. A connector whose reach (hosts, key slots, packages,
MCP servers, dev services) changes **under a stable id** therefore does not move the digest, so the
guard does not trip and the human who approves at 1pm is asked about reach the 7am human never saw.

**Severity: LOW, and it is not a reach hole.** Nothing is granted without the executor's second
card — a `chat:permission-request` the human clicks, routed at
`packages/channel-web/src/server/routes-chat.ts:880` → `agent:apply-capability-grant`. The executor
builds that card from a *live* `connectors:resolve` fan-out
(`request-capability.ts:205-308`, resolve loop `:222-257`), so changed reach is re-gated. What is at
stake is **consent clarity**, not unauthorized reach.

## Approach

Fold each referenced connector's **resolved reach** into the hashed shape, gated on
`bus.hasService('connectors:resolve')` — **the gate wraps the fold, never the predicate.**

## Tasks

1. **`capability-freshness.ts` — the reach fold.** (load-bearing)
   - `resolvedReach()`: filter ids by `CONNECTOR_ID_RE`, resolve **in parallel**, map a
     `PluginError{code:'not-found'}` to the `absent` sentinel and **re-throw everything else**.
   - `reachShape()`: keyMode + sorted/deduped hosts, slot NAMES, npm, pypi + `mcpServers` +
     `services` (both name-sorted; `args` order preserved).
   - Gate: `hasService` false ⇒ the shape is byte-identical to today's. No `timeoutMs` change.
2. **Comments.** Rewrite the `WHAT IT DOES NOT GUARD` header block (`:21-27`) to say what is now
   guarded, what still is not, and that the executor's second card is the reach gate.
3. **`plugin.ts` — correct the false degradation prose** (`:68-76`). It claims the card "shows only
   the skill's own capability block"; TASK-100 deleted that block and with no `connectors:resolve`
   the card is **skipped entirely** (`request-capability.ts:273-275`).
4. **Tests.** (a) reach changes under a stable id ⇒ check DISAGREES. (b) **no `connectors:resolve`
   ⇒ predicate still non-null and still trips on a catalog edit** — the regression a whole-predicate
   gate would cause. (c) `plugin.test.ts`: `tool:execute:request_capability` **re-calls**
   `connectors:resolve` per execution.

## Traps honoured

1. Gate the fold, not the predicate (the sibling's `freshness.ts:203` posture would blank it).
2. Parallel resolve — capture fails OPEN on overrun, check fails CLOSED. Don't raise `timeoutMs`.
3. Throw on a non-`not-found` resolve failure (the executor swallows; a producer must not).
4. Include `mcpServers` (the sibling's blind spot) — and `services`, same rule.
5. Fix the already-false `plugin.ts` degradation prose in this PR.

## YAGNI pass

All four tasks are load-bearing: 1+4 are the card's acceptance, 2+3 are the false-comment family
this epic is explicitly cleaning up. Nothing speculative added — no new hook, no new field on any
payload, no `timeoutMs` change.
