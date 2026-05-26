# Auto-titled conversations — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Companion design doc:** `docs/plans/2026-05-06-auto-title-conversations-design.md`. Read that first for context, the boundary review, and out-of-scope decisions.
>
> **Canonical save location:** `docs/plans/2026-05-06-auto-title-conversations-plan.md`.

**Goal:** wire the existing-but-parked `@ax/conversation-titles` plugin into the k8s preset, replace its hardcoded haiku constant with a typed `provider/model` config (env-driven), and rename `llm:call` to `llm:call:anthropic` so future LLM providers slot in via `llm:call:<provider>` without touching the titles plugin.

**Architecture:** single PR. Atomic rename of `llm:call` → `llm:call:anthropic` lands together with the new `@ax/conversation-titles` factory config (so neither package sits in a broken state mid-PR). Preset gates the load of both plugins on `ANTHROPIC_API_KEY` presence — multi-tenant deploys without a shared host key see no behavior change (titles stay null), goldenpath kind deploys auto-title once per conversation.

**Tech stack:** Node + TypeScript, vitest, `@ax/core` hook bus, Helm (chart rendering tests).

---

## Context

Read `docs/plans/2026-05-06-auto-title-conversations-design.md` first. The design doc carries:

- Why `@ax/conversation-titles` exists but isn't loaded today (the preset comment at `presets/k8s/src/index.ts:563-567` is explicit).
- Why we're using per-provider hook names (`credentials:resolve:<kind>` precedent at `packages/credentials/src/plugin.ts:117`).
- Why we split `provider/model` on the **first** `/` (LiteLLM/OpenRouter convention; lets a future `openrouter/anthropic/claude-3-5-sonnet` work cleanly).
- Boundary review on the hook-surface change (CLAUDE.md required for service-hook signature changes).
- Out-of-scope items: admin UI, per-user OAuth-routed titling, per-call credential refs.

This plan is the executable form of that design.

---

## Five invariants check (CLAUDE.md)

- **I1 (storage- and transport-agnostic hook payloads):** `llm:call:<provider>` carries the same `LlmCallInput` shape (`model`, `system`, `messages`, `maxTokens`, `temperature`). The provider name lives in the hook name, not the payload. No backend-specific field names.
- **I2 (no cross-plugin imports):** `@ax/conversation-titles` continues to mirror `@ax/conversations` types locally (`packages/conversation-titles/src/types.ts`). The `model` config field is a plain string — no new cross-plugin import.
- **I3 (no half-wired plugins):** the rename + factory config + preset wiring all land in the same PR with their tests and the canary acceptance assertion. Slice 1 is a single atomic commit so no slice-boundary leaves the repo in a tests-failing state.
- **I4 (one source of truth):** the title-model config has one home — `K8sPresetConfig.titles.model` (env-driven via `AX_TITLE_MODEL`). The plugin's internal default (`'anthropic/claude-haiku-4-5-20251001'`) is the single fallback.
- **I5 (capabilities explicit and minimized):**
  - `@ax/conversation-titles` capabilities unchanged: same hook bus access, same `bus.call` set (one rename), no new filesystem / network / spawn / env reach. Untrusted model output still flows through `validateGeneratedTitle`.
  - `@ax/llm-anthropic` capabilities unchanged.
  - `@ax/preset-k8s` reads one new env var (`AX_TITLE_MODEL`) — same posture it has for `AX_RUNNER_BINARY`, `AX_CHAT_TIMEOUT_MS`, etc. The `ANTHROPIC_API_KEY` read in `loadK8sConfigFromEnv` ungates a config field the operator already supplies via the chart's Secret.

---

## File structure

Files touched by this plan, grouped by responsibility:

**Plugin layer**
- Modify: `packages/llm-anthropic/src/plugin.ts` — rename registered hook.
- Modify: `packages/llm-anthropic/src/__tests__/plugin.test.ts` — assertions on the new hook name.
- Modify: `packages/conversation-titles/src/plugin.ts` — factory takes config; manifest computed; runtime dispatch uses configured hook.
- Modify: `packages/conversation-titles/src/__tests__/plugin.test.ts` — pass explicit config in existing tests; add new cases.
- Modify: `packages/conversation-titles/src/index.ts` — re-export `parseModelRef` for tests + future consumers.

**Preset layer**
- Modify: `presets/k8s/src/index.ts` — add `K8sPresetConfig.titles?: { model?: string }`, conditional load of llm-anthropic + conversation-titles, env reading in `loadK8sConfigFromEnv`, comment update at line 563-567.
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (or equivalent static wiring test if the file is named differently) — assertions on config shape and conditional load.
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` — Phase F canary continues to pass after the rename; explicit factory config to make the test robust to default changes.

**Helm chart**
- Modify: `deploy/charts/ax-next/values.yaml` — add `titles.model` default.
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml` — render `AX_TITLE_MODEL` env from `.Values.titles.model`.
- Modify: `deploy/charts/ax-next/__tests__/env-shape.test.ts` — remove `ANTHROPIC_API_KEY` from `EXTERNAL_READERS` (preset now reads it).

No new files. All changes land in existing files.

---

## Slice plan

Each slice is a TDD-shaped commit boundary. The PR may rebase or squash at the end; commit-by-commit lands cleanly because each slice has its own tests passing.

### Slice 0 — Pre-flight (audit, no code)

Confirm assumptions before touching code.

- [ ] **Step 0a:** Run `pnpm test --filter @ax/llm-anthropic --filter @ax/conversation-titles --filter @ax/preset-k8s` and verify the existing tests pass on `main`. If they don't, this plan is blocked on a regression that isn't described here — STOP and surface the failure to the user.

