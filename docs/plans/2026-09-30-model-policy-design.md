# Model policy — admin-selectable models (design)

**Status:** implemented on `feat/model-policy`; final verification and local acceptance recorded alongside this plan.
**Date:** 2026-09-30
**Skills used:** `superpowers:brainstorming`, `ux-design` (four lenses + house constraints).

## 1. Summary

An admin can choose, in the web UI, exactly which models people may use in their
agents. The admin sees every model from every configured provider (live), ticks the
ones to allow, marks one as the **Default**, searches as they type, and sees the
selected set. Agents that use a model the admin later removes keep running, on the
Default, from their next chat. Nothing changes until an admin saves.

### Goals

- Admin-only **Models** tab: searchable multi-select over the live catalog of all
  providers, a visible "Available to users" list, one Default.
- `@ax/agents` validates create/update against the saved selection and uses the
  Default for new agents.
- Agents on a no-longer-allowed model run on the Default, non-destructively and
  reversibly (resolved at chat time, never by rewriting the stored row).
- Every model an admin can make available actually runs: the runner is derived from
  the model.

### Non-goals

- The "Helper model" picker (`ModelConfigTab`) and onboarding's `models.default`.
- Per-team or per-user model limits; cost or price display.
- Letting people choose a runner by hand.
- Stopping chats that are already running (the swap applies at the next session).
- Eager migration (rewriting agent rows on save). Rejected in favour of lazy.

## 2. Decisions (from the brainstorm)

| # | Decision |
|---|----------|
| D1 | Catalog is **live from each provider** that has a stored key; cached; falls back to the short built-in list when a provider can't be reached. |
| D2 | Agents on a removed model are **moved to a fallback** (not kept, not blocked). |
| D3 | The fallback is an **admin-marked Default** among the selected models; it is also the pre-selected model for new agents. |
| D4 | Layout: **two panes** — all models (search + checkboxes, grouped by provider) and "Available to users" (Default radio + remove). |
| D5 | **Runner is derived from the model**: `anthropic/*` → `claude-sdk`, everything else → `aisdk`. |
| D6 | New plugin **`@ax/model-policy`** owns the policy and the catalog; `@ax/agents` consumes it. |
| D7 | The move is **lazy**: applied in `agents:resolve`, never written back. |

## 3. Starting state (verified before implementation, 2026-09-30)

- `@ax/agents` validates model choice against `allowedModels`, a **boot-time** value:
  `AgentsConfig.allowedModels` → env `AX_AGENT_MODELS_ALLOWED` → five built-ins
  (`packages/agents/src/store.ts`, `resolveAllowedModels`). `validateModel` checks
  membership only. The same list feeds `GET /admin/agents/models`
  (`admin-routes.ts` `listModels`), which `AgentForm.tsx` uses as its picker.
- There is **no "all models" source**. Providers expose only curated seeds through
  `models:list-supported:<provider>` (OpenRouter: 3–6 of ~419). Comments in
  `llm-openrouter/src/plugin.ts` call the seed "a label source, not a gate".
- `agents.runner` is a stored column defaulting to `claude-sdk`. Nothing derives it
  from the model, the SPA never shows or sets it, and the `claude-sdk` runner
  **throws on any non-Anthropic model ref** (`agent-claude-sdk-runner/src/main.ts`,
  `parseModelRef` provider check). So an OpenRouter model on a default agent fails
  every turn today. This feature would make hundreds of such models selectable,
  hence D5.
- Every chat goes through `agents:resolve` (`chat-orchestrator/src/orchestrator.ts`,
  ~line 1836); the orchestrator freezes `agent.model` into the session config and
  derives the provider endpoint from it (`parseModelRef(agent.model).provider`).
  That makes `agents:resolve` the single choke point for D7.
- Runtime admin settings precedent: `@ax/branding` stores `settings:branding` via
  `storage:get/set`; `@ax/admin-settings-routes` gates with `auth:require-user` and
  `isAdmin` (401 unauthenticated, 403 forbidden). `@ax/usage-limits` (TASK-692) is the
  precedent for "new plugin + admin tab".
- Admin UI: `AdminShell` + `AdminSidebar` tabs (`AdminTabId`). Installed shadcn
  primitives include `Card`, `Input`, `Checkbox`, `Collapsible`, `RadioGroup`,
  `Badge`, `Button`, `Alert`, `Skeleton`, `Empty`, `Dialog`, `Tooltip`.

