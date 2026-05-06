# Auto-titled conversations — design

> Status: design (pre-plan). Implementation plan to follow via `writing-plans` skill.
>
> Canonical save location: `docs/plans/2026-05-06-auto-title-conversations-design.md`.

**Goal:** auto-generate a short title for each chat conversation on its first assistant turn, using a configurable LLM. Wire the existing-but-parked `@ax/conversation-titles` plugin into the k8s preset, replace its hardcoded haiku constant with typed plugin config, and establish a per-provider `llm:call:<provider>` hook-name convention so future LLM providers slot in without touching the titles plugin.

**Tech stack:** Node + TypeScript, vitest, `@ax/core` hook bus.

---

## Context

### Why this design

A conversation today opens with `title: null`, and there is no path that ever sets it for the goldenpath user. The plugin to generate one already exists (`@ax/conversation-titles`, `chat:turn-end` subscriber, `ifNull: true` writes via `conversations:set-title`), but it is currently:

- **Hardcoded** to `claude-haiku-4-5-20251001` in `packages/conversation-titles/src/plugin.ts:22`. Operators cannot pick a different model — even a different haiku version — without editing source.
- **Not loaded** by any production preset. The k8s preset's comment at `presets/k8s/src/index.ts:563-567` is explicit: "Auto-titling (@ax/conversation-titles) is NOT loaded here — it would require @ax/llm-anthropic with a separate ANTHROPIC_API_KEY". The acceptance test loads it; production does not.

The goldenpath kind deploy already plumbs `ANTHROPIC_API_KEY` into the host pod's env (`presets/k8s/src/index.ts:339` — for the `credentials` plugin's `envFallback`), so the operator-key concern that parked this plugin is a multi-tenant concern, not a single-tenant blocker. We can wire it up for the goldenpath today and defer the multi-tenant per-user-OAuth path to its own design.

### What stays the same

The behavioral contract of `@ax/conversation-titles` is preserved end to end:

- Subscribes to `chat:turn-end`; fires only when `role === 'assistant'`.
- Re-reads canonical transcript via `conversations:get` (does not trust subscriber payload for content).
- Auto-titles only on the **first** assistant turn (skips when `assistantTurnCount !== 1`).
- Writes via `conversations:set-title` with `ifNull: true` so a user-driven rename can never be clobbered.
- Validates model output through `validateGeneratedTitle` (strips quotes, rejects empty / `Untitled`, caps at 256 chars).
- Subscriber never throws — caught at the boundary, logged under `conversation_titles_subscriber_failed`.

### What this design changes

1. `@ax/llm-anthropic`: register `llm:call:anthropic` instead of `llm:call`.
2. `@ax/conversation-titles`: factory accepts typed config `{ model: 'provider/model-id' }`. Plugin parses and dispatches `llm:call:${provider}` with `model: modelId` in the payload.
3. `@ax/preset-k8s`: conditionally load `@ax/llm-anthropic` and `@ax/conversation-titles` together when `ANTHROPIC_API_KEY` is present in env. Add `K8sPresetConfig.titles?: { model?: string }` and `loadK8sConfigFromEnv` reads `AX_TITLE_MODEL`.
4. Helm chart: surface `titles.model` in `values.yaml`; render to `AX_TITLE_MODEL` env on the host pod.

### What this design does NOT change

- Multi-tenant deploys without a shared `ANTHROPIC_API_KEY` get no titles. Per-user OAuth-routed titling is its own future design.
- Manual retitling / regeneration. Today's "only auto-title once, on the first assistant turn" stays.
- Admin UI for managing the title-model setting at runtime — env-only; redeploy required to change. A "settings" UI is its own brainstorm (deferred).
- Per-call credential refs in `llm:call`. Today's init-time env read in `@ax/llm-anthropic` is preserved; per-feature billing keys are a future additive change.

---

## Five invariants check (CLAUDE.md)

