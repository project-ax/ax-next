# Host-side runner + model selection — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR 2 of the provider-agnostic runner sequence. Make the admin model picker
drive a real value on the SDK runner, and add per-agent **runner** selection that
resolves host-side to a runner binary.

**Spec:** `docs/plans/2026-08-18-provider-agnostic-runner-design.md`, §1 (package
topology / host-side changes) and §6 (model, provider, credentials).
**Gate:** the admin model picker drives a real value on the SDK runner.

---

## The two problems

1. **`AgentConfig.model` is plumbed end-to-end and consumed by nobody.** It is
   validated against a per-agent allow-list (`packages/agents/src/store.ts:186,249,284`),
   stored (`migrations.ts:37`), frozen onto the session
   (`packages/chat-orchestrator/src/orchestrator.ts:1346`), shipped on the wire
   (`packages/ipc-protocol/src/actions.ts:460`) — and `@ax/agent-claude-sdk-runner`
   never passes `model:` to `query()`. The picker is decorative in both directions:
   its option list is a hardcoded array in `AgentForm.tsx:68-71`, and the value it
   writes changes nothing.
2. **Runner selection does not exist.** `runnerBinary` is a single global config
   string (`orchestrator.ts:89,620,2260`), defaulted in the CLI
   (`packages/cli/src/main.ts:114`) and the k8s preset
   (`presets/k8s/src/index.ts:99,337,893`).

---

## Global constraints

- **Model ids become `/`-prefixed** — `anthropic/claude-sonnet-4-6`,
  `openrouter/x-ai/grok-4.6`. Split on the **first** separator (AI SDK
  `createProviderRegistry(providers, { separator: '/' })` semantics) so nested vendor
  slugs survive. `/` not `:` because ~19% of OpenRouter slugs already use `:` for
  variants (`:free`, `:batch`).
- **No runtime "no slash means Anthropic" fallback.** Legacy bare ids are rewritten by
  migration. An implicit fallback re-introduces the ambiguity the prefix removes.
- **The `runner` value is an id, never a path.** The `agents` row, `AgentConfig`, and
  the IPC wire stay id-based; only `sandbox:open-session` carries a filesystem path,
  exactly as today. Keeping that boundary is the point of the change.
- **`'aisdk'` is rejected by validation until the runner exists** (PR 3). The type
  union names it; the allow-list does not contain it.
- **Invariant 2 — no cross-plugin imports.** `AgentConfig` is structurally duplicated
  in nine places by design; every copy is updated by hand. The shared model-ref parser
  goes in `@ax/core` (the kernel, which every plugin may import), not in a plugin.
- **Bug Fix Policy** — every bug fixed here gets a test that would have caught it.
- **Test command order:** `pnpm --filter <pkg> test`, never `pnpm test --filter <pkg>`.
- **Lint scoped to changed dirs:** `pnpm exec eslint <dirs>`; a repo-wide `pnpm lint`
  exits 1 from stale `.worktrees/` copies.
- **Known-bad locally, not ours:** `@ax/auth-better` (needs Docker for testcontainers)
  and a flaky Helm NetworkPolicy test under `deploy/charts/`. Note: `@ax/agents` and
  `@ax/session-postgres` tests DO use testcontainers and DO need Docker — Docker is
  available in this environment and those suites must pass.

### Scope boundary for the `/` prefix

The prefix applies to the **user-facing model-selection namespace** — values a human
picks and the system stores as an agent/deployment setting:

| In scope (becomes `provider/model-id`) | Out of scope (stays a bare id) |
|---|---|
| `agents_v1_agents.model` column | `LlmCallInput.model` (the `llm:call:*` hook input) |
| `AgentsConfig.allowedModels` / `AX_AGENT_MODELS_ALLOWED` | `llm-anthropic`'s `DEFAULT_MODEL` |
| `models:list-supported` ids | `memory-strata`'s `DEFAULT_ROLLUP_STAGE_B_MODEL` |
| the admin agent picker + onboarding wizard | `web-tools` / `validator-skill` internal model knobs |
| `settings:fast-model` (already prefixed today) | |

`settings:fast-model` already stores `anthropic/...` and
`@ax/conversation-titles` already parses it with a first-`/` split
(`packages/conversation-titles/src/plugin.ts:69-95`). That function is the existing
precedent; Task 1 promotes it to `@ax/core` so there is one implementation.

