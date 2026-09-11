# TASK-348 — per-call reasoning effort on `LlmCallInput`

**Card:** https://github.com/project-ax/ax-next/issues/512
**Evidence:** `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md`, 2026-09-10/11 addenda.

## Problem

`memory_search`'s retrieval orchestrator runs under a 5000ms budget
(`DEFAULT_ORCHESTRATOR_TIMEOUT_MS`) and falls back to BM25 **silently** on a miss.
Benchmarking found reasoning — not model choice — dominates that budget. The card
(#512) reported `z-ai/glm-5.3-flash:nitro` going p50 3489 → 954ms and p95 16195 →
1256ms with minimal reasoning; this branch's own control-vs-flagged runs reproduce
the effect at p50 3338 → 865ms, with the no-flag arm's slowest call at 5183ms —
past the budget outright. Either way, at ~7× lower input cost than the default.

`LlmCallInput` is `{model, maxTokens, system, messages, temperature}` and neither
provider's translate layer has a passthrough, so the flag cannot reach the wire. The
cheap models are **unreachable**, not unavailable.

## Design decisions (settled before implementation)

### The shape: a scalar effort ladder, not a vendor object

```ts
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
// on LlmCallInput:
reasoningEffort?: ReasoningEffort;
```

- **Scalar, not `{effort, maxTokens}`.** Effort is the only rung all three target
  vendors express (OpenAI `reasoning_effort`, OpenRouter `reasoning.effort`,
  Anthropic effort→budget). A token budget is expressible on OpenRouter and Anthropic
  but not OpenAI, and no caller needs it. YAGNI: cut.
- **No `'none'` rung.** Measured live 2026-09-11 against OpenRouter (see below):
  BOTH `reasoning:{enabled:false}` AND `reasoning:{effort:'none'}` return
  `400 Reasoning is mandatory for this endpoint and cannot be disabled` on
  `z-ai/glm-5.3-flash:nitro` and `google/gemini-3.8-flash:nitro`. A rung we cannot
  honor without 400ing the caller does not belong on the surface. `'minimal'` is the
  floor, and it is accepted by every model tried.

### Live acceptance matrix (2026-09-11, OpenRouter, `rt` = `reasoning_tokens`)

| model | `effort:'none'` | `'minimal'` | `'low'` | `'medium'` | `'high'` | `enabled:false` |
|---|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash:nitro` | **400** | 200 rt=0 | 200 rt=1 | 200 rt=1 | 200 rt=0 | **400** |
| `deepseek/deepseek-v4.1-flash:nitro` | 200 rt=0 | 200 rt=16 | 200 rt=16 | 200 rt=19 | 200 rt=16 | 200 rt=0 |
| `google/gemini-3.8-flash:nitro` | **400** | 200 rt=0 | 200 rt=0 | 200 rt=72 | 200 rt=76 | **400** |
| `anthropic/claude-haiku-4.5` | 200 rt=0 | 200 rt=0 | 200 rt=0 | 200 rt=0 | 200 rt=0 | 200 rt=0 |

Model ids taken from a live `GET /api/v1/models` — all four present.

### Per-provider translation

- **OpenRouter** (`toChatCompletionsRequest`): `reasoning: { effort }`, passed
  straight through. The vocabulary is identical, so there is nothing to map.
- **Anthropic** (`toAnthropicRequest`):
  - `'minimal'` → **omit `thinking` entirely.** Extended thinking is OFF by default
    on the Messages API, so absence *is* the minimal-effort request — and it can
    never 400 on a model that does not support `thinking` at all.
  - `'low' | 'medium' | 'high'` → `thinking: {type:'enabled', budget_tokens: 1024 |
    4096 | 16384}`. The API requires `max_tokens > budget_tokens`, so `max_tokens`
    becomes `budget + caller's maxTokens` (the caller asked for N tokens of *answer*;
    thinking is extra). The API also rejects a non-1 `temperature` alongside
    thinking, so `temperature` is dropped (and the cap is floored at
    `budget + max(maxTokens, 1)`, because the API's inequality is strict and
    `maxTokens: 0` would otherwise land exactly on the budget).
  - An effort value outside the ladder — only reachable from plain JS or a
    JSON-decoded config, since TypeScript rejects it — is REFUSED with a
    `PluginError`, not silently dropped. The lookup is own-property-guarded
    (`Object.freeze` does not stop a prototype walk, so an unguarded index on
    `'constructor'` would put a *function* in `budget_tokens`). Refusing keeps
    the same caller bug loud on both providers: OpenRouter forwards whatever it
    was given and answers 400.
- Any future provider with no analogue ignores the field.

### Boundary review (invariant 1) — answered in the PR

Alternate impl, leak analysis and subscriber risk go in the PR description.

### Scope of callers

Only `makeBusOrchestratorClient` (`@ax/memory-strata`) sets the field. The four other
`LlmCallInput` constructors (conversation-titles, memory-strata observer + map,
validator-skill) are deliberately **left alone** — see PR body for the reasoning.

## Tasks

1. **`@ax/core`** — `ReasoningEffort` type + `LlmCallInput.reasoningEffort`, exported.
   Doc comment carries the "no `'none'`" measurement.
2. **`@ax/llm-openrouter`** — `toChatCompletionsRequest` emits `reasoning.effort`.
   Tests: each rung on the wire; absent ⇒ **no `reasoning` key at all** (negative-space
   assertion — a round-trip cannot detect an added field).