- [ ] **Step 0b:** Confirm only one consumer of `llm:call` exists. Run:
  ```bash
  grep -rn "'llm:call'" packages/ presets/ landing/ container/ deploy/ \
    | grep -v "/dist/" | grep -v "/node_modules/" | grep -v "__tests__"
  ```
  Expected output: exactly two non-test references, both inside `packages/llm-anthropic/src/plugin.ts` and `packages/conversation-titles/src/plugin.ts`. If others appear, the rename has more callers than the design assumes — STOP.

- [ ] **Step 0c:** Confirm the chart-shape assumption. Read `deploy/charts/ax-next/__tests__/env-shape.test.ts:126-145`. Verify `ANTHROPIC_API_KEY` is in `EXTERNAL_READERS`. (Slice 4 removes it once the preset reads the var directly.)

**Commit:** none (planning slice).

---

### Slice 1 — Atomic rename + factory config

This slice is the contract flip. Every change in this slice lands in one commit so that no intermediate state has tests failing.

**Files (in change order — write tests first per slice, but here all four test files update together):**
- Modify: `packages/llm-anthropic/src/plugin.ts`
- Modify: `packages/llm-anthropic/src/__tests__/plugin.test.ts`
- Modify: `packages/conversation-titles/src/plugin.ts`
- Modify: `packages/conversation-titles/src/index.ts`
- Modify: `packages/conversation-titles/src/__tests__/plugin.test.ts`

#### Step 1a: Update `@ax/llm-anthropic` plugin tests to expect new hook name

Open `packages/llm-anthropic/src/__tests__/plugin.test.ts`. Replace every `'llm:call'` literal with `'llm:call:anthropic'`. The grep at `Slice 0 / Step 0b` showed the affected lines — they're at lines 52, 57, 95, 102, 112, 162, 176, 206, 229, 251, 261, 281, 291 (numbers may drift slightly).

For example, the manifest test at lines 52-57:
```typescript
it('declares registers: ["llm:call:anthropic"], no calls, no subscribes', () => {
  // ...
  expect(plugin.manifest).toMatchObject({
    registers: ['llm:call:anthropic'],
    // ...
  });
});
```

And every `bus.call(...)` / `bus.hasService(...)` / `PluginError` `hookName` reference flips from `'llm:call'` to `'llm:call:anthropic'`.

- [ ] Edit the test file. Save.

#### Step 1b: Update `@ax/llm-anthropic` plugin.ts

Open `packages/llm-anthropic/src/plugin.ts`. The plugin currently registers `'llm:call'` at lines 51, 74, and uses `hookName: 'llm:call'` in PluginError construction at line 104.

- [ ] Replace `registers: ['llm:call'],` (line 51) with `registers: ['llm:call:anthropic'],`.
- [ ] Replace the `bus.registerService<...>('llm:call', PLUGIN_NAME, ...)` call (line 74) with `bus.registerService<...>('llm:call:anthropic', PLUGIN_NAME, ...)`.
- [ ] Replace `hookName: 'llm:call'` (line 104) with `hookName: 'llm:call:anthropic'`.
- [ ] Run `pnpm test --filter @ax/llm-anthropic`. Expected: PASS.

#### Step 1c: Add `parseModelRef` and update `@ax/conversation-titles/src/plugin.ts`

Open `packages/conversation-titles/src/plugin.ts`. Make four changes:

1. Replace the `TITLE_MODEL` constant with a default reference and a parser.
2. Update the factory signature to accept config.
3. Compute the manifest's `calls` from the parsed provider.
4. Dispatch `llm:call:${provider}` at runtime with `model: modelId`.

The current constants at lines 22-27:
```typescript
const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_MAX_TOKENS = 32;
const TITLE_TEMPERATURE = 0.3;
```

become:
```typescript
const TITLE_MAX_TOKENS = 32;
const TITLE_TEMPERATURE = 0.3;

/**
 * Default `provider/model` reference — preserves today's hardcoded haiku.
 * Operators override via the preset's `AX_TITLE_MODEL` env var, which flows
 * through `K8sPresetConfig.titles.model` to the factory's `cfg.model`.
 */
export const DEFAULT_TITLE_MODEL = 'anthropic/claude-haiku-4-5-20251001';

export interface ConversationTitlesConfig {
  /**
   * Title-LLM model reference in the form `<provider>/<model-id>`.
   * Splits on the first `/`. Provider becomes the bus hook name suffix
   * (`llm:call:<provider>`); model-id flows into the call's `model` field.
   *
   * Default: `'anthropic/claude-haiku-4-5-20251001'`.
   */
  model?: string;
}

export interface ParsedModelRef {
  provider: string;
  modelId: string;
}

/**
 * Parse a `provider/model-id` reference. Splits on the FIRST `/` so a
 * future routing-style value like `openrouter/anthropic/claude-3-5-sonnet`
 * yields provider=`openrouter`, modelId=`anthropic/claude-3-5-sonnet`.
 *
 * Throws `PluginError({ code: 'invalid-config' })` on:
 *   - empty string
 *   - missing `/`
 *   - leading `/` (empty provider)
 *   - trailing `/` (empty model-id)
 *
 * The error message echoes the offending value to help operators debug
 * a typo in their env. Validation runs at factory time — bad config is a
 * deploy-time bug, not a first-turn surprise.
 */
export function parseModelRef(ref: string): ParsedModelRef {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `model must be 'provider/model-id' (got empty value)`,
    });
  }
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `model must be 'provider/model-id' (got: ${ref})`,
    });
  }
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}
```