- **I1 (storage- and transport-agnostic hook payloads):** `llm:call:<provider>` carries the same provider-agnostic `LlmCallInput` shape (`model`, `system`, `messages`, `maxTokens`, `temperature`). No backend-specific field names. The provider name lives in the **hook name**, not the payload — and is mapped from a config string the operator sets, not from any backend identifier.
- **I2 (no cross-plugin imports):** `@ax/conversation-titles` continues to mirror `@ax/conversations` types locally (`packages/conversation-titles/src/types.ts:1-70`). The model-config string is plain string; no new cross-plugin import.
- **I3 (no half-wired plugins):** the rename, the factory config, and the preset wiring all land in the same PR with their tests and the canary acceptance assertion. Nothing parked for "wire later".
- **I4 (one source of truth):** the title-model config has one home — `K8sPresetConfig.titles.model` (env-driven). The plugin's internal default (`'anthropic/claude-haiku-4-5-20251001'`) is the single fallback when the operator omits it.
- **I5 (capabilities explicit and minimized):**
  - `@ax/conversation-titles` capabilities unchanged: same hook bus access, same `bus.call` set (one rename), no new filesystem / network / spawn / env reach. Untrusted model output still flows through `validateGeneratedTitle` before reaching the database.
  - `@ax/llm-anthropic` capabilities unchanged.
  - `@ax/preset-k8s` reads one new env var (`AX_TITLE_MODEL`) — same env-reading posture it already has for `AX_RUNNER_BINARY`, `AX_CHAT_TIMEOUT_MS`, etc.

---

## Architecture

### Provider/model convention