## 4. Architecture

### 4.1 `@ax/model-policy` (new plugin, `packages/model-policy`)

Owns: the saved policy, the built-in fallback policy, the catalog aggregator and its
cache, and the admin routes.

**Hooks**

| Hook | Kind | Payload | Registered by | Called by |
|------|------|---------|---------------|-----------|
| `models:get-policy` | service | `{}` → `{ allowed: string[]; default: string; source: 'admin' \| 'builtin'; version: number }` | `@ax/model-policy` | `@ax/agents` and personal-agent bootstrap in `@ax/channel-web` (soft) |
| `models:list-available:<provider>` | service, per provider | `{}` → `{ status: 'live' \| 'no-key' \| 'error'; models: { ref: string; label: string }[] }` | provider plugins (`@ax/llm-anthropic`, `@ax/llm-openrouter`) | `@ax/model-policy` (soft, `bus.hasService`) |

Saving the policy and building the catalog are **internal functions** (their only
caller is this plugin's routes). No subscriber hook is added.

Dependency shape: `@ax/model-policy` calls `storage:get/set`, `auth:require-user`,
and (soft) `models:list-available:*` and `models:list-supported:*`. `@ax/agents`
calls `models:get-policy` **softly**; absent, it uses its own boot list. The
web personal-agent bootstrap also reads the Default softly, preserving its legacy
Sonnet fallback when the service is absent or unavailable. No call happens at init,
so there is no init-order cycle.

**Storage:** kernel storage key `settings:model-policy` (the `@ax/branding`
precedent), one JSON document:

```
{ "version": 3, "allowed": ["anthropic/claude-sonnet-4-6", ...],
  "default": "anthropic/claude-sonnet-4-6",
  "updatedAt": "2026-09-30T18:00:00.000Z", "updatedBy": "<userId>" }
```

**Built-in policy (nothing saved):** composition roots pass the same resolved list
to both plugins — `createModelPolicyPlugin({ builtinAllowed: resolveAllowedModels(cfg) })`
and `createAgentsPlugin({ allowedModels })` — so there is one source for the seed.
Default = `anthropic/claude-sonnet-4-6` if present, else the first entry.
`source: 'builtin'`, `version: 0`.

**Validation (`set`):** `allowed` non-empty and ≤ 1000; every entry passes `isModelRef`
(from `@ax/core`), ≤ 200 chars, no duplicates; `default ∈ allowed`; body ≤ 256 KiB;
`baseVersion` must equal the stored version (else 409). Membership in the live
catalog is **not** required (a model a provider has stopped listing stays valid).

**Concurrency:** `storage:set` has no compare-and-swap, so the `baseVersion` check is serialized inside the process (a promise chain around read-check-write). That is sufficient because the host is single-replica by design (the Helm chart refuses `replicas > 1`).

**Unreadable stored document:** `get-policy` logs an error and returns the built-in
policy (the pre-feature behaviour; failing closed would block every chat).

### 4.2 Catalog aggregation

For each provider that has `models:list-available:<provider>` registered, in
parallel, each with an 8 s timeout:

- `live` → cache `{ models, fetchedAt }` for 10 minutes.
- `no-key` → status `no-key`, no models.
- `error`/timeout → if a last-good cache exists, status `cached` with its
  `fetchedAt`; else fall back to `models:list-supported:<provider>` with status
  `fallback`; else `error`.

`?refresh=1` bypasses the cache, rate-limited to one forced refresh per provider per
15 s. Cache entries, in-flight reads and throttles are partitioned by authenticated
user and provider. A confirmed missing key clears the last-good list; a failed
refresh preserves the failure status. One provider failing never affects the others.

Hard limits per provider: response ≤ 5 MiB, ≤ 2000 models. Every `ref` must pass
`isModelRef` and start with `<provider>/`; every `label` is sanitised (see §7) and
capped at 120 chars, defaulting to the ref when empty. Offending entries are
dropped, not fatal.

Provider implementations (request shapes to be confirmed against current provider
docs at plan time; do not assume):

- `@ax/llm-openrouter`: list endpoint, refs `openrouter/<slug>`.
- `@ax/llm-anthropic`: list endpoint with the stored key, refs `anthropic/<id>`.

Each uses the plugin's existing host-side credential resolution (the path
`llm:call:<provider>` already uses) and fixed URLs. Keys are never returned or logged.