Note: `PluginError` is imported from `@ax/core` — add it to the existing import list at the top of the file.

The factory signature changes from `createConversationTitlesPlugin(): Plugin` to `createConversationTitlesPlugin(cfg: ConversationTitlesConfig = {}): Plugin`. Inside the factory, parse the model ref and compute the hook name:

```typescript
export function createConversationTitlesPlugin(
  cfg: ConversationTitlesConfig = {},
): Plugin {
  const ref = cfg.model ?? DEFAULT_TITLE_MODEL;
  const { provider, modelId } = parseModelRef(ref);
  const llmCallHook = `llm:call:${provider}`;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [],
      calls: [llmCallHook, 'conversations:get', 'conversations:set-title'],
      subscribes: ['chat:turn-end'],
    },
    async init({ bus }) {
      bus.subscribe<TurnEndPayload>(
        'chat:turn-end',
        PLUGIN_NAME,
        async (ctx, payload) => {
          try {
            await handleTurnEnd(bus, ctx, payload, { llmCallHook, modelId });
          } catch (err) {
            // ... existing catch block unchanged ...
          }
          return undefined;
        },
      );
    },
  };
}
```

The `handleTurnEnd` helper signature gains a third arg:

```typescript
async function handleTurnEnd(
  bus: HookBus,
  ctx: AgentContext,
  payload: TurnEndPayload,
  cfg: { llmCallHook: string; modelId: string },
): Promise<void> {
  // ... existing body unchanged until the bus.call(...) line ...
  const llmOut = await bus.call<LlmCallInput, LlmCallOutput>(
    cfg.llmCallHook,
    ctx,
    {
      model: cfg.modelId,
      maxTokens: TITLE_MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      temperature: TITLE_TEMPERATURE,
    },
  );
  // ... rest of body unchanged ...
}
```

- [ ] Edit `packages/conversation-titles/src/plugin.ts` per the above. Save.

#### Step 1d: Re-export `parseModelRef` and `DEFAULT_TITLE_MODEL` from the package index

Open `packages/conversation-titles/src/index.ts`. Append exports for the new symbols:

```typescript
export { buildPrompt } from './prompt.js';
export type { BuiltPrompt } from './prompt.js';
export { validateGeneratedTitle } from './validate.js';
export {
  createConversationTitlesPlugin,
  parseModelRef,
  DEFAULT_TITLE_MODEL,
} from './plugin.js';
export type {
  ConversationTitlesConfig,
  ParsedModelRef,
} from './plugin.js';
```

- [ ] Edit the file. Save.

#### Step 1e: Update existing `@ax/conversation-titles` tests to use the new factory shape

Open `packages/conversation-titles/src/__tests__/plugin.test.ts`. Three categories of update:

1. **Mock bus stubs**: replace every `bus.registerService<...>('llm:call', ...)` with `bus.registerService<...>('llm:call:anthropic', ...)`. The fixture in `makeStubsBus()` at line 70 is the central one.

2. **Manifest test (lines 143-154)**: update the `calls` array and pass an explicit factory config so the test pins the convention rather than the default.

   ```typescript
   describe('@ax/conversation-titles plugin manifest', () => {
     it('declares no registers, three calls (with configured provider hook), one subscribe', () => {
       const plugin = createConversationTitlesPlugin({
         model: 'anthropic/claude-haiku-4-5-20251001',
       });
       expect(plugin.manifest).toEqual({
         name: '@ax/conversation-titles',
         version: '0.0.0',
         registers: [],
         calls: [
           'llm:call:anthropic',
           'conversations:get',
           'conversations:set-title',
         ],
         subscribes: ['chat:turn-end'],
       });
     });
   });
   ```

3. **No-arg factory call sites**: every `createConversationTitlesPlugin()` invocation in this file (lines 145, 163, 190, 203, 220, 237, 262, 316, 345, 397, 425, 470 — verify with grep) keeps working because the factory accepts no-arg. No change needed for those.

- [ ] Edit the test file. Save.

#### Step 1f: Add new `@ax/conversation-titles` test cases

Append the following describe blocks to the same test file (append at the bottom, after the existing blocks):