3. **`@ax/llm-anthropic`** — `toAnthropicRequest` maps the ladder as above. Tests:
   minimal ⇒ **no `thinking` key**; low/medium/high ⇒ budget + raised max_tokens +
   dropped temperature.
4. **`@ax/memory-strata`** — `makeBusOrchestratorClient` sends
   `reasoningEffort: 'minimal'`. Test asserts it reaches the hook payload.
5. **Bench** — `latency-probe.ts` arms mirror the production wire shape exactly; the
   stale "NOT reachable from production" note goes.
6. **Re-measure** `pnpm --filter @ax/memory-strata bench:latency`; move
   `DEFAULT_ORCHESTRATOR_MODEL` to the cheap winner if it holds.
   **OUTCOME: it did not hold; the default stays `anthropic/claude-haiku-4.5`.**
   Two runs of n=19 (full tables in the 2026-09-11 addendum of the Phase 3C
   report). The flag itself is proven — the control arm, same model same run,
   went p50 3338 -> 865ms, and its max of 5183ms was PAST the 5000ms budget.
   But `z-ai/glm-5.3-flash:nitro`'s tail measured 1443 / 2758 / 4133ms across
   three runs, and against a hard timeout with a silent fallback a reproducible
   tail beats a good median. Haiku's p95 has not exceeded 1580ms in four runs.
   Also found by reading `reasoning_tokens` back: `deepseek-v4.1-flash` accepts
   `'minimal'` and keeps reasoning anyway (32-279 tokens on every call).
7. **Docs/memory** — report addendum, `DEFAULT_ORCHESTRATOR_MODEL` doc table,
   `values.yaml` comment, and the now-stale `.claude/memory/patterns.md` row that
   generated this card (contract rule 5).

## Out of scope

Orchestrator **accuracy** — unmeasured for every model in these tables. Its own card.


## Appendix — raw acceptance probe (2026-09-11)

The "no `'none'` rung" decision rests on this, and it is a separate manual probe
from the latency bench, so the output is recorded here rather than only summarized.
`GET /api/v1/models` first (all four ids present), then one completion per
model × shape, reading `usage.completion_tokens_details.reasoning_tokens` back:

```
  z-ai/glm-5.3-flash:nitro           effort:none       400 "Reasoning is mandatory for this endpoint and cannot be disabled."
  z-ai/glm-5.3-flash:nitro           effort:minimal    200 | rt=0 | 410ms
  z-ai/glm-5.3-flash:nitro           effort:low        200 | rt=1 | 355ms
  z-ai/glm-5.3-flash:nitro           effort:medium     200 | rt=1
  z-ai/glm-5.3-flash:nitro           effort:high       200 | rt=0 | 449ms
  z-ai/glm-5.3-flash:nitro           enabled:false     400 "Reasoning is mandatory for this endpoint and cannot be disabled."
  z-ai/glm-5.3-flash:nitro           absent            200 | rt=0 | 347ms
  deepseek/deepseek-v4.1-flash:nitro effort:none       200 | rt=0 | 373ms
  deepseek/deepseek-v4.1-flash:nitro effort:minimal    200 | rt=16 | 461ms
  deepseek/deepseek-v4.1-flash:nitro effort:low        200 | rt=16 | 359ms
  deepseek/deepseek-v4.1-flash:nitro effort:medium     200 | rt=19
  deepseek/deepseek-v4.1-flash:nitro effort:high       200 | rt=16 | 365ms
  deepseek/deepseek-v4.1-flash:nitro enabled:false     200 | rt=0 | 346ms
  deepseek/deepseek-v4.1-flash:nitro absent            200 | rt=16 | 371ms
  google/gemini-3.8-flash:nitro      effort:none       400 "Reasoning is mandatory for this endpoint and cannot be disabled."
  google/gemini-3.8-flash:nitro      effort:minimal    200 | rt=0 | 808ms
  google/gemini-3.8-flash:nitro      effort:low        200 | rt=0 | 1327ms
  google/gemini-3.8-flash:nitro      effort:medium     200 | rt=72
  google/gemini-3.8-flash:nitro      effort:high       200 | rt=76 | 912ms
  google/gemini-3.8-flash:nitro      enabled:false     400 "Reasoning is mandatory for this endpoint and cannot be disabled."
  google/gemini-3.8-flash:nitro      absent            200 | rt=75 | 897ms
  anthropic/claude-haiku-4.5         effort:none       200 | rt=0 | 736ms
  anthropic/claude-haiku-4.5         effort:minimal    200 | rt=0 | 734ms
  anthropic/claude-haiku-4.5         effort:low        200 | rt=0 | 784ms
  anthropic/claude-haiku-4.5         effort:medium     200 | rt=0
  anthropic/claude-haiku-4.5         effort:high       200 | rt=0 | 793ms
  anthropic/claude-haiku-4.5         enabled:false     200 | rt=0 | 691ms
  anthropic/claude-haiku-4.5         absent            200 | rt=0 | 704ms
```

Three things this pinned down that a summary would have lost:

1. **`effort:'none'` 400s in exactly the same places `enabled:false` does.** The
   obvious "just map our `'none'` onto theirs" design would have been dead on
   arrival for two of four models. That is why the ladder's floor is `'minimal'`.
2. **Latency here is not the latency that matters.** These are one-sentence
   prompts; every arm looks fast. The reasoning penalty only shows up against a
   real densified map, which is what the bench measures.
3. **`deepseek` reasons at every rung including `'minimal'`** (rt=16) and stops
   only for `enabled:false`/`effort:'none'`. Foreshadowed the bench finding that
   it emits 32–279 reasoning tokens on every orchestrator call.