### 4.3 Admin routes (`@ax/model-policy`, admin-only)

All require `auth:require-user` with `isAdmin` (401 / 403); writes require the
`x-requested-with: ax-admin` header like the other admin routes.

| Route | Request | Response |
|-------|---------|----------|
| `GET /admin/models/catalog[?refresh=1]` | — | `{ providers: [{ id, name, status: 'live'\|'cached'\|'fallback'\|'no-key'\|'error', fetchedAt?, models: [{ ref, label }] }] }` |
| `GET /admin/models/policy` | — | `{ source, version, allowed, default, updatedAt?, updatedBy?, warning? }` — `warning: 'saved-policy-unreadable'` is set when the stored document could not be read and the built-in policy is being served |
| `PUT /admin/models/policy` | `{ baseVersion, allowed, default }` | `200` new policy · `400 { error, message }` · `409 stale-version` |

### 4.4 `@ax/agents` changes

1. **Policy source.** A small `getPolicy()` helper calls `models:get-policy` when the
   hook exists, else returns the boot list with the same default rule. It replaces
   the captured `allowedModels` constant in `createAgent`/`updateAgent` validation and
   in `listModels`.
2. **`GET /admin/agents/models`** adds `defaultModel` to its response; `AgentForm`
   pre-selects it for new agents.
3. **Runner rule** (`runnerForModel(ref)`: provider `anthropic` → `claude-sdk`, else
   `aisdk`):
   - create: `runner` omitted → derived; supplied and incompatible
     (`claude-sdk` with a non-Anthropic model) → `invalid-payload` with a plain
     message. `aisdk` with an Anthropic model is allowed.
   - update: changing `model` re-derives the runner unless a compatible `runner` is
     also supplied; changing only `runner` is validated against the current model.
4. **Lazy move in `agents:resolve`.** After the ACL check, if the row's model is not in
   the policy's `allowed`, the returned record carries `model = default`,
   `runner = runnerForModel(default)`, and `requestedModel = <stored model>`. A stored
   `claude-sdk` + non-Anthropic combination is also corrected in the returned record
   (this quietly fixes agents that fail today). **Nothing is written back.**
   Re-adding the model makes agents return to it on their own.
   - Risk (must be tested): `agents:resolve` also feeds `GET /admin/agents/:id`. An
     edit must never persist the swapped-in Default as the owner's choice. The form
     sends only changed fields, `updateAgent` reads the stored row (not the resolved
     record), and a dedicated test proves a save that doesn't touch the model leaves
     the stored model unchanged.
5. **Impact route** `POST /admin/agents/models/impact` (admin-only):
   `{ remove: string[] }` → `{ affected: [{ model, agentCount }] }`, counting stored
   agents by model across all owners (counts only, no identities). Used by the save
   confirmation. No new hook.
6. **Serialisation:** `serializeAgent` exposes `requestedModel` when present.

### 4.5 Wiring (no half-wired plugin)

The plugin is registered beside agents in `presets/k8s/src/index.ts` (+
`package.json` and TypeScript references), and in the plugin-name assertions of
the multi-tenant and production-bootstrap acceptance tests. The production canary
reads the policy and creates an agent on its Default. The memory preset inherits
the k8s composition. The CLI does not load agents.

### 4.6 Boundary review (new hooks)

- **`models:get-policy`** — alternate impl: a policy read from a remote policy
  service or a per-team table. Leaking fields: none (`provider/model-id` refs,
  provider-agnostic). Subscriber risk: none (service, two soft consumers). Wire surface:
  not an IPC action.
- **`models:list-available:<provider>`** — alternate impl: any further provider
  plugin (e.g. an OpenAI one). Fields `ref`, `label`, `status` are backend-neutral.
  Per-provider name because `registerService` is single-owner, mirroring
  `models:list-supported:<provider>` and `llm:call:<provider>`.

## 5. UI (`packages/channel-web`)

New admin tab **Models** (`AdminTabId` `'models'`, beside "AI model keys"). Files:
`components/admin/ModelsTab.tsx` (+ small subcomponents), `lib/models-admin.ts` (wire
client, `credentials: 'include'`, `x-requested-with: ax-admin` on writes), sidebar and
shell entries, and `AgentForm.tsx` changes. Only installed shadcn primitives and
semantic tokens; a plain `overflow-y-auto` container with a max height (no new
dependency, so no `scroll-area`). On compact screens, Settings navigation uses
the installed `Sheet` so the panes have the full available width.