```typescript
describe('@ax/conversation-titles parseModelRef', () => {
  it('splits on the first slash', () => {
    expect(parseModelRef('anthropic/claude-haiku-4-5-20251001')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    });
  });

  it('splits routing-style values on the FIRST slash only', () => {
    expect(parseModelRef('openrouter/anthropic/claude-3-5-sonnet')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-3-5-sonnet',
    });
  });

  it.each([
    ['empty', ''],
    ['no-slash', 'no-slash'],
    ['leading-slash', '/leading'],
    ['trailing-slash', 'trailing/'],
  ])('throws invalid-config on %s', (_label, ref) => {
    expect(() => parseModelRef(ref)).toThrowError(PluginError);
  });
});

describe('@ax/conversation-titles factory config', () => {
  it('produces a manifest with the configured provider hook (anthropic)', () => {
    const plugin = createConversationTitlesPlugin({
      model: 'anthropic/claude-haiku-4-5-20251001',
    });
    expect(plugin.manifest.calls).toEqual([
      'llm:call:anthropic',
      'conversations:get',
      'conversations:set-title',
    ]);
  });

  it('produces a manifest with a different provider hook when configured', () => {
    const plugin = createConversationTitlesPlugin({ model: 'openai/gpt-4' });
    expect(plugin.manifest.calls).toEqual([
      'llm:call:openai',
      'conversations:get',
      'conversations:set-title',
    ]);
  });

  it('uses the default model when cfg.model is omitted', () => {
    const plugin = createConversationTitlesPlugin();
    expect(plugin.manifest.calls).toContain('llm:call:anthropic');
  });

  it('throws invalid-config at factory time on bad model', () => {
    expect(() => createConversationTitlesPlugin({ model: 'no-slash' })).toThrowError(PluginError);
  });
});

describe('@ax/conversation-titles dispatches the configured provider hook', () => {
  it('calls llm:call:openai when configured for openai', async () => {
    const stubs = makeStubsBus();
    // makeStubsBus registers llm:call:anthropic by default. Add an openai
    // stub so the configured provider has a registrant.
    const openaiCalls: LlmCallInput[] = [];
    stubs.bus.registerService<LlmCallInput, LlmCallOutput>(
      'llm:call:openai',
      'mock-openai',
      async (_ctx, input) => {
        openaiCalls.push(input);
        return {
          text: 'OpenAI Title',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    stubs.setGetResult({
      conversation: makeConversation({ title: null }),
      turns: [
        turn('user', [{ type: 'text', text: 'hi' }]),
        turn('assistant', [{ type: 'text', text: 'hello' }]),
      ],
    });

    const plugin = createConversationTitlesPlugin({ model: 'openai/gpt-4' });
    await plugin.init({ bus: stubs.bus, config: {} } as never);

    await stubs.bus.fire('chat:turn-end', makeCtx({ conversationId: 'c1' }), {
      role: 'assistant',
    });

    expect(openaiCalls.length).toBe(1);
    expect(openaiCalls[0].model).toBe('gpt-4');
    expect(stubs.llmCalls.length).toBe(0); // anthropic hook not called
  });
});
```

Note: the `init` call in the dispatch test passes `{ bus, config: {} }` — match the actual `Plugin.init` signature in `@ax/core`. If the existing tests use a different shape (e.g., a helper like `bootstrap`), copy that pattern.

- [ ] Edit the test file. Save.

#### Step 1g: Run all tests in this slice; confirm pass

```bash
pnpm test --filter @ax/llm-anthropic --filter @ax/conversation-titles
```

Expected: ALL tests PASS, including the new cases.

If anything fails, fix the failing test/source before proceeding. Do not move to Slice 2 with red tests.

#### Step 1h: Commit

```bash
git add packages/llm-anthropic packages/conversation-titles
git commit -m "$(cat <<'EOF'
feat(llm-anthropic, conversation-titles): per-provider llm:call:<provider> hooks

Renames @ax/llm-anthropic's registered hook llm:call -> llm:call:anthropic
and makes @ax/conversation-titles' factory accept { model: 'provider/model-id' }
config. Plugin parses on first `/`, computes the manifest's `calls` from the
provider, and dispatches `llm:call:${provider}` at runtime. Default preserves
today's behavior: 'anthropic/claude-haiku-4-5-20251001'.

Mirrors the existing credentials:resolve:<kind> precedent. Single PR atomic
commit so no intermediate state has tests failing (CLAUDE.md invariant 3).

Companion design: docs/plans/2026-05-06-auto-title-conversations-design.md.
EOF
)"
```

- [ ] Run the commit. Expected: commit lands; pre-commit hooks pass.

---

### Slice 2 — `K8sPresetConfig.titles` field + env reader

Add the typed config field and the env-reading path. No conditional load yet; plugins are still off in production.

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (or whichever file holds the static `loadK8sConfigFromEnv` tests — verify by `ls presets/k8s/src/__tests__/`)

#### Step 2a: Write failing tests for `loadK8sConfigFromEnv` reading `AX_TITLE_MODEL`

Open the static-wiring test file. Append a describe block:

```typescript
describe('loadK8sConfigFromEnv — titles', () => {
  function baseEnv(): NodeJS.ProcessEnv {
    return {
      DATABASE_URL: 'postgres://stub:5432/stub',
      AX_K8S_HOST_IPC_URL: 'http://stub.svc.cluster.local:80',
      AX_HTTP_HOST: '127.0.0.1',
      AX_HTTP_PORT: '0',
      AX_HTTP_COOKIE_KEY: '0'.repeat(64),
      AX_DEV_BOOTSTRAP_TOKEN: 'test-bootstrap',
      AX_WORKSPACE_BACKEND: 'local',
      AX_WORKSPACE_ROOT: '/tmp/ax-test',
    };
  }

  it('omits cfg.titles when ANTHROPIC_API_KEY is unset', () => {
    const cfg = loadK8sConfigFromEnv(baseEnv());
    expect(cfg.titles).toBeUndefined();
  });

  it('sets cfg.titles with the default model when ANTHROPIC_API_KEY is set and AX_TITLE_MODEL is unset', () => {
    const cfg = loadK8sConfigFromEnv({
      ...baseEnv(),
      ANTHROPIC_API_KEY: 'sk-ant-stub',
    });
    expect(cfg.titles).toEqual({ model: 'anthropic/claude-haiku-4-5-20251001' });
  });

  it('respects AX_TITLE_MODEL when set', () => {
    const cfg = loadK8sConfigFromEnv({
      ...baseEnv(),
      ANTHROPIC_API_KEY: 'sk-ant-stub',
      AX_TITLE_MODEL: 'anthropic/claude-sonnet-4-7',
    });
    expect(cfg.titles).toEqual({ model: 'anthropic/claude-sonnet-4-7' });
  });

  it('treats empty AX_TITLE_MODEL as unset (defaults applied)', () => {
    const cfg = loadK8sConfigFromEnv({
      ...baseEnv(),
      ANTHROPIC_API_KEY: 'sk-ant-stub',
      AX_TITLE_MODEL: '',
    });
    expect(cfg.titles).toEqual({ model: 'anthropic/claude-haiku-4-5-20251001' });
  });
});
```

