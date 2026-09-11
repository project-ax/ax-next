# TASK-348 — per-call reasoning effort on `LlmCallInput`

**Card:** https://github.com/project-ax/ax-next/issues/512
**Evidence:** `docs/plans/2026-05-13-memory-strata-phase-3c-config-d-report.md`, 2026-09-10/11 addenda.

## Problem

`memory_search`'s retrieval orchestrator runs under a 5000ms budget
(`DEFAULT_ORCHESTRATOR_TIMEOUT_MS`) and falls back to BM25 **silently** on a miss.
Benchmarking found reasoning — not model choice — dominates that budget:
`z-ai/glm-5.3-flash:nitro` goes p50 3489 → 954ms, p95 16195 → 1256ms when asked for
minimal reasoning, at ~7× lower input cost than the current default.

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
    thinking, so `temperature` is dropped.
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