Title-model configuration is a single string in the form `<provider>/<model-id>`. The plugin splits on the **first** `/`. Default: `anthropic/claude-haiku-4-5-20251001` (preserves today's behavior).

Splitting on the first `/` (not the only `/`) lets a future routing-style provider use values like `openrouter/anthropic/claude-3-5-sonnet` — `provider = 'openrouter'`, `modelId = 'anthropic/claude-3-5-sonnet'`. The provider plugin receives just the `modelId`; the prefix is the bus's responsibility.

```
'anthropic/claude-haiku-4-5-20251001'
   │       │
   │       └─ modelId  → llm:call:anthropic input { model: 'claude-haiku-4-5-20251001', ... }
   │
   └─ provider          → bus hook name 'llm:call:anthropic'
```

### Per-provider hook names

Today: `@ax/llm-anthropic` registers `llm:call`. One provider, one hook. Single consumer (`@ax/conversation-titles`).

After: `@ax/llm-anthropic` registers `llm:call:anthropic`. A future `@ax/llm-openai` registers `llm:call:openai`. A future `@ax/llm-router` could register a fan-out hook by any name it likes. Per-provider hook-name dispatch mirrors the existing `credentials:resolve:<kind>` precedent (`packages/credentials/src/plugin.ts:117`).

The kernel forbids two plugins from registering the same service-hook name; per-provider naming side-steps that by giving each provider its own slot.

### Conditional loading in the k8s preset

```
loadK8sConfigFromEnv(env):
  read AX_TITLE_MODEL → cfg.titles?.model (or omitted → plugin default)

createK8sPlugins(cfg):
  if env.ANTHROPIC_API_KEY is set:
    plugins.push(createLlmAnthropicPlugin())            // registers llm:call:anthropic
    plugins.push(createConversationTitlesPlugin({       // calls llm:call:<provider>
      model: cfg.titles?.model ?? 'anthropic/claude-haiku-4-5-20251001',
    }))
  else:
    skip both                                            // no title generation,
                                                         // conversations stay title: null
```

Both plugins load together (or neither). Loading `@ax/conversation-titles` without an `llm:call:anthropic` registrant would fail topo-sort at boot; loading `@ax/llm-anthropic` without titles is harmless but pointless. The conditional gates both on `ANTHROPIC_API_KEY` presence.

### Runtime path

Unchanged from today's plugin source except the dispatched hook name:

```
chat:turn-end (assistant, first)
   │
   ▼
@ax/conversation-titles subscriber
   │
   ├─ bus.call('conversations:get', ctx, { conversationId, userId })
   │     → if title !== null OR turns empty OR not first assistant turn → return
   │
   ├─ buildPrompt(turns)                                 // pure, transcript-budget capped
   │
   ├─ bus.call(`llm:call:${provider}`, ctx, { model: modelId, system, messages, ... })
   │     → @ax/llm-anthropic registrant uses ANTHROPIC_API_KEY from init
   │
   ├─ validateGeneratedTitle(text)                       // null on garbage, string on success
   │
   └─ bus.call('conversations:set-title', ctx, { ..., title, ifNull: true })
```

---

## Components and changes

| Package | Change | Notes |
|---|---|---|
| `@ax/llm-anthropic` | Rename registered hook `llm:call` → `llm:call:anthropic`. Update `manifest.registers` and the `PluginError.hookName` paths. | Mechanical rename in `plugin.ts` and tests. No version-compat shim — early-stage repo, no external consumers. |
| `@ax/conversation-titles` | Factory `createConversationTitlesPlugin(cfg?: { model?: string })`. Plugin parses `model` into `provider`/`modelId`, validates non-empty halves, computes manifest `calls: ['llm:call:${provider}', ...]` at factory time, and dispatches the same hook at runtime. Default `'anthropic/claude-haiku-4-5-20251001'`. | Factory-time validation throws `invalid-config` on bad shape (no slash, leading/trailing slash, empty). |
| `@ax/preset-k8s` | Add `K8sPresetConfig.titles?: { model?: string }`. Conditional load of `@ax/llm-anthropic` + `@ax/conversation-titles` when `env.ANTHROPIC_API_KEY` is set. Update the comment at line 563-567 to describe the new posture. | Single conditional; both plugins together or neither. |
| `loadK8sConfigFromEnv` | Read `AX_TITLE_MODEL`. Empty string → unset → plugin default. Non-empty → passed through verbatim. | Same shape as existing `AX_RUNNER_BINARY` / `AX_CHAT_TIMEOUT_MS` reads. |
| Helm chart | Add `titles.model` to `values.yaml`. Render to `AX_TITLE_MODEL` env in `templates/host/deployment.yaml`. | Default in chart values matches plugin default — existing deploys see no behavior change once `ANTHROPIC_API_KEY` is set. |

---

## Boundary review (CLAUDE.md required for hook-surface change)

### Change 1: rename `llm:call` → `llm:call:anthropic` (per-provider convention)

- **Alternate impl this hook could have:** any other LLM provider — `@ax/llm-openai`, `@ax/llm-gemini`, a self-hosted llama via `@ax/llm-local`, or a routing/budget-cap plugin like `@ax/llm-router`. Each lands as a sibling plugin registering its own `llm:call:<name>` hook.
- **Payload field names that might leak:** none. `LlmCallInput` is provider-agnostic (`model`, `system`, `messages`, `maxTokens`, `temperature`). `model` is the provider-local model id at this hop — every modern LLM API has a model-id concept.
- **Subscriber risk:** none. Service hook, not a subscriber hook. Kernel allows exactly one registrant per service-hook name.
- **Wire surface:** none. `llm:call:*` is host-internal. Runners reach Anthropic via the credential-proxy, not through this hook.

### Change 2: new `{ model: 'provider/model-id' }` config on `@ax/conversation-titles`

- Not a hook surface change — plugin factory config. `model` is non-secret. Parsed `provider` flows into the bus hook name (validated against the configured registrant indirectly: bad provider → kernel topo-sort error). `modelId` flows into the LLM call body. No path-handling, no process-spawn, no env reads beyond what the preset already does.

### Change 3: conditional plugin loading on `ANTHROPIC_API_KEY` presence in `@ax/preset-k8s`

- Internal preset wiring, not a hook surface change. When the var is absent, conversations stay `title: null` — same as today's behavior. The existing `envFallback` warn in `@ax/credentials` already surfaces the inverse case (var set but unused); we don't need a separate operator-visible warning for the silent-skip path.

---

## Test plan

### `@ax/llm-anthropic` (`packages/llm-anthropic/src/__tests__/plugin.test.ts`)
- Update existing `registers: ['llm:call']` assertion → `registers: ['llm:call:anthropic']`.
- Update the test that exercises the registered handler (currently `bus.call('llm:call', ...)`) → `bus.call('llm:call:anthropic', ...)`.
- No new cases — the rename is mechanical.

### `@ax/conversation-titles` (`packages/conversation-titles/src/__tests__/plugin.test.ts`)
- Existing tests: factory now takes config; pass `{ model: 'anthropic/claude-haiku-4-5-20251001' }` explicitly; stub `llm:call:anthropic` instead of `llm:call`.
- New: **manifest reflects configured provider.** `createConversationTitlesPlugin({ model: 'anthropic/...' })` produces a manifest whose `calls` includes `llm:call:anthropic`. Same factory with `{ model: 'openai/...' }` produces `calls: ['llm:call:openai', ...]`. Pure manifest assertion — no kernel needed.
- New: **dispatch hits the configured hook.** With `model: 'openai/gpt-4'`, the subscriber calls `llm:call:openai` and not `llm:call:anthropic`. Stub both registrants, assert which one fires.
- New: **invalid `model` config throws at init**, not at first turn. Cases: `'no-slash'`, `'trailing-slash/'`, `'/leading-slash'`, `''`. Each throws `invalid-config` from the plugin's parse step.
- New: **default applies when config omitted.** `createConversationTitlesPlugin()` with no arg uses `'anthropic/claude-haiku-4-5-20251001'`.

### `@ax/preset-k8s` (`presets/k8s/src/__tests__/preset.test.ts` and `acceptance.test.ts`)
- Static wiring: `loadK8sConfigFromEnv` with `ANTHROPIC_API_KEY` set + `AX_TITLE_MODEL=openai/foo` produces `cfg.titles.model === 'openai/foo'`. Empty string → defaults applied.
- Static wiring: `createK8sPlugins(cfg)` includes `@ax/llm-anthropic` + `@ax/conversation-titles` when env key is set; excludes both when unset.
- Static "shape" assertion: the conditionally-loaded titles plugin's manifest declares `calls: ['llm:call:anthropic', 'conversations:get', 'conversations:set-title']` — drift catcher.
- Acceptance test: the canary already imports `@ax/conversation-titles` directly. Add an assertion that after a chat turn lands, the conversation row's title becomes non-null. Use a stubbed `llm:call:anthropic` registrant for hermetic CI (no real Anthropic).

### Helm chart (`deploy/charts/ax-next/...`)
- Chart rendering test: `titles.model` from values renders to `AX_TITLE_MODEL` env on the host pod.

### `llm-mock` (`packages/llm-mock`)
- The package is a stub today (only `dist/` and `tsconfig.tsbuildinfo` survive). At implementation time, verify whether it has a working source path. If yes, parameterize its hook name to `llm:call:<provider>` so callers pick. If no, the acceptance test stubs `llm:call:anthropic` inline rather than reviving llm-mock for this slice.

---

## Risks and rollout

| Risk | Severity | Mitigation |
|---|---|---|
| Hook rename breaks an unknown consumer of `llm:call` | Low | Verified by grep: only `@ax/conversation-titles` calls it, only `@ax/llm-anthropic` registers it. CI's manifest assertions catch any stray reference. |
| Operator forgets `ANTHROPIC_API_KEY` after upgrading | Low | Existing behavior preserved: titles stay null. The chart's existing `envFallback` warn for the same var already surfaces partial-credential operator mistakes from the inverse direction. |
| Title model value typo (e.g., `claude-haku-4-5`) | Low | Anthropic API rejects with a 4xx; the existing `TRANSIENT_STATUSES` filter doesn't retry; the subscriber's try/catch logs `conversation_titles_subscriber_failed` (with model id, not prompt content — `@ax/conversation-titles` SECURITY.md forbids logging prompt-derived text). |
| `provider/model` parsing edge cases (Windows backslashes, URL-encoded values) | Very low | We split on `/` only. Backslashes pass through as part of the model id; Anthropic rejects. No URL decoding. Error messages echo the offending value for debugability. |
| First-turn LLM call adds latency to chat path | Already accepted | The subscriber fires asynchronously after `chat:turn-end`; not on the user-visible response path. |

**Rollout posture:** single PR. Both wirings (rename in `llm-anthropic`, factory config in `conversation-titles`, conditional load in `preset-k8s`) land together with their tests. Per CLAUDE.md invariant 3, no half-wired window.

---

## Out of scope (deferred designs)

- **Admin UI / chat-UI surface for managing credentials.** Bigger surface area: HTTP routes (`POST /admin/credentials` is already wire-pointed in preset comments as "Phase 9.5"), channel-web React UI, OAuth-in-browser handoff, list-without-leaking-payloads UX, per-user vs admin scoping, auth wiring. Benefits every plugin that needs a secret, not just titles. Its own brainstorm.
- **Per-user OAuth-routed titling.** Multi-tenant deploys without a shared host key. Requires extending the credential-proxy or `@ax/llm-anthropic` to resolve credentials per-call via `credentials:get`. Its own design when needed.
- **Per-call credential refs in `llm:call`.** Lets one provider plugin serve multiple billing identities (e.g., a budget-only Anthropic key for high-volume features, a primary key for chat). Additive to `@ax/llm-anthropic`'s init-time env read.
- **Manual retitling / regeneration.** A user-driven "regenerate this title" flow. Today's "first assistant turn only" stays.
- **Settings UI for title model.** Today's value is env-only; redeploy required to change. A runtime settings surface is part of the broader admin-UI brainstorm.

---

## Implementation plan

To be authored via the `superpowers:writing-plans` skill after this design is approved.