If the test file doesn't import `loadK8sConfigFromEnv`, add it:

```typescript
import { loadK8sConfigFromEnv } from '../index.js';
```

- [ ] Edit the test file. Save.

#### Step 2b: Run new tests; confirm fail

```bash
pnpm test --filter @ax/preset-k8s -t "loadK8sConfigFromEnv — titles"
```

Expected: FAIL with `cfg.titles` undefined or property doesn't exist on `K8sPresetConfig`.

#### Step 2c: Add `K8sPresetConfig.titles` field

Open `presets/k8s/src/index.ts`. After the existing `chat?:` field on `K8sPresetConfig` (around line 215-219), add:

```typescript
  /**
   * Auto-titling config. When present, the preset loads @ax/llm-anthropic
   * and @ax/conversation-titles; conversations get a one-line title written
   * after the first assistant turn (`ifNull: true`, never clobbers a user
   * rename). When absent, titles stay null — same as today's behavior.
   *
   * `model` uses the `<provider>/<model-id>` convention; the titles plugin
   * splits on the first `/` and dispatches `llm:call:${provider}`. Default:
   * `'anthropic/claude-haiku-4-5-20251001'`.
   *
   * `loadK8sConfigFromEnv` populates this field iff `ANTHROPIC_API_KEY` is
   * present in the env; otherwise it leaves the field undefined (multi-
   * tenant deploys without a shared host key opt out cleanly).
   */
  titles?: {
    model?: string;
  };
```

- [ ] Edit the file. Save.

#### Step 2d: Add the `AX_TITLE_MODEL` read in `loadK8sConfigFromEnv`

In the same file, find `loadK8sConfigFromEnv` (around line 722). Locate the section that builds the final `config` object (around line 877-918).

Add a section right before the `return config;` line:

```typescript
  // ---- titles (auto-titling subscriber) -----------------------------------
  // Gated on ANTHROPIC_API_KEY presence: multi-tenant deploys without a
  // shared host key get no auto-titling, same as today. When the key IS
  // set, the preset loads @ax/llm-anthropic + @ax/conversation-titles and
  // titles get a one-line summary after the first assistant turn.
  if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== '') {
    const titleModelRaw = env.AX_TITLE_MODEL;
    const titleModel =
      titleModelRaw === undefined || titleModelRaw === ''
        ? 'anthropic/claude-haiku-4-5-20251001'
        : titleModelRaw;
    config.titles = { model: titleModel };
  }
```

The default constant duplicates `DEFAULT_TITLE_MODEL` from `@ax/conversation-titles`. Per CLAUDE.md invariant I2 (no cross-plugin imports) we don't import it; per I4 (one source of truth) we keep them in lockstep. Add a comment that mirrors how `presets/k8s/src/index.ts` handles other duplicated constants (e.g., `parseCookieKeyString`).

- [ ] Edit the file. Save.

#### Step 2e: Run the new tests; confirm pass

```bash
pnpm test --filter @ax/preset-k8s -t "loadK8sConfigFromEnv — titles"
```

Expected: PASS.

#### Step 2f: Run the full preset test suite; confirm no regression

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: PASS. (The acceptance test still works because `createK8sPlugins` doesn't yet read `cfg.titles` — that's Slice 3.)

#### Step 2g: Commit

```bash
git add presets/k8s
git commit -m "$(cat <<'EOF'
feat(preset-k8s): add K8sPresetConfig.titles field + AX_TITLE_MODEL env read

Adds the typed `titles?: { model?: string }` config field and wires
loadK8sConfigFromEnv to populate it when ANTHROPIC_API_KEY is present.
Conditional load of the conversation-titles plugin lands in the next
slice; this slice is data-only.

Default `model`: 'anthropic/claude-haiku-4-5-20251001' (matches the
@ax/conversation-titles default; documented as duplicated per CLAUDE.md
invariant I2).
EOF
)"
```

- [ ] Run the commit. Expected: commit lands; hooks pass.

---

### Slice 3 — Conditional load of llm-anthropic + conversation-titles

This slice closes the loop: the data field added in Slice 2 actually drives plugin loading.

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (or equivalent)

#### Step 3a: Write failing tests for conditional load

Append to the static wiring test file:

```typescript
describe('createK8sPlugins — conditional title plugins', () => {
  function baseConfig(): K8sPresetConfig {
    return {
      database: { connectionString: 'postgres://stub:5432/stub' },
      eventbus: { connectionString: 'postgres://stub:5432/stub' },
      session: { connectionString: 'postgres://stub:5432/stub' },
      workspace: { backend: 'local', repoRoot: '/tmp/ax-test' },
      ipc: { hostIpcUrl: 'http://stub.svc.cluster.local:80' },
      http: {
        host: '127.0.0.1',
        port: 0,
        cookieKey: '0'.repeat(64),
        allowedOrigins: [],
      },
      auth: { devBootstrap: { token: 'test-bootstrap' } },
    };
  }

  it('omits @ax/llm-anthropic and @ax/conversation-titles when cfg.titles is undefined', () => {
    const plugins = createK8sPlugins(baseConfig());
    const names = plugins.map((p) => p.manifest.name);
    expect(names).not.toContain('@ax/llm-anthropic');
    expect(names).not.toContain('@ax/conversation-titles');
  });

  it('includes both plugins when cfg.titles is set', () => {
    const plugins = createK8sPlugins({
      ...baseConfig(),
      titles: { model: 'anthropic/claude-haiku-4-5-20251001' },
    });
    const names = plugins.map((p) => p.manifest.name);
    expect(names).toContain('@ax/llm-anthropic');
    expect(names).toContain('@ax/conversation-titles');
  });

  it('passes cfg.titles.model into the conversation-titles plugin manifest', () => {
    const plugins = createK8sPlugins({
      ...baseConfig(),
      titles: { model: 'anthropic/claude-sonnet-4-7' },
    });
    const titlesPlugin = plugins.find(
      (p) => p.manifest.name === '@ax/conversation-titles',
    );
    expect(titlesPlugin).toBeDefined();
    expect(titlesPlugin!.manifest.calls).toContain('llm:call:anthropic');
  });
});
```

- [ ] Edit the test file. Save.

#### Step 3b: Run new tests; confirm fail

```bash
pnpm test --filter @ax/preset-k8s -t "createK8sPlugins — conditional title plugins"
```

Expected: FAIL — both plugins are missing or the function isn't reading `cfg.titles`.

#### Step 3c: Implement conditional load + update parked-comment

Open `presets/k8s/src/index.ts`. Find the comment block at lines 563-567:

```typescript
  // Defaults `defaultRunnerType: 'claude-sdk'` (the only runner shipped
  // today). Auto-titling (@ax/conversation-titles) is NOT loaded here —
  // it would require @ax/llm-anthropic with a separate ANTHROPIC_API_KEY,
  // which conflicts with the OAuth-only credential posture. Conversations
  // stay `title: null` until a user-driven rename ships.
```

Replace with:

```typescript
  // Defaults `defaultRunnerType: 'claude-sdk'` (the only runner shipped
  // today). Auto-titling (@ax/conversation-titles) loads conditionally
  // on `cfg.titles` being defined — `loadK8sConfigFromEnv` populates it
  // iff ANTHROPIC_API_KEY is in env. Multi-tenant deploys without a
  // shared host key opt out cleanly (cfg.titles undefined → both
  // plugins skipped → conversations stay `title: null`, same as today).
```

After the existing `plugins.push(createConversationsPlugin());` line, add:

```typescript
  // Auto-titling: @ax/llm-anthropic registers `llm:call:anthropic`,
  // @ax/conversation-titles subscribes to `chat:turn-end` and dispatches
  // `llm:call:${provider}` after the first assistant turn lands.
  // Conditional on cfg.titles (driven by ANTHROPIC_API_KEY presence in
  // loadK8sConfigFromEnv) so multi-tenant deploys opt out cleanly.
  if (config.titles !== undefined) {
    plugins.push(createLlmAnthropicPlugin());
    const titlesCfg: ConversationTitlesConfig = {};
    if (config.titles.model !== undefined) {
      titlesCfg.model = config.titles.model;
    }
    plugins.push(createConversationTitlesPlugin(titlesCfg));
  }
```

Add the imports at the top of the file:

```typescript
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';
import {
  createConversationTitlesPlugin,
  type ConversationTitlesConfig,
} from '@ax/conversation-titles';
```

- [ ] Edit the file. Save.

#### Step 3d: Verify package.json declares the new deps

The preset already lives in the cross-plugin allowlist (CLAUDE.md mentions "presets/** is in the same allowlist"). Open `presets/k8s/package.json` and confirm both `@ax/llm-anthropic` and `@ax/conversation-titles` are in `dependencies`. If missing, add:

```json
    "@ax/llm-anthropic": "workspace:*",
    "@ax/conversation-titles": "workspace:*",
```

- [ ] Verify; if anything was added, run `pnpm install` from the repo root to update the lockfile.

#### Step 3e: Run new tests; confirm pass

```bash
pnpm test --filter @ax/preset-k8s -t "createK8sPlugins — conditional title plugins"
```

Expected: PASS.

#### Step 3f: Run the full preset test suite

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: ALL PASS, including the Phase F acceptance canary at `acceptance.test.ts` (which still loads conversation-titles + llm-anthropic explicitly with the new factory shape — see Slice 4).

If the Phase F canary fails, jump to Slice 4 first; this slice's commit can land after.

#### Step 3g: Commit

```bash
git add presets/k8s
git commit -m "$(cat <<'EOF'
feat(preset-k8s): conditionally load @ax/llm-anthropic + @ax/conversation-titles

When `cfg.titles` is defined (set by loadK8sConfigFromEnv iff
ANTHROPIC_API_KEY is in env), the preset pushes both plugins so
conversations get an auto-generated title after the first assistant
turn. When undefined, neither plugin loads — multi-tenant deploys
without a shared host key see no behavior change.

Updates the parked-state comment at lines 563-567 to reflect the new
posture.
EOF
)"
```

- [ ] Run the commit. Expected: commit lands; hooks pass.

---

### Slice 4 — Phase F acceptance canary continues to pass

The Phase F canary at `presets/k8s/src/__tests__/acceptance.test.ts:1280-1511` already exercises the full title pipeline with a stub Anthropic client. After Slice 1's rename, the test still works because it uses `createLlmAnthropicPlugin` (which now registers `llm:call:anthropic`) and `createConversationTitlesPlugin` (which now dispatches `llm:call:anthropic` by default).

