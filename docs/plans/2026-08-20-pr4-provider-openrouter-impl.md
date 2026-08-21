# PR 4 — Provider layer: OpenRouter credential path + `models:list-supported`

**Date:** 2026-08-20. **Owner:** Vinay (via yolo-ship).
**Design:** `docs/plans/2026-08-18-provider-agnostic-runner-design.md` §6, Sequencing row 4.
**Predecessors:** PR 1 (#395 runner-core), PR 2 (#399 runner+model selection), PR 3 (#400 aisdk runner).

**Gate:** `grok-4.6` / `kimi-k3` drive a real conversation on the cluster.

---

## Problem statement

`@ax/agent-aisdk-runner` ships a `ToolLoopAgent` loop that is provider-agnostic in
shape but Anthropic-only in fact. Every seam between the agent row and the model
call hard-codes Anthropic:

| Seam | Today | File |
|---|---|---|
| Runner provider registry | one entry, `anthropic` | `agent-aisdk-runner/src/provider.ts:86` |
| Runner env bootstrap | hard-requires `ANTHROPIC_API_KEY` | `agent-runner-core/src/proxy-startup.ts:288` |
| Session egress + credential default | `['api.anthropic.com']` + `provider:anthropic` | `chat-orchestrator/src/orchestrator.ts:1863` |
| Model picker source | single-registrant service hook, static Anthropic list | `llm-anthropic/src/plugin.ts:197` |
| Credential destination schema | `z.literal('anthropic')` | `credentials-admin-routes/src/destination-routes.ts:96` |
| Provider key admin surface | `STATIC_PROVIDERS` / `KNOWN_PROVIDERS` ×3, Anthropic only | see Task 7 |

An operator therefore cannot store an OpenRouter key, cannot select an OpenRouter
model, and — even if both were forced into the DB — the session would open with an
`api.anthropic.com`-only egress allow-list and the runner would die at boot on the
missing `ANTHROPIC_API_KEY`.

This PR makes the provider a **derived property of the agent's model ref** from end
to end, and adds OpenRouter as the second provider.

## Chosen approach

**One provider table in `@ax/core`, consumed on both sides of the sandbox boundary.**

The pairing *(provider id → base URL, egress host, credential env var, credential
ref)* is needed by the host (to decide what egress to permit and which credential to
mint) and by the runner (to decide where to dial and which env var holds the
placeholder). Today those two facts are hard-coded independently. A mismatch means
the runner dials a host the proxy denies — a failure mode with a terrible error
message.

`@ax/core` is the kernel every plugin already imports and already owns model-ref and
LLM vocabulary (`parseModelRef`, `LlmCallOutputSchema`). Putting the table there
makes host and runner agree by construction, and the deliberate independence that
matters for security — the host does not trust the runner's claim about where it is
dialing — is preserved because the *enforcement* still lives in the proxy's
allow-list check, not in the shared constant.

**`models:list-supported` becomes `models:list-supported:<provider>`**, mirroring the
existing `llm:call:<provider>` naming, because `HookBus.registerService` throws
`duplicate-service` on a second registrant (`core/src/hook-bus.ts:71`) and
`bootstrap.checkDuplicateRegisters` rejects it even earlier from the manifest. The
aggregation happens in the one caller, `GET /admin/agents/models`, over the provider
set named by the deployment's allow-list.

**The allow-list is authoritative for the picker; registrants supply metadata.**
OpenRouter serves 419 models (measured 2026-08-20) and churns weekly. A static
curated catalog intersected with the allow-list would make any model we did not
hardcode unselectable — which is the whole point of an aggregator. So the route now
also emits allow-listed refs no registrant covered, labelled with the bare model id.

---

## Global constraints

- **I₁ — no real credential in the sandbox.** Every provider entry passes `apiKey`
  explicitly from the proxy-minted `ax-cred:<32-hex>` placeholder; no provider SDK
  may perform its own auth discovery (design §6). New providers must be constructed
  with an explicit `fetch` routed through the credential proxy.
- **I₂ — the picker's authority is the operator's allow-list**, not our catalog.
- **I₃ — no silent provider fallback.** An unknown provider fails loudly at the
  earliest seam that can name it; there is never a "no slash means Anthropic" or
  "unknown provider means Anthropic" path.
- **I₄ — one source of truth for the provider pairing** (`PROVIDER_ENDPOINTS`).
- **I₅ — no capability regression for OpenRouter agents.** `memory-strata` routes
  `llm:call:${provider}` off the agent's own model ref (decision 2026-08-19); an
  OpenRouter agent without `llm:call:openrouter` silently loses fact extraction.

## Non-goals

- Vertex (PR 5), compaction (PRs 6–7).
- Collapsing the four duplicated provider/model catalogs into one. This PR adds
  OpenRouter to each and leaves the duplication (and its drift tests) intact;
  consolidating them is a follow-up card.
- Rewriting the first-run wizard's hardcoded `StepModel.MODELS`. Onboarding stays
  the Anthropic golden path.
- Fixing the k8s preset's dead `envFallback: { 'anthropic-api': … }` entry (the ref
  it keys is `provider:anthropic`, so the fallback never fires). Follow-up card.