**Consequence to handle (Task 8):** `@ax/memory-strata` reads `agent.model` from
`agents:resolve` and passes it **verbatim** to `llm:call:anthropic`
(`plugin.ts:552`, `:775`), which passes it verbatim to the Anthropic SDK
(`llm-anthropic/src/translate.ts:25`). Once `agent.model` is prefixed, that sends
`anthropic/claude-sonnet-4-6` to the API. This is a real breakage introduced by this
PR and is fixed here, with a test.

---

## Boundary review (for the PR description)

Changed hook surfaces: `AgentConfig` (payload on `sandbox:open-session`,
`session:create`, `session:get-config`), `agents:create` / `agents:update` /
`agents:resolve` (new `runner` field), and a new admin HTTP route
`GET /admin/agents/models`.

- **Alternate impl this hook could have:** `agents:resolve` is already implemented
  twice — `@ax/agents` (Postgres-backed) and `@ax/cli`'s `dev-agents-stub` (in-memory,
  single-tenant). Both return the new `runner` id. `models:list-supported` has
  `@ax/llm-anthropic` today and an OpenRouter/Vertex registrant in PRs 4–5.
- **Payload field names that might leak:** none. `runner` carries an **id**
  (`'claude-sdk'`), not a binary path, module specifier, container image, or command
  line. The id → filesystem-path mapping lives entirely in host config
  (`ChatOrchestratorConfig.runnerBinaries`) and reaches the wire only on
  `sandbox:open-session.runnerBinary`, which already carried an absolute path before
  this change. Leak surface is unchanged. `model` is a `provider/model-id` ref — a
  vendor-neutral coordinate, not a URL, endpoint, or credential ref.
- **Subscriber risk:** a subscriber could key off `runner === 'claude-sdk'` to infer
  SDK-specific behaviour (e.g. "transcripts are jsonl under CLAUDE_CONFIG_DIR"). That
  is why the runner-visible contract stays the `TranscriptSource` interface from PR 1
  rather than the id. No shipped subscriber reads `runner`; the orchestrator's
  binary lookup is the only consumer, and it fails loudly on an unknown id.
- **Wire surface:** `AgentConfigSchema` lives in `packages/ipc-protocol/src/actions.ts`
  (IPC) and `packages/sandbox-protocol/src/schemas.ts` (sandbox), each in its own
  plugin's directory — no central file. Session backends validate the same shape
  independently.

---

## Task list

### Task 1: `parseModelRef` in `@ax/core`, one implementation

The `provider/model-id` split is needed by `@ax/agents` (validation),
`@ax/agent-runner-core` (runner-side), `@ax/memory-strata` (provider routing),
`@ax/onboarding` (wizard validation) and `@ax/conversation-titles` (already has a
copy). Invariant 2 forbids plugin↔plugin imports, but `@ax/core` is the kernel and
already owns LLM vocabulary (`LlmCallInput`/`LlmCallOutput`), so it is the correct
home. Invariant 4: one source of truth.

**Files:**
- Create: `packages/core/src/model-ref.ts`
- Create: `packages/core/src/__tests__/model-ref.test.ts`
- Modify: `packages/core/src/index.ts` (export)
- Modify: `packages/conversation-titles/src/plugin.ts` (delete the local
  `parseModelRef`, import from `@ax/core`)

**Interfaces:**
- Produces: `parseModelRef(ref: string): { provider: string; modelId: string }` —
  throws `PluginError({ code: 'invalid-payload' })` on empty input, no `/`, empty
  provider, or empty model id. Splits on the **first** `/`.
- Produces: `isModelRef(ref: string): boolean` — non-throwing predicate for validators
  that want to raise their own error text.

- [ ] **Step 1:** Write `packages/core/src/__tests__/model-ref.test.ts` first. Cases:
  `'anthropic/claude-sonnet-4-6'` → `{ provider: 'anthropic', modelId: 'claude-sonnet-4-6' }`;
  `'openrouter/x-ai/grok-4.6'` → `{ provider: 'openrouter', modelId: 'x-ai/grok-4.6' }`
  (**nested slug survives — this is the first-separator requirement**);
  `'openrouter/google/gemini-3.7-flash:batch'` → modelId keeps the `:batch` variant
  intact (**the reason `/` beat `:`**); throws on `''`, `'claude-sonnet-4-6'`,
  `'/model'`, `'provider/'`, `'   '`.