This slice makes the test robust to future default changes by passing config explicitly.

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

#### Step 4a: Make the Phase F canary's factory call explicit

Open `presets/k8s/src/__tests__/acceptance.test.ts`. Find line 1380:

```typescript
          createConversationTitlesPlugin(),
```

Replace with:

```typescript
          // Pin the model explicitly so this test is robust to future
          // default-value changes in @ax/conversation-titles.
          createConversationTitlesPlugin({
            model: 'anthropic/claude-haiku-4-5-20251001',
          }),
```

- [ ] Edit the file. Save.

#### Step 4b: Run the Phase F canary

```bash
pnpm test --filter @ax/preset-k8s -t "Phase F canary"
```

Expected: PASS. The test's `expect(title).toBe('Test Conversation Title')` and `expect(llmCallCounter.count).toBe(1)` assertions hold because:
- `createLlmAnthropicPlugin` registers `llm:call:anthropic` (post-Slice 1).
- `createConversationTitlesPlugin({ model: 'anthropic/...' })` parses to provider=anthropic, dispatches `llm:call:anthropic`.
- The bus delivers to the registered stub.

#### Step 4c: Run the full preset test suite

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: ALL PASS.

#### Step 4d: Commit

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "$(cat <<'EOF'
test(preset-k8s/acceptance): pin Phase F canary's title-model config explicitly

Robust to future default-value changes in @ax/conversation-titles. No
behavior change today (the explicit value matches the new default).
EOF
)"
```

- [ ] Run the commit. Expected: commit lands.

---

### Slice 5 — Helm chart: `titles.model` value + `AX_TITLE_MODEL` env render

Surface the title model in the chart so operators don't need to set environment variables manually.

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml`
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Modify: `deploy/charts/ax-next/__tests__/env-shape.test.ts`
- Possibly modify: `deploy/charts/ax-next/__tests__/render.test.ts` (depending on whether we add a render assertion)

#### Step 5a: Add `titles.model` to `values.yaml`

Open `deploy/charts/ax-next/values.yaml`. Find a logical place near other feature toggles (look for `chat:`, `runner:`, or similar feature groupings). Add:

```yaml
# ─── Auto-titling ─────────────────────────────────────────────────
# When `anthropic.apiKey` is set, the host pod loads
# @ax/conversation-titles and writes a short title to each
# conversation after its first assistant turn (ifNull: true, never
# clobbers a user rename). When unset, titles stay null.
#
# `model` uses the `<provider>/<model-id>` convention. Today's only
# provider is `anthropic`. Future providers slot in by registering
# `llm:call:<provider>` from a sibling plugin.
titles:
  # Title-LLM model. Default: cheapest current Claude. Override for
  # benchmarking or to follow a model deprecation.
  model: anthropic/claude-haiku-4-5-20251001
```

- [ ] Edit the file. Save.

#### Step 5b: Render `AX_TITLE_MODEL` in the host Deployment env

Open `deploy/charts/ax-next/templates/host/deployment.yaml`. Find the `ANTHROPIC_API_KEY` env block (around line 238) — that's a logical neighbor since they're paired functionally.

Add a new env var right after the `ANTHROPIC_API_KEY` block:

```yaml
            # Auto-title model. Only effective when ANTHROPIC_API_KEY
            # (above) is set — see presets/k8s/src/index.ts loader.
            - name: AX_TITLE_MODEL
              value: {{ .Values.titles.model | quote }}
```

- [ ] Edit the file. Save.

#### Step 5c: Update `env-shape.test.ts`

Open `deploy/charts/ax-next/__tests__/env-shape.test.ts`. Find `EXTERNAL_READERS` at line 126. The current entry for `ANTHROPIC_API_KEY` (lines 131-134) says no plugin reads it. After Slice 3, `loadK8sConfigFromEnv` reads it directly to gate `cfg.titles`, so the loader scan (which parses `presets/k8s/src/index.ts` for `env.X` references) will now pick it up.

Remove the `ANTHROPIC_API_KEY` entry from `EXTERNAL_READERS`:

```typescript
const EXTERNAL_READERS: ReadonlySet<string> = new Set([
  // CLI bootstrap reads the config path before any plugin loads.
  'AX_CONFIG_PATH',
  // @ax/credentials reads at init().
  'AX_CREDENTIALS_KEY',
  // (ANTHROPIC_API_KEY removed: loadK8sConfigFromEnv now reads it directly
  //  to gate the conditional load of @ax/conversation-titles.)
  'AX_HTTP_ALLOW_NO_ORIGINS',
  'PGPASSWORD',
  'LOG_LEVEL',
]);
```

- [ ] Edit the file. Save.

#### Step 5d: Run the env-shape test

```bash
pnpm test --filter ax-next-chart -t "host deployment env vs preset loader"
```

(Or the equivalent path — verify with `cat deploy/charts/ax-next/package.json | jq -r .name` if unsure of the package name.)

Expected: PASS. The test asserts both directions: the loader's required env vars all land in the deployment, and every env var in the deployment is either in the loader or `EXTERNAL_READERS`. Both `ANTHROPIC_API_KEY` (now in the loader) and `AX_TITLE_MODEL` (now in the loader) should pass.

#### Step 5e: (Optional) Add a targeted render assertion

If `deploy/charts/ax-next/__tests__/render.test.ts` has assertions on specific env values (not just keys), add:

```typescript
it('renders AX_TITLE_MODEL from titles.model values', () => {
  const doc = renderHostDeployment([
    '--set', 'titles.model=anthropic/claude-sonnet-4-7',
  ]);
  const env = (doc.spec as any).template.spec.containers[0].env ?? [];
  const found = env.find((e: any) => e.name === 'AX_TITLE_MODEL');
  expect(found).toBeDefined();
  expect(found.value).toBe('anthropic/claude-sonnet-4-7');
});
```

If `render.test.ts` doesn't exist, skip this step — the env-shape test already covers presence.

- [ ] Edit if applicable. Save.

#### Step 5f: Run the full chart test suite

```bash
pnpm test --filter ax-next-chart
```

Expected: ALL PASS.

#### Step 5g: Commit

```bash
git add deploy/charts/ax-next
git commit -m "$(cat <<'EOF'
feat(chart): surface titles.model + render AX_TITLE_MODEL

Adds `titles.model` to values.yaml (default
`anthropic/claude-haiku-4-5-20251001`) and renders it as the
AX_TITLE_MODEL env var on the host pod. ANTHROPIC_API_KEY is
removed from env-shape's EXTERNAL_READERS allow-list since the
preset loader now reads it directly.
EOF
)"
```

- [ ] Run the commit. Expected: commit lands.

---

### Slice 6 — Final integration check

Run the entire test suite to confirm nothing else regressed.

#### Step 6a: Repo-wide test run

```bash
pnpm test
```

Expected: ALL PASS. If anything fails outside the touched packages, investigate — the rename should have been comprehensive (verified at Slice 0 / Step 0b).

#### Step 6b: Repo-wide build

```bash
pnpm build
```

Expected: ALL PASS. TypeScript types should agree across the workspace (project references catch most drift).

#### Step 6c: Manifest assertion sanity check

Run a one-off grep to confirm no stray `'llm:call'` references remain in non-test code:

```bash
grep -rn "'llm:call'" packages/ presets/ landing/ container/ deploy/ \
  | grep -v "/dist/" | grep -v "/node_modules/" | grep -v "__tests__"
```

Expected: zero output. If any line appears, it's a stray reference that escaped the rename — fix and re-test.

#### Step 6d: Manual smoke (kind cluster, optional)

If a kind cluster is available, optionally verify the goldenpath:

```bash
# Build, deploy to kind cluster ax-next-dev
# (existing dev workflow — skill k8s-acceptance-loop covers the steps)
# Open the chat UI, send a message, observe the conversation row's title
# transitions from null to a generated string within ~5s.
```

This is optional — the Phase F canary in `acceptance.test.ts` covers the end-to-end path hermetically.

- [ ] Run Steps 6a-6c. Optionally Step 6d. All expected: PASS.

#### Step 6e: No commit (verification slice)

If everything passes, the PR is ready. If anything failed, fix and amend (or commit fix to the relevant slice's commit) before opening the PR.

---

## Boundary review

Covered fully in `docs/plans/2026-05-06-auto-title-conversations-design.md` under the "Boundary review (CLAUDE.md required for hook-surface change)" section. PR description should link to that section.

Summary of the surface changes (PR-description-ready bullets):

- `llm:call` (service hook) → `llm:call:<provider>`. Single-instance rename, internal to the host. Per-provider naming mirrors `credentials:resolve:<kind>`.
- `@ax/conversation-titles` factory accepts `{ model: 'provider/model-id' }`. Default preserved.
- `@ax/preset-k8s` reads `AX_TITLE_MODEL` and gates the conditional load on `ANTHROPIC_API_KEY` presence.

---

## Verification plan

- **Unit tests** (Slice 1, 2, 3, 4): each plugin's tests pass; new cases cover invalid config, default fallback, dispatch to configured provider, manifest shape.
- **Acceptance test** (Slice 4): Phase F canary at `acceptance.test.ts:1280-1511` continues to pass end-to-end via stubbed Anthropic client.
- **Static wiring** (Slice 2, 3): `loadK8sConfigFromEnv` populates `cfg.titles` correctly; `createK8sPlugins` includes/excludes the title plugins based on the field.
- **Chart shape** (Slice 5): env-shape test asserts every loader-read var lands in the host Deployment, including the new `AX_TITLE_MODEL`.
- **Repo-wide** (Slice 6): full test + build cycle passes.
- **Manual smoke** (Slice 6d, optional): kind goldenpath shows titles transitioning null → generated within ~5s of the first assistant turn.

---

## Rollback plan

If a regression surfaces post-merge:

1. **Just disable titling**: chart operator unsets `anthropic.apiKey` in their values override. Host pod redeploys without `ANTHROPIC_API_KEY`; `loadK8sConfigFromEnv` leaves `cfg.titles` undefined; both plugins skip loading. Same posture as today's main branch.
2. **Revert the PR**: `git revert <merge-sha>` removes all six commits cleanly. The packages return to their pre-PR state.

There is no data migration to roll back: `conversations.title` already accepts NULL, and the `ifNull: true` guard means existing-titled rows are never touched by this code path.

---

## Open questions resolved during execution

None expected. All decisions (provider/model split point, env-var name, conditional gating mechanism, default model value, no version-compat shim on the rename) are pinned in the design doc.

If something genuinely surprising surfaces during implementation, append it to this plan as a new section ("**Q1: <question>**") and resolve before continuing.

---

## PR notes preview (to be written at PR creation)

Title: `feat: auto-titled conversations + per-provider llm:call:<provider> hooks`

Body: link to the design doc; summary of the three changes (rename, factory config, preset wiring); link to the boundary review; note the rollback path; tag the Phase F canary as the end-to-end witness.