---

## Tasks

### T1 — `@ax/core`: `PROVIDER_ENDPOINTS`

**Files:** `packages/core/src/providers.ts` (new), `packages/core/src/index.ts`,
`packages/core/src/__tests__/providers.test.ts` (new).

Add:

```ts
export interface ProviderEndpoint {
  id: string;              // first segment of a provider/model-id ref
  name: string;            // human label for admin surfaces
  description: string;     // one line for the Providers panel
  baseUrl: string;         // where the model call is made
  egressHost: string;      // hostname the sandbox allow-list must permit
  credentialEnvVar: string;// env var carrying the ax-cred placeholder
  credentialRef: string;   // credential-store ref
}
export const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>>;
export function providerEndpointFor(providerId: string): ProviderEndpoint | undefined;
```

Entries: `anthropic` (`https://api.anthropic.com/v1`, `api.anthropic.com`,
`ANTHROPIC_API_KEY`, `provider:anthropic`) and `openrouter`
(`https://openrouter.ai/api/v1`, `openrouter.ai`, `OPENROUTER_API_KEY`,
`provider:openrouter`).

**Tests (write first):** for every entry — `egressHost === new URL(baseUrl).host`;
`credentialRef === 'provider:' + id`; `id` is the record key; `credentialEnvVar`
matches `/^[A-Z][A-Z0-9_]*$/`; `baseUrl` is `https:`. These are the cross-checks that
make the single table trustworthy on both sides of the boundary.

**Load-bearing?** Yes — T5, T6, T7 all read it.

---

### T2 — runner-core: drop the Anthropic-specific env assert; rename `anthropicEnv`

**Files:** `packages/agent-runner-core/src/proxy-startup.ts`,
`packages/agent-runner-core/src/{python-venv,tty-hint-env}.ts`,
`packages/agent-runner-core/src/run-runner.ts`,
`packages/agent-claude-sdk-runner/src/{main,telemetry-env}.ts`,
`packages/agent-aisdk-runner/src/{main,provider}.ts`, plus the six test files that
name `anthropicEnv`.

Two changes:

1. **Move the assert to the runner that owns the requirement.** `setupProxy()` runs
   at `run-runner.ts:301`, *before* `session.get-config` at `:344` — so core cannot
   know the provider at that point and must not guess. Delete the unconditional
   `ANTHROPIC_API_KEY` requirement (`proxy-startup.ts:288-294`). Nothing is lost from
   the env map: the generic value-shape forward at `:272` already copies any
   `ax-cred:<32-hex>`-valued env var, including `ANTHROPIC_API_KEY`.

   Re-add the assert in `agent-claude-sdk-runner/src/main.ts`, immediately after the
   existing `modelProvider !== 'anthropic'` guard (`main.ts:216`) where `agentConfig`
   is in scope. That runner drives the Claude Agent SDK and always talks to
   Anthropic, so the requirement is genuinely its own.

   The aisdk runner needs no addition — `resolveModel` already asserts the
   placeholder shape for the *selected* provider's env var
   (`provider.ts:260-270`).

2. **Rename `ProxyStartup.anthropicEnv` → `providerEnv`** (and every local/parameter
   of that name). The map is the runner's provider-facing env; after this PR it can
   carry `OPENROUTER_API_KEY` and no Anthropic key at all. A mechanical rename —
   no behaviour change.

**Tests (write first):**
- `proxy-startup.test.ts`: a session whose only placeholder is `OPENROUTER_API_KEY`
  (no `ANTHROPIC_API_KEY` anywhere) returns a `providerEnv` containing it, and does
  **not** throw. This is the regression test for the boot failure.
- `agent-claude-sdk-runner` main test: a missing/malformed `ANTHROPIC_API_KEY`
  placeholder still fails the turn with a message naming `ANTHROPIC_API_KEY` and
  `ax-cred:<32-hex>` — i.e. the assert moved, it did not vanish.