**Header:** "Available models" / "Choose which models people can use when they
create or edit an agent." When `source === 'builtin'`: info `Alert` — "You're using
the built-in list. Nothing changes until you save." When the policy response carries
`warning: 'saved-policy-unreadable'`: warning `Alert` — "We couldn't read the saved
list, so we're using the built-in one for now. Saving will replace the saved list."

**Left pane — All models**
- `Input` (search icon; placeholder "Search by name or provider"). Filters
  **synchronously on every keystroke**, case-insensitively, over label, ref and
  provider name. Filters this pane only.
- Count line, `aria-live="polite"`: "12 of 431 models".
- Provider `Collapsible` groups with counts; groups with matches open while
  searching.
- Row: `Checkbox` + friendly name; the raw ref is in the row's native `title` (a Radix `Tooltip` on each of 400+ rows is too heavy).
- "Select all N shown" — rendered only while a search is active. It selects every
  model currently matching the search, including those in collapsed groups, and
  leaves already-selected models selected.

**Right pane — Available to users (N)**
- `RadioGroup` for the Default (chosen row gets a "Default" `Badge`); per-row remove
  button with an accessible name ("Remove Kimi K3").
- Helper text: "The Default is what new agents start with, and where an agent moves
  if its model is removed."
- Removing the Default makes the first remaining model the Default.
- `Empty`: "No models yet. Pick at least one on the left so people can create agents."
- Badges: "No longer listed" (provider stopped listing it), "Needs an API key" (its
  provider's status is `no-key`).

**Provider states (copy, in the project voice)**
- loading → `Skeleton` rows.
- `fallback`/`error` for one provider → "We couldn't reach OpenRouter just now, so
  we're showing a shorter list. [Try again]".
- `cached` → muted "Showing models from 10 minutes ago."
- `no-key` → "Add an API key to see OpenRouter's models." linking to "AI model keys".
- nothing loads → "We couldn't load the model list. Your current selection is safe.
  [Try again]".

**Footer (sticky):** Cancel · Save changes (disabled until changed) with "Unsaved
changes". Closing or reloading the page with unsaved changes asks first (the browser's own prompt). Switching to another admin tab does not ask yet: that needs the dirty flag lifted into `AdminShell`, which this design deliberately leaves to a follow-up.

**Save flow:** compute removed models = saved − draft. If any, call the impact route;
if `agentCount > 0` for any, show a `Dialog`: "Move 3 agents to Claude Sonnet 4.6?
You removed Kimi K3, and 3 agents use it. From their next chat they'll use Claude
Sonnet 4.6 instead. If you add Kimi K3 back, they switch back on their own." —
"Save and move them" / "Go back". Otherwise save directly and show "Saved."
Failures: "We couldn't save that. Nothing changed. [Try again]" (+ the reason when
known); 409: "Someone else just changed this list. Reload to see their version."

**Agent editor (owners):** when `requestedModel` is present, an `Alert`: "Your admin
changed the available models, so this agent is using Claude Sonnet 4.6 now. Pick a
different model to change it." The form sends only fields the user changed.

**Accessibility:** labelled checkboxes and radios, a real list structure, focus moved
sensibly after a remove, the live count, full keyboard operation, stacked panes on
narrow screens.

## 6. Errors and edge cases

| Case | Behaviour |
|------|-----------|
| Two admins save at once | `baseVersion` mismatch → 409 with the copy above |
| Saved policy unreadable | built-in policy, loud log, admin-visible warning |
| `@ax/model-policy` not loaded | `@ax/agents` uses its boot list (today's behaviour) |
| Selected model's provider has no key | "Needs an API key" badge; still savable |
| Provider stops listing a selected model | kept, "No longer listed" badge |
| Forced refresh spam | per-provider 15 s minimum interval |
| Chat already running | keeps its model until the session ends |
| Agent on `claude-sdk` + non-Anthropic (already broken) | corrected in `agents:resolve` output |
| Default removed | first remaining model becomes the Default |
| Policy has a model the catalog can't label | label shows the ref |

**Consumer audit (plan task, not assumed done):** every reader of an agent's model
must go through `agents:resolve`. Known: the orchestrator (session config and
provider endpoint). To check: routines/`agent:invoke` paths, usage-limits pricing, and
admin list/show serialisation.

## 7. Security review (project checklist)

- **Sandbox / capabilities.** New reach: the host makes HTTPS calls to two fixed
  provider model-list URLs (hosts the host already calls for `llm:call`). No
  caller-supplied URL or path. No filesystem paths handled. Keys come from the
  existing credential resolution and are never returned or logged. Routes are
  admin-gated server-side and CSRF-headed. The impact route returns counts only.
- **Untrusted content.** Provider responses are untrusted: refs validated with
  `isModelRef`, length-capped, and required to start with the provider id; labels
  stripped of control and bidirectional/invisible characters (reuse the precedent in
  `@ax/agents` display-name validation), capped, rendered as plain text only. Size,
  count and time limits per provider. Model refs never reach a shell, path, SQL or
  prompt; they are passed as the `model` parameter of the provider call, as today.
- **Supply chain.** No new dependencies (built-in `fetch`, existing `zod`, installed
  shadcn primitives, no `scroll-area`).

## 8. Testing (test-first; a bug or rule with no test does not merge)

- **Policy:** validation matrix (empty, duplicate, bad ref, default ∉ allowed, size
  caps), version conflicts, corrupt document fallback, built-in seed and default rule.
- **Catalog:** parallel fetch, per-provider timeout, partial failure, cache TTL and
  last-good, status mapping, forced-refresh rate limit, hostile ids and labels
  (bidi, newline, oversized, wrong provider prefix), entry and size caps.
- **Provider hooks:** stubbed `fetch` per provider (success, empty, non-200,
  oversized, malformed, no key).
- **`@ax/agents`:** validation via the policy and via the boot list when the plugin
  is absent; runner matrix (derived, explicit compatible, explicit incompatible →
  rejected, `aisdk` + Anthropic allowed); lazy swap and `requestedModel`; healing of
  `claude-sdk` + non-Anthropic; **a save that doesn't touch the model never persists
  the Default**; impact counts; serialisation.
- **Routes:** 401, 403, CSRF header, 400, 409, size limits.
- **UI (vitest + Testing Library):** the list updates on each keystroke with no
  delay; select/deselect; "Select all shown"; Default radio including removing the
  Default; dirty/save states; impact dialog; every provider state; empty states;
  keyboard and accessible names; owner notice in the agent editor.
- **Wiring:** plugin loaded in k8s preset, memory preset and CLI; canary reaches it.
- **Browser walk** on the `ax-next-dev` kind cluster (explicit `--context
  kind-ax-next-dev` on every cluster command): no-key state, live OpenRouter list,
  search, selection, Default, save with and without impact, owner notice.

## 9. Rollout

No schema migration. Behaviour is unchanged until an admin saves (the policy is the
built-in list, Default Sonnet). Expected side effect: agents already on a
non-Anthropic model with the `claude-sdk` runner start working on `aisdk`. Deploy is
the normal image build and Helm upgrade.

## 10. Open items — resolved during implementation

1. Provider list APIs confirmed against the vendor docs: Anthropic `GET /v1/models` (`x-api-key` + `anthropic-version: 2023-06-01`, `limit` up to 1000, `after_id` paging, `data[].id/display_name`); OpenRouter `GET /api/v1/models` (works unauthenticated, `data[].id/name`, ids may carry a `:variant` suffix).
2. The orchestrator and conversations resolve the agent before choosing a provider or runner. Runners read the frozen `agentConfig`, so the lazy swap covers chat.
3. The agent editor sends `model` only when changed. It fetches resolved agent details when editing, so the moved-model notice appears without rewriting stored rows; request generations protect newer drafts. Personal-agent bootstrap uses the policy Default, including when Sonnet is removed.
4. `presets/k8s` loads the policy plugin beside agents. `presets/memory` inherits that composition; the CLI has no agents and needs no change.
5. The `aisdk` runner supports both existing providers (`anthropic`, `openrouter`).
6. Tab icon `Layers`, placed right after "AI model keys".
7. Provider reads enforce the byte budget while streaming and reject redirects. Catalog reads share in-flight requests and throttle failed retries as well as successful refreshes, scoped to user identity. Policy cache generations prevent an old read from reversing a successful save.
8. Compact Settings navigation uses the installed Sheet. Browser acceptance covers Models at 1280 and 390 pixels in light and dark themes.