- [ ] **Step 2:** Implement `model-ref.ts` using `indexOf('/')` + `slice`, mirroring
  `packages/conversation-titles/src/plugin.ts:69-95`. Reference the design doc §6 in a
  header comment and state why the split is on the first separator.
- [ ] **Step 3:** Export from `packages/core/src/index.ts`.
- [ ] **Step 4:** Replace conversation-titles' local `parseModelRef` with the import.
  Keep its own error messages if its tests assert on them — if the tests fail, adapt
  the error text in `@ax/core` rather than keeping two implementations.
- [ ] **Step 5:** `pnpm --filter @ax/core test && pnpm --filter @ax/conversation-titles test`

---

### Task 2: `@ax/agents` — `runner` column, prefixed model allow-list, migrations

**Files:**
- Modify: `packages/agents/src/migrations.ts`
- Modify: `packages/agents/src/types.ts`
- Modify: `packages/agents/src/store.ts`
- Modify: `packages/agents/src/admin-routes.ts`
- Modify: `packages/agents/src/plugin.ts`
- Modify: `packages/agents/src/__tests__/{store,migrations,admin-routes,return-schemas}.test.ts`

**Interfaces:**
- Produces: `Agent.runner: RunnerId`, `AgentsRow.runner: string`, exported
  `SUPPORTED_RUNNERS`, `type RunnerId = 'claude-sdk' | 'aisdk'`.
- Consumes: `parseModelRef`/`isModelRef` from `@ax/core`.

- [ ] **Step 1 (tests first):** In `store.test.ts` add:
  - create with no `runner` defaults to `'claude-sdk'`;
  - `runner: 'aisdk'` throws `/not in the allow-list/` (**PR 3 flips this test**);
  - `runner: 'nope'` and `runner: 42` throw;
  - update patch validates `runner` the same way;
  - `model: 'claude-sonnet-4-6'` (bare) throws — it is not in the now-prefixed
    allow-list;
  - `resolveAllowedModels` throws a clear error when a configured/env entry is not a
    `provider/model-id` ref (fail fast on operator misconfiguration).
- [ ] **Step 2 (tests first):** In `migrations.test.ts` add two tests:
  - **runner backfill:** create the table via `runAgentsMigration`, `ALTER TABLE
    agents_v1_agents DROP COLUMN runner`, insert a row, re-run the migration, assert
    the row's `runner` is `'claude-sdk'`.
  - **model backfill:** insert a row with a bare `model` (`'claude-sonnet-4-6'`),
    re-run the migration, assert `model` is `'anthropic/claude-sonnet-4-6'`; insert a
    row with an already-prefixed model and assert re-running is a no-op (idempotent —
    no `anthropic/anthropic/...`).
- [ ] **Step 3:** `migrations.ts` — add, after the existing additive ALTERs:
  ```sql
  ALTER TABLE agents_v1_agents
    ADD COLUMN IF NOT EXISTS runner TEXT NOT NULL DEFAULT 'claude-sdk'
  ```
  and the idempotent legacy-model rewrite:
  ```sql
  UPDATE agents_v1_agents SET model = 'anthropic/' || model WHERE model NOT LIKE '%/%'
  ```
  Add `runner: string` to `AgentsRow`. Comment both with the design-doc reference.
- [ ] **Step 4:** `types.ts` — add `runner` to the `Agent` interface **and to
  `AgentSchema`**. `AgentSchema` is the `returns` schema on `agents:resolve`, and zod
  object schemas **strip undeclared keys** — omitting it silently drops `runner` before
  the orchestrator ever sees it. Add `allowedRunners?: readonly RunnerId[]` to
  `AgentsConfig` only if Step 5 decides to keep it (see the note there).