**Load-bearing?** Yes — without (1) an OpenRouter-only session cannot boot.

---

### T3 — `models:list-supported:<provider>` + aggregation in the picker route

**Files:** `packages/llm-anthropic/src/plugin.ts` + its tests,
`packages/agents/src/admin-routes.ts` + tests.

1. `@ax/llm-anthropic` registers `models:list-supported:anthropic` (manifest
   `registers` updated). Payload/return shape unchanged.
2. `listModels` (`admin-routes.ts:600`) becomes:
   - derive the provider set from `deps.allowedModels` via `parseModelRef` (skip
     unparseable entries — `resolveAllowedModels` already rejects those at boot, so
     this is defence in depth, not a second policy);
   - for each provider with `bus.hasService('models:list-supported:' + p)`, call it;
   - merge, then intersect with the allow-list (first registrant wins on a duplicate
     id);
   - append any allow-listed ref no registrant covered as
     `{ id, label: id, kind: 'either' }`, preserving allow-list order.

**Boundary review (required — hook signature change):**
- *Alternate impl:* `@ax/llm-openrouter` (this PR), `@ax/llm-vertex` (PR 5), a
  local/offline model plugin.
- *Payload field names that might leak:* none. `{ id, label, kind }` — `id` is our
  own `provider/model-id` selection coordinate, not a vendor row id.
- *Subscriber risk:* none — it is a service hook with exactly one caller
  (`GET /admin/agents/models`), and it is called through `hasService`, so a preset
  loading no provider plugin still answers 200.
- *Wire surface:* not an IPC action. The HTTP response schema lives in `@ax/agents`.

**Tests (write first):**
- two stub registrants (`:anthropic`, `:openrouter`) → merged + intersected;
- an allow-listed ref with **no** registrant → present with `label === id`;
- a registrant for a provider absent from the allow-list is never called;
- ordering is allow-list order;
- no registrants at all → the allow-list, each entry `label === id` (this replaces
  the old "→ empty list" test; the change of semantics is deliberate and recorded
  in `decisions.md`).

**Load-bearing?** Yes — this is half of the PR's title.

---

### T4 — `@ax/llm-openrouter` (new plugin)

**Files:** `packages/llm-openrouter/**` (new), modelled on `@ax/llm-anthropic`.

Registers three services:

| Hook | Purpose |
|---|---|
| `models:list-supported:openrouter` | curated seed catalog (below) |
| `llm:call:openrouter` | host-side LLM for `memory-strata` / `conversation-titles` on an OpenRouter agent (I₅) |
| `credentials:validate:openrouter` | pre-save key check for the admin Providers panel |

- **Catalog seed** (verified against `GET https://openrouter.ai/api/v1/models`,
  2026-08-20): `x-ai/grok-4.6` (either), `moonshotai/kimi-k3` (either),
  `google/gemini-3.7-flash` (fast), `deepseek/deepseek-v4-pro` (default),
  `qwen/qwen3-max` (either), `openai/gpt-5.6-luna` (either). Ids are emitted as
  `openrouter/<slug>` refs. The seed is a *label source*, not a gate — T3's
  allow-list fallback covers everything else.
- **`llm:call:openrouter`**: `POST {baseUrl}/chat/completions` (OpenAI-compatible),
  `Authorization: Bearer <key>`, translating `LlmCallInput` → chat messages and the
  response → `LlmCallOutput` (normalising `finish_reason` into the existing small
  union, `unknown` for anything unmapped). Same one-shot transient retry policy as
  `@ax/llm-anthropic` (429/5xx). Credential via `credentials:get` on
  `provider:openrouter` when `credentialResolution` is set, else a constructor key.
  Returns `LlmCallOutputSchema` (the shared `@ax/core` schema).
- **`credentials:validate:openrouter`**: `GET {baseUrl}/key` with the Bearer key;
  200 → ok, 401/403 → invalid, else transient. 10 s abort, body discarded, key never
  logged — mirroring `provider-validator.ts:66-100`.
- `baseUrl` comes from `PROVIDER_ENDPOINTS.openrouter` (T1). No new runtime
  dependency: plain `fetch` + `zod`.

**Tests (write first):** manifest `registers` exactly the three hooks; catalog ids
are all valid `openrouter/<...>` refs; translate round-trips including a
`tool_calls` finish reason → `'tool_use'` and an unmapped reason → `'unknown'`;
retry fires once on 429 and not on 400; validate maps 200/401/500 correctly and
never puts the key in a thrown message.