- [ ] **Step 5:** `store.ts`:
  - `export const SUPPORTED_RUNNERS = ['claude-sdk'] as const;` with a comment: the
    `RunnerId` union names `'aisdk'` but no binary exists until PR 3, so it is not
    accepted. **No config/env override** — an `AX_AGENT_RUNNERS_ALLOWED` escape hatch
    would let an operator select a runner with no binary behind it. (Deviation from
    "exactly as `model` is", logged in `decisions.md`.)
  - `validateRunner(value, allowed)` mirroring `validateModel` (same `invalid()` error
    shape, same `/not in the allow-list/` message).
  - `DEFAULT_ALLOWED_MODELS` → `['anthropic/claude-opus-4-7',
    'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5-20251001']`.
  - `resolveAllowedModels` — after resolving, assert every entry `isModelRef`; throw a
    `PluginError` naming the offending value and the expected `provider/model-id` shape.
  - `validateCreateInput`: `runner: validateRunner(input.runner ?? 'claude-sdk', SUPPORTED_RUNNERS)`.
  - `validateUpdatePatch`: validate `runner` when present.
  - Row deserialize / create result / PATCH set-clause / audit changed-field list: add
    `runner` everywhere `model` appears.
- [ ] **Step 6:** `admin-routes.ts` — add `runner` to `createBodySchema` (optional,
  defaults in the store) and `updateBodySchema` (optional), and to `serializeAgent`.
- [ ] **Step 7:** `pnpm --filter @ax/agents test` (needs Docker).

---

### Task 3: make the picker's option list real

`models:list-supported` is a correctly-typed service hook with **zero production
callers** — `AgentForm.tsx` hardcodes its own array instead. This task connects them
and prefixes the ids.

Multi-provider registrants are **out of scope**: `HookBus.registerService` is strictly
single-registrant (`packages/core/src/hook-bus.ts:71-77` throws `duplicate-service`),
and the design doc's Sequencing table assigns `models:list-supported` extension to
**PR 4**. This task makes the picker hook-driven; PR 4 makes it multi-provider.

**Files:**
- Modify: `packages/llm-anthropic/src/plugin.ts` (+ its tests)
- Modify: `packages/agents/src/admin-routes.ts`, `packages/agents/src/plugin.ts`
- Modify: `packages/agents/src/__tests__/admin-routes.test.ts`

- [ ] **Step 1:** `llm-anthropic/src/plugin.ts:192-201` — prefix the three ids with
  `anthropic/`. Update `__tests__/models-list.test.ts` and `plugin.test.ts`.
- [ ] **Step 2 (test first):** `admin-routes.test.ts` — `GET /admin/agents/models`
  returns only models present in **both** `models:list-supported` and the agents
  allow-list; returns `{ models: [] }` (200, not 500) when no provider plugin
  registered the hook.
- [ ] **Step 3:** Register `GET /admin/agents/models` in `registerAdminAgentRoutes`.
  Route ordering is safe: `Router.match` checks exact routes before `:param` patterns
  (`packages/http-server/src/router.ts:167-174`), so this cannot be shadowed by
  `GET /admin/agents/:id`. Handler: `bus.hasService('models:list-supported')` guard,
  then `bus.call`, then filter by `allowedModels`. Do **not** add
  `models:list-supported` to the plugin manifest's `calls` — `verifyCalls` enforces
  hard presence and would force every deployment to load `@ax/llm-anthropic`; use the
  `hasService` graceful-degrade pattern the plugin already documents for
  `teams:is-member` (`packages/agents/src/plugin.ts:70-76`).
- [ ] **Step 4:** `pnpm --filter @ax/llm-anthropic test && pnpm --filter @ax/agents test`

---

### Task 4: `AgentConfig.runner` across every wire copy

`AgentConfig` is structurally duplicated in nine places (Invariant 2 — no cross-plugin
imports). Two of them are zod schemas that **strip undeclared keys**, so a missed copy
loses the field silently rather than failing to compile.

**Files (all of them — this list is the task):**
- `packages/ipc-protocol/src/actions.ts:450-461` — zod `AgentConfigSchema`
- `packages/sandbox-protocol/src/schemas.ts:44-51` — zod `AgentConfigSchema`
- `packages/session-inmemory/src/types.ts:33` (interface) and `:279` (zod)
- `packages/session-inmemory/src/plugin.ts:131` (`requireString`) and `:191-198`
  (re-serialize — **the strip point**)
- `packages/session-postgres/src/plugin.ts:218` (zod), `:354` (`requireString`),
  `:413-421` (re-serialize)