**Load-bearing?** `models:list-supported:openrouter` and
`credentials:validate:openrouter` — yes. `llm:call:openrouter` — yes, per I₅: without
it, pinning an agent to OpenRouter silently kills its memory extraction, a
regression *this PR* introduces.

---

### T5 — orchestrator: model-derived proxy defaults

**Files:** `packages/chat-orchestrator/src/orchestrator.ts` + tests.

- `KNOWN_PROVIDERS` (`:75`) is derived from `PROVIDER_ENDPOINTS` instead of being a
  literal (export shape `{provider, name, slot, description}` unchanged so
  `ProvidersPanel.tsx`'s documented mirror still matches).
- The default pair at `:1863-1868` becomes model-derived:
  `parseModelRef(agent.model).provider` → `providerEndpointFor(...)` →
  `allowlist: [ep.egressHost]`, `creds: { [ep.credentialEnvVar]: { ref: ep.credentialRef, kind: 'api-key' } }`.
- An unknown provider (or an unparseable `agent.model`) terminates the turn with a
  new coarse reason `agent-model-provider-unknown`, via the existing
  `fireTurnError` + `chat:end` path — never a silent fall back to Anthropic (I₃).
- The all-or-nothing coupling of `agent.allowedHosts` / `agent.requiredCredentials`
  is untouched; only the *content* of the default branch changes.

**Tests (write first):** an `openrouter/x-ai/grok-4.6` agent opens the proxy session
with `allowlist: ['openrouter.ai']` and `credentials.OPENROUTER_API_KEY.ref ===
'provider:openrouter'`, and **no** `ANTHROPIC_API_KEY`; an `anthropic/...` agent is
byte-identical to today; an unknown provider terminates with the new reason and
fires a turn-error rather than opening a session.

**Load-bearing?** Yes.

---

### T6 — aisdk runner: OpenRouter provider + reasoning pruning

**Files:** `packages/agent-aisdk-runner/src/provider.ts`,
`packages/agent-aisdk-runner/src/main.ts`, `package.json`, tests.

- New dependency `@ai-sdk/openai-compatible`, **exact-pinned** (matching how `ai` and
  `@ai-sdk/anthropic` are pinned). It is Vercel-maintained and resolves the identical
  `@ai-sdk/provider@4.0.7` / `@ai-sdk/provider-utils@5.0.28` that
  `@ai-sdk/anthropic@4.0.40` already pulls, so it adds no new transitive tree.
- `PROVIDERS.openrouter`: `createOpenAICompatible({ name: 'openrouter', baseURL,
  apiKey, fetch })` — `baseURL` from `PROVIDER_ENDPOINTS` (T1), `apiKey` explicit,
  `fetch` the proxy dispatcher. `PROVIDERS.anthropic`'s hardcoded `ANTHROPIC_BASE_URL`
  and `credentialEnvVar` also move to the core table.
- `PROVIDER_ROADMAP` shrinks to Vertex/PR 5.
- **Reasoning pruning (design §6):** for a non-Anthropic provider, the messages sent
  to `agent.stream()` pass through
  `pruneMessages(messages, { reasoning: 'before-last-message' })`. Applied at the
  send site only — the persisted transcript is untouched, so resume and the host's
  `prefixHash` are unaffected.

**Tests (write first):**
- `resolveModel({ modelRef: 'openrouter/x-ai/grok-4.6', … })` resolves to a provider
  **object** (never a bare string — the existing "no gateway, no auth discovery"
  guard, extended to the new provider) with `modelId === 'x-ai/grok-4.6'`;
- the nested vendor slug and a `:free`/`:batch` variant suffix survive intact;
- the wire carries `Authorization: Bearer ax-cred:…` from `providerEnv`, never from
  `process.env` (decoys set, mirroring the existing Anthropic wire test), and the URL
  is pinned to `openrouter.ai`, ignoring any ambient base-URL env;
- a missing/malformed `OPENROUTER_API_KEY` throws naming that var;
- `vertex/...` still throws naming PR 5;
- pruning: a message array carrying reasoning parts is pruned for `openrouter` and
  passed through unchanged for `anthropic`.

**Load-bearing?** Yes.

---

### T7 — credentials admin surface for OpenRouter

**Files:** `packages/credentials-admin-routes/src/{destination-routes,providers-routes}.ts`,
`packages/credentials/src/refs-fixtures.ts`,
`packages/channel-web/src/components/admin/ProvidersPanel.tsx`, + the drift tests.

- `destination-routes.ts:96` — `provider: z.literal('anthropic')` widens to an enum
  over `Object.keys(PROVIDER_ENDPOINTS)`.
- `refs-fixtures.ts` gains a `provider:openrouter` fixture (this is the fixture all
  three `refForDestination` copies iterate, so it proves the SPA and route copies
  handle the new provider).
- `STATIC_PROVIDERS` gains an `openrouter` entry (bare model ids, per the existing
  comment about the fast-model tab's `${providerId}/${modelId}` join).
- `ProvidersPanel.tsx`'s `KNOWN_PROVIDERS` mirror gains the openrouter row.
  Deliberately still a mirror: `@ax/core` is imported today only by channel-web's
  **server** code, and pulling the kernel into the browser bundle to save six lines
  is a worse trade than the documented sync comment. Noted in `decisions.md`.

**Tests (write first):** POST a `{kind:'provider', provider:'openrouter'}`
destination → 200 and the row lands at ref `provider:openrouter`; the existing
fixture-driven drift tests cover the three `refForDestination` copies; a bogus
provider id is still rejected 400.

**Load-bearing?** Yes — without it there is no way to store the key.

---

### T8 — allow-list defaults, preset wiring, titles gate

**Files:** `packages/agents/src/store.ts`, `packages/cli/src/main.ts`,
`presets/k8s/src/index.ts` (+ `package.json`, `tsconfig.json`),
`packages/preset-k8s/src/__tests__/*`, `packages/cli/src/__tests__/*`.

- `DEFAULT_ALLOWED_MODELS` gains `openrouter/x-ai/grok-4.6` and
  `openrouter/moonshotai/kimi-k3` — the two models the PR's gate names, so the gate
  is reachable without editing config.
- **Half-wired policy:** `@ax/llm-openrouter` loads in **both** the CLI and the k8s
  preset in this PR. k8s loads it unconditionally with `credentialResolution: true`
  (matching how `@ax/llm-anthropic` loads there, so the picker and titles work off
  the DB credential); the CLI loads it behind `OPENROUTER_API_KEY`, matching its
  `@ax/llm-anthropic` gate.
- The k8s preset's `titles.model` guard (`index.ts:1141`) widens from
  `startsWith('anthropic/')` to "a provider this preset has a `llm:call:<provider>`
  registrant for", keeping the readable construction-time error.

**Tests:** preset/CLI plugin-list assertions include `@ax/llm-openrouter`; the
titles guard accepts `openrouter/...` and still rejects an unknown provider;
`resolveAllowedModels` still validates the new defaults as refs.

**Load-bearing?** Yes (invariant 3 — no half-wired plugins).

---

## Security checklist trigger

This PR touches credential handling, the sandbox egress allow-list, and adds a
runtime dependency inside the sandbox. Run `security-checklist` before Phase 4 and
put its structured note in the PR body. Points it must cover:

- explicit-injection: the new provider must never reach `process.env` for its key,
  and `createOpenAICompatible` must not be able to discover credentials on its own;
- egress: `openrouter.ai` is added only for agents whose model names it — an
  Anthropic agent's allow-list is unchanged;
- placeholder substitution is value-based and host-agnostic
  (`request-framer.ts:22`), so `Authorization: Bearer ax-cred:…` is substituted by
  existing code with no change — confirm with a test, do not assume;
- supply chain: `@ai-sdk/openai-compatible` pinned exactly, same publisher and same
  transitive versions as the already-vendored `@ai-sdk/anthropic`.

## Acceptance

1. `pnpm build && pnpm test` + lint green.
2. `ax-code-reviewer` clean on `main...HEAD`.
3. Parity: the aisdk runner's suite passes for both an `anthropic/` and an
   `openrouter/` model ref.
4. **Gate (post-merge, tracked separately):** a cluster walk with an agent pinned to
   `runner: aisdk`, `model: openrouter/x-ai/grok-4.6`, completing a real turn — plus
   the same for `openrouter/moonshotai/kimi-k3`. This needs a real OpenRouter key in
   the cluster, so it is a `(walk)` card, not a CI assertion.

## Follow-up cards (not this PR)

- Collapse the four provider/model catalogs (`PROVIDER_ENDPOINTS`, `STATIC_PROVIDERS`,
  `KNOWN_PROVIDERS` ×2, `StepModel.MODELS`) into one.
- k8s preset `envFallback` keys `'anthropic-api'`, but the ref in use is
  `provider:anthropic` — the fallback is dead code today.
- `(walk)` — cluster acceptance for grok-4.6 / kimi-k3 on the aisdk runner (the gate
  above), alongside the still-owed PR 3 `chat-qa-sweep` walk.