- `packages/session-postgres/src/store.ts:28` (interface)
- `packages/sandbox-subprocess/src/open-session.ts:191` (interface)
- `packages/sandbox-k8s/src/open-session.ts:92` (interface)
- `packages/mcp-client/src/tool-dispatcher-plugin.ts:82` (interface)
- Synthetic constructors that build an `agentConfig` literal and will fail to compile:
  `packages/sandbox-k8s/src/user-files-ops.ts:522`,
  `packages/sandbox-subprocess/src/user-files-host-ops.ts:290`

- [ ] **Step 1 (tests first):** In `packages/session-inmemory` and
  `packages/session-postgres`, add a test that `session:create` **rejects** an
  `owner.agentConfig` missing `runner`, and one that a `session:get-config` round-trip
  returns the `runner` it was given. These are the tests that catch a zod strip.
- [ ] **Step 2:** Add `runner: z.string()` / `runner: string` to every site above.
  Type it as `z.string()` on the wire (not a zod enum) — the wire is a transport
  boundary, and the authoritative allow-list is `@ax/agents`; a second enum here would
  need editing in PR 3 for no safety gain.
- [ ] **Step 3:** `pnpm build` — tsc is the tool that finds the copies this list
  missed. Then run the affected suites:
  `pnpm --filter @ax/{ipc-protocol,sandbox-protocol,session-inmemory,session-postgres,sandbox-subprocess,sandbox-k8s,mcp-client} test`
  (session-postgres needs Docker).

---

### Task 5: `@ax/chat-orchestrator` — runner-id → binary map

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts`
- Modify: `packages/chat-orchestrator/src/__tests__/orchestrator.test.ts`

- [ ] **Step 1 (tests first):** In `orchestrator.test.ts`:
  - construct the plugin with `runnerBinaries: { 'claude-sdk': '/bin/a', 'aisdk': '/bin/b' }`,
    stub `agents:resolve` to return `runner: 'aisdk'`, and assert
    `lastSandboxInput.runnerBinary === '/bin/b'`. **This assertion must be able to
    fail** — verify it does by temporarily returning `'claude-sdk'`.
  - assert `lastSandboxInput.owner.agentConfig.runner === 'aisdk'` (extend the existing
    `toEqual` block at `orchestrator.test.ts:1060-1074`, which is exhaustive and will
    fail on an unexpected key — good).
  - an agent whose `runner` has no entry in the map fails the turn with an error naming
    the unknown runner id and the configured ids. Not a silent fallback to
    `'claude-sdk'`: a fallback would run an agent on a runner the operator did not
    select.
- [ ] **Step 2:** `ChatOrchestratorConfig.runnerBinary: string` →
  `runnerBinaries: Readonly<Record<string, string>>` (`orchestrator.ts:89`). Same on
  the internal `OpenSessionInput` — no, that one keeps `runnerBinary: string`
  (`:620`); it is the wire shape and stays a single resolved path.
- [ ] **Step 3:** `AgentRecord` (`orchestrator.ts:279-296`) gains `runner: string`;
  the frozen `agentConfig` (`:1332-1347`) gains `runner: agent.runner`.
- [ ] **Step 4:** `orchestrator.ts:2260` — `runnerBinary: config.runnerBinary` becomes
  a lookup keyed by `agent.runner`, throwing a `PluginError` on a miss.
- [ ] **Step 5:** `pnpm --filter @ax/chat-orchestrator test`

---

### Task 6: build the map — CLI, k8s preset, Helm values

Half-wired policy: both presets change in the same PR.

**Files:**
- Modify: `packages/cli/src/main.ts`, `packages/cli/src/dev-agents-stub.ts`
- Modify: `packages/cli/src/__tests__/main-options.test.ts`
- Modify: `presets/k8s/src/index.ts` (+ `presets/k8s/src/__tests__/`)
- Modify: `deploy/charts/ax-next/values.yaml`, `deploy/charts/ax-next/gke-values.yaml`

- [ ] **Step 1 (test first):** `main-options.test.ts` — rename/extend the three
  existing `resolveRunnerBinary` cases to `resolveRunnerBinaries`, asserting the
  returned map has a `'claude-sdk'` key and that `runnerBinaryOverride` /
  `AX_TEST_RUNNER_BINARY_OVERRIDE` set that key (override beats env, opts beats both).
- [ ] **Step 2:** `packages/cli/src/main.ts:114` — `resolveRunnerBinary` →
  `resolveRunnerBinaries(opts): Record<string, string>` returning
  `{ 'claude-sdk': <resolved> }`. Keep `requireFromCli.resolve('@ax/agent-claude-sdk-runner')`
  untouched — it resolves a real built artifact today and must keep doing so.
- [ ] **Step 3:** `dev-agents-stub.ts` — `runner: cfg.runner ?? 'claude-sdk'` on the
  returned agent, `DevAgentsStubConfig.runner?: string`, and the default model becomes
  `'anthropic/claude-sonnet-4-6'`.
- [ ] **Step 4:** `presets/k8s/src/index.ts` — `defaultRunnerBinary()` (`:99`) becomes
  `defaultRunnerBinaries()`; `K8sPresetConfig.chat.runnerBinary?` (`:337`) becomes
  `runnerBinaries?: Record<string, string>`; the orchestrator wiring (`:893`) merges
  defaults with the override; the env loader (`:1503-1505`) keeps `AX_RUNNER_BINARY`
  and maps it onto the `'claude-sdk'` key (documented in the JSDoc — one binary today,
  one key).
- [ ] **Step 5:** Helm — `deploy/charts/ax-next/values.yaml:624` and
  `gke-values.yaml:200` currently default `AX_AGENT_MODELS_ALLOWED` to
  `["claude-sonnet-4-5"]`. Prefix to `["anthropic/claude-sonnet-4-5"]`. Check the
  chart's render test for assertions on that value.
- [ ] **Step 6:** **Verify build output, not just the diff** (PR-1 lesson). After
  `pnpm build`, confirm the resolved runner path exists:
  `node -e "console.log(require.resolve('@ax/agent-claude-sdk-runner'))"` from
  `packages/cli`, and `ls` the result. Then grep the sandbox image's Dockerfile /
  chart for `AX_RUNNER_BINARY` to confirm nothing expected a scalar it no longer gets.
- [ ] **Step 7:** `pnpm --filter @ax/cli test && pnpm --filter @ax/preset-k8s test`
  (check the real package name) and the `deploy/charts` render test.

---

### Task 7: `@ax/agent-claude-sdk-runner` — consume `model`

**Files:**
- Modify: `packages/agent-runner-core/src/model-ref.ts` (new re-export shim) or import
  `@ax/core` directly — prefer the direct `@ax/core` import; runner-core already
  depends on `@ax/core`.
- Modify: `packages/agent-claude-sdk-runner/src/main.ts`
- Modify: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts`

- [ ] **Step 1 (test first):** `main.test.ts` — the fake `session.get-config` response
  (`:452-467`) returns `model: 'anthropic/claude-sonnet-4-7'`; assert
  `queryMock.mock.calls[0][0].options.model === 'claude-sonnet-4-7'` (**prefix
  stripped** — the SDK wants the raw Anthropic id). Add a second test: an agentConfig
  with `model: 'openrouter/x-ai/grok-4.6'` fails the turn with an error naming the
  unsupported provider — this runner drives Anthropic only, and silently ignoring the
  provider would run the wrong model.
- [ ] **Step 2:** In `main.ts`'s `query({ options: ... })` literal (starts at `:202`),
  add `model: <parsed modelId>`, parsing `agentConfig.model` with `parseModelRef` and
  rejecting `provider !== 'anthropic'`.
- [ ] **Step 3:** **Confirm the assertion can fail** — delete the `model:` line and
  re-run; the test must go red. (PR-1 lesson: three assertions were softened into
  conditionals that always passed.)
- [ ] **Step 4:** `pnpm --filter @ax/agent-claude-sdk-runner test`

---

### Task 8: downstream model-id producers and consumers

**Files:**
- Modify: `packages/onboarding/src/routes.ts`, `packages/onboarding/src/completion-tx.ts`
- Modify: `packages/channel-web/src/components/setup/StepModel.tsx`
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx`
- Modify: `packages/channel-web/src/server/routes-agent-bootstrap.ts`
- Modify: `packages/channel-web/mock/seed.ts`, `packages/channel-web/mock/admin/agents.ts`
- Modify: `packages/memory-strata/src/plugin.ts`
- Modify: `packages/credentials-admin-routes/src/providers-routes.ts`

- [ ] **Step 1 — onboarding double-prefix.** `completion-tx.ts:114` writes
  `model: input.defaultModel` (bare) while `:150-153` writes `settings:fast-model` as
  `` `anthropic/${input.fastModel}` ``. Make `/setup/model` take **fully-qualified
  refs for both**, validate with `isModelRef`, write both verbatim, and update the
  defaults at `routes.ts:241,243` to `anthropic/...`. **Test first:** a wizard run with
  prefixed inputs produces `settings:fast-model === 'anthropic/claude-haiku-...'`, not
  `'anthropic/anthropic/claude-haiku-...'`.
- [ ] **Step 2 — `AgentForm.tsx`.** Delete the hardcoded `MODELS` array (`:68-71`);
  fetch `GET /admin/agents/models` and render `{label}` with `{id}` as the value.
  Handle the empty/failed case with an existing shadcn `Alert` rather than an empty
  `<select>`. **Invoke the `shadcn` skill before editing** (invariant 6). No `runner`
  dropdown — one option is not a choice; the field is reachable via the admin route
  and lands in the UI in PR 3 when there are two.
- [ ] **Step 3 — the remaining bare defaults:** `StepModel.tsx:20-28`,
  `routes-agent-bootstrap.ts:16` (`DEFAULT_PERSONAL_AGENT_MODEL`), `mock/seed.ts`,
  `mock/admin/agents.ts`, `providers-routes.ts:55-57` (`STATIC_PROVIDERS[0].models`,
  which feeds the fast-model tab and must match the `settings:fast-model` ref shape).
- [ ] **Step 4 — `@ax/memory-strata` provider routing (the real bug).** **Test first:**
  an `agents:resolve` returning `model: 'anthropic/claude-sonnet-4-6'` must result in
  the `llm:call` receiving `model: 'claude-sonnet-4-6'` — assert on the input the
  registered `llm:call:anthropic` stub sees. Then fix `resolveAgent`
  (`plugin.ts:805-820`) to return the parsed ref, route to `llm:call:${provider}` when
  that service is registered, and degrade (return `undefined`, as the existing
  `hasService` gate already does) when it is not. Leave `DEFAULT_ROLLUP_STAGE_B_MODEL`
  bare — it is a fixed internal tier passed straight to `llm:call`, not an agent
  selection.
- [ ] **Step 5:** run the affected suites (`@ax/onboarding`, `@ax/channel-web`,
  `@ax/memory-strata`, `@ax/credentials-admin-routes`).

---

### Task 9: end-to-end proof (invariant 3)

**Files:**
- Modify: `packages/cli/src/__tests__/chat-pipeline.e2e.test.ts`
- Modify: `packages/test-harness/src/stub-runner.ts` (only if it needs to echo config)

- [ ] **Step 1:** In the library-mode e2e, register an observer/interceptor on
  `sandbox:open-session` and assert **all three** in one run: `runnerBinary` equals the
  `'claude-sdk'` entry of the configured map; `owner.agentConfig.runner === 'claude-sdk'`;
  `owner.agentConfig.model === 'anthropic/claude-sonnet-4-6'`.
- [ ] **Step 2:** Confirm the binary-mode canary (`packages/cli/src/__tests__/e2e.test.ts`)
  still passes unchanged — it drives the whole chain with the stub runner, so a broken
  map or a rejected model surfaces there as a non-zero exit.
- [ ] **Step 3:** `pnpm --filter @ax/cli test`

---

## Final gate

```bash
pnpm build
pnpm --filter @ax/agents test
pnpm --filter @ax/chat-orchestrator test
pnpm --filter @ax/agent-claude-sdk-runner test
pnpm --filter @ax/cli test
pnpm exec eslint <changed dirs>
```

Plus the suites each task names. Then a whole-branch `ax-code-reviewer` pass before the
PR opens.

## Deliberately deferred (follow-up cards)

- **Multi-provider `models:list-supported`** — `registerService` is single-registrant;
  PR 4 owns the extension per the design doc's Sequencing table.
- **A `runner` picker in the admin UI** — PR 3, when `'aisdk'` becomes selectable.
- **Consolidating the remaining hardcoded model lists** — `providers-routes.ts`'s
  `STATIC_PROVIDERS` and `StepModel.tsx` still carry their own arrays. This PR makes
  the *agent* picker hook-driven; the fast-model tab's list is a separate surface.
