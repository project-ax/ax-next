# Model Policy (Admin-Selectable Models) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution:** completed for `TASK-G001` on `feat/model-policy`. See [verification and acceptance](2026-09-30-model-policy-verification.md) for final checks, review fixes, and deviations from the commands below.

**Goal:** An admin can pick, in a searchable two-pane "Models" tab, exactly which models people may use in their agents (live catalog from every provider, one marked Default); agents on a model that is later removed run on the Default from their next chat, without their stored model being rewritten.

**Architecture:** A new `@ax/model-policy` plugin owns one storage document (`settings:model-policy`), the built-in fallback policy, a cached live catalog aggregated from per-provider `models:list-available:<provider>` hooks, and three admin routes. `@ax/agents` and personal-agent bootstrap consume it through the soft hook (`models:get-policy`): validation, the picker route, runner derivation, and a lazy swap inside `agents:resolve`. `channel-web` gets a Models tab and two agent-editor changes.

**Tech Stack:** TypeScript (strict, NodeNext, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), pnpm workspace, zod, Kysely + Postgres (`@ax/agents`), Vitest (Postgres testcontainers for `@ax/agents`), React + shadcn/Radix + Tailwind + lucide (`channel-web`), Testing Library (`fireEvent`/`waitFor`; **no** `@testing-library/user-event`).

**Spec:** `docs/plans/2026-09-30-model-policy-design.md` (read it first; this plan implements it).

## Global Constraints

Every task's requirements implicitly include these (values copied from the spec).

- Model refs are `provider/model-id`; validate with `isModelRef` / `parseModelRef` from `@ax/core`. Max **200** chars per ref. Policy `allowed` max **1000** entries, non-empty, no duplicates, `default ∈ allowed`.
- Storage key `settings:model-policy`; one JSON document `{ version, allowed, default, updatedAt, updatedBy }`. Hooks: `models:get-policy` (consumer `@ax/agents`, soft) and `models:list-available:<provider>` (providers `anthropic`, `openrouter`). No other new hook.
- Admin routes: `GET /admin/models/catalog[?refresh=1]`, `GET /admin/models/policy`, `PUT /admin/models/policy`; `auth:require-user` with `isAdmin` (401 / 403); PUT `maxBodyBytes` **256 KiB**; writes carry `x-requested-with: ax-admin` (enforced by http-server CSRF, not by the plugin). Impact route `POST /admin/agents/models/impact` lives in `@ax/agents`, admin-only, returns counts only.
- Catalog limits per provider: response ≤ **5 MiB**, ≤ **2000** models, call timeout **8 s**, cache TTL **10 min**, forced refresh at most once per **15 s** per provider. Labels: control / bidirectional / invisible characters stripped, ≤ **120** chars, fall back to the ref. Refs must match `/^[A-Za-z0-9][A-Za-z0-9._:+@\/-]*$/` and start with `<provider>/`.
- Runner rule: provider `anthropic` → `claude-sdk`, everything else → `aisdk`. `claude-sdk` with a non-Anthropic model is rejected on write; `aisdk` with an Anthropic model is allowed.
- Lazy swap happens only in the `agents:resolve` result (adds optional `requestedModel`). **Never** write the swapped model back.
- No new npm dependencies. No `scroll-area` (use a plain `overflow-y-auto` container). UI uses only installed shadcn primitives + semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`, …), never raw colors. `Alert` has only `default`/`destructive` variants; card titles use `role="heading" aria-level={2}` (one `<h1>` per tab, owned by `AdminPaneHeader`).
- Copy follows the project voice (plain, short, "we", blameless; no jokes near data loss). Do not write the retired words in `src/__tests__/vocabulary.test.ts` (`new session`, `unknown artifact`, `update credentials`, `set credential`, `this session`). Say "API key", not "credential"; "chat", not "session".
- Plugins talk only through the hook bus: no `@ax/*` runtime imports except the allow-list in `eslint.config.mjs` (`@ax/core` is fine). Duplicate small types locally.
- Commands: put `--filter` **before** the script name (`pnpm --filter @ax/model-policy test`). Never write a run of `=` as an `echo` separator (zsh aborts). Postgres-backed `@ax/agents` tests need an explicit `DOCKER_HOST` (locally `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock`). Every `kubectl`/`helm` command names its context: `--context kind-ax-next-dev` for kind; **never** run anything against the GKE production context in this plan.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Tests are excluded from `tsc --build`; type-check them with the explicit commands given.

## Spec deltas found while planning (the plan wins where they differ)

1. `storage:set` has no compare-and-swap, so the `baseVersion` check is serialized **in process** (the host is single-replica by design; Helm fails for `replicas > 1`). Documented in Task 1.
2. The agent editor currently re-sends `model` on **every** save. Task 15 makes it send `model` only when the user changed it (this is the spec's edit-never-persists-the-Default risk).
3. Spec open item 6 is closed: `aisdk` runs both `anthropic` and `openrouter`, and those are the only two providers that exist.
4. Provider discovery uses `PROVIDER_ENDPOINTS` from `@ax/core` (ids + display names); a provider is included only if `models:list-available:<id>` is registered.
5. OpenRouter ids may carry a `:variant` suffix (e.g. `openai/gpt-6.1-sol-pro:batch`) and are separate entries; OpenRouter `name` already includes a vendor prefix ("OpenAI: GPT…"). Both are accepted as-is.
6. `agents:resolve` has a `returns` zod schema that strips undeclared keys, so `requestedModel` must be added to `AgentSchema` (Task 8).
7. Existing `GET /admin/agents/models` tests assert the exact body with `toEqual`; they change when `defaultModel` is added (Task 7).

## Review Focus

Failure modes the spec implies but a happy-path test suite would miss. Each has a pinning test in the task that owns the code.

1. **Hostile provider response** (bidi/control characters, 10 KB label, wrong provider prefix, duplicate ids, 3000 entries, whitespace in an id) → sanitised or dropped, never fatal, never stored. Task 2.
2. **Bad admin save** (empty selection, Default not selected, 1001 models, bare id, stale `baseVersion`, two saves racing) → 400/409 with a plain reason, storage untouched. Tasks 1 and 3.
3. **Corrupt saved document** → built-in policy served, error logged once, `warning: 'saved-policy-unreadable'` surfaced, and the next save repairs it. Task 1.
4. **Owner saves an unrelated edit on a swapped agent** → the `PATCH` has no `model` key and the stored model is unchanged. Tasks 8 and 15.
5. **Agent already broken today** (`claude-sdk` runner + OpenRouter model) → resolves to `aisdk` and runs. Task 8.
6. **Provider down on first load / key missing / slow** → `fallback` / `no-key` / `error` statuses, other providers unaffected. Task 2.

---

## File Structure

New package `packages/model-policy/`:

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json` | workspace package (copy of `@ax/branding`'s shape) |
| `src/index.ts` | public exports |
| `src/shared.ts` | constants, local `RouteRequest`/`RouteResponse`, `requireAdmin`, `parseRequestBody` |
| `src/policy.ts` | pure: `validatePolicyInput`, `pickDefault`, `parseStored`, `serializeStored` |
| `src/policy-store.ts` | `createPolicyStore`: cached read, serialized versioned save |
| `src/catalog.ts` | pure + stateful: sanitising, normalising, per-provider cache/timeout/fallback aggregation |
| `src/routes.ts` | three admin route handlers + registration |
| `src/plugin.ts` | `createModelPolicyPlugin`, registers routes then `models:get-policy` |
| `src/__tests__/*.test.ts` | one test file per source file |

Modified: `packages/llm-openrouter/src/plugin.ts`, `packages/llm-anthropic/src/plugin.ts` (new hook + tests); `packages/agents/src/{store,plugin,types,admin-routes}.ts` + new `packages/agents/src/model-policy.ts` (+ tests); `presets/k8s/{package.json,tsconfig.json,src/index.ts}` and its test lists; root `tsconfig.json`; `docs/plans/2026-05-24-current-architecture.md`; `packages/channel-web/src/{lib/admin.ts,lib/models-admin.ts,lib/models-copy.ts,lib/models-picker.ts,components/admin/{ModelsTab,ModelCatalogPane,SelectedModelsPane,SaveImpactDialog,AdminShell,AdminSidebar,AgentForm}.tsx}` (+ tests).

---

### Task 1: `@ax/model-policy` package, policy domain, and `models:get-policy`

**Files:**
- Create: `packages/model-policy/package.json`, `packages/model-policy/tsconfig.json`, `packages/model-policy/src/index.ts`, `src/shared.ts`, `src/policy.ts`, `src/policy-store.ts`, `src/plugin.ts`
- Create (tests): `src/__tests__/policy.test.ts`, `src/__tests__/policy-store.test.ts`, `src/__tests__/plugin.test.ts`
- Modify: root `tsconfig.json` (add a reference)

**Interfaces:**
- Produces (used by Tasks 3 and 10):
  - `validatePolicyInput(input: unknown): PolicyValidation` where `PolicyValidation = { ok: true; value: PolicyInput } | { ok: false; code: PolicyErrorCode; message: string }`, `PolicyInput = { allowed: string[]; default: string }`.
  - `pickDefault(allowed: readonly string[], preferred?: string): string`
  - `createPolicyStore(deps): PolicyStore` with `read(ctx): Promise<PolicyView>` and `save(ctx, input: SaveInput, actorId: string): Promise<SaveResult>`.
  - `createModelPolicyPlugin(config: ModelPolicyConfig): Plugin` registering `models:get-policy` → `GetPolicyOutput`.
- Consumes: `storage:get` (`{ key } → { value: Uint8Array | undefined }`), `storage:set` (`{ key, value: Uint8Array } → {}`).

- [x] **Step 1: Scaffold the package**

`packages/model-policy/package.json`:

```json
{
  "name": "@ax/model-policy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "build": "tsc --build", "test": "vitest run", "test:watch": "vitest" },
  "dependencies": { "@ax/core": "workspace:*", "zod": "^3.23.8" },
  "devDependencies": { "@types/node": "^25.6.0", "typescript": "^6.0.3", "vitest": "^5.0.1" }
}
```

`packages/model-policy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

Add `{ "path": "packages/model-policy" }` to the `references` array in the root `tsconfig.json` (next to the other `packages/...` entries).

`packages/model-policy/src/index.ts`:

```ts
export { createModelPolicyPlugin, type ModelPolicyConfig, type GetPolicyOutput } from './plugin.js';
export { validatePolicyInput, pickDefault, type PolicyInput, type PolicyValidation, type PolicyErrorCode } from './policy.js';
export { createPolicyStore, type PolicyStore, type PolicyView, type SaveInput, type SaveResult } from './policy-store.js';
```

(`plugin.ts` and the others are created in the following steps; the build is only run at the end of the task.)

Run: `pnpm install`
Expected: the lockfile gains a `packages/model-policy:` importer block and nothing else changes (`git diff --stat pnpm-lock.yaml` shows only additions under that importer).

- [x] **Step 2: Write the failing policy tests**

`packages/model-policy/src/__tests__/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseStored, pickDefault, serializeStored, validatePolicyInput } from '../policy.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

describe('validatePolicyInput', () => {
  it('accepts a normal selection and keeps its order', () => {
    expect(validatePolicyInput({ allowed: [KIMI, SONNET], default: SONNET })).toEqual({
      ok: true,
      value: { allowed: [KIMI, SONNET], default: SONNET },
    });
  });

  it.each([
    ['not an object', 'nope', 'invalid-payload'],
    ['null', null, 'invalid-payload'],
    ['an array', [], 'invalid-payload'],
    ['allowed missing', { default: SONNET }, 'invalid-payload'],
    ['allowed holding a non-string', { allowed: [SONNET, 3], default: SONNET }, 'invalid-payload'],
    ['an empty selection', { allowed: [], default: SONNET }, 'pick-at-least-one-model'],
    ['a bare id', { allowed: ['claude-sonnet-4-6'], default: 'claude-sonnet-4-6' }, 'invalid-model-ref'],
    ['whitespace in a ref', { allowed: ['anthropic/claude sonnet'], default: 'anthropic/claude sonnet' }, 'invalid-model-ref'],
    ['a duplicate', { allowed: [SONNET, SONNET], default: SONNET }, 'duplicate-model'],
    ['a Default that is not selected', { allowed: [SONNET], default: OPUS }, 'default-not-selected'],
    ['a missing Default', { allowed: [SONNET] }, 'default-not-selected'],
    ['a non-string Default', { allowed: [SONNET], default: 7 }, 'default-not-selected'],
  ])('rejects %s', (_label, input, code) => {
    const r = validatePolicyInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('rejects more than 1000 models', () => {
    const allowed = Array.from({ length: 1001 }, (_, i) => `openrouter/vendor/model-${i}`);
    expect(validatePolicyInput({ allowed, default: allowed[0] })).toMatchObject({
      ok: false,
      code: 'too-many-models',
    });
  });

  it('accepts exactly 1000 models', () => {
    const allowed = Array.from({ length: 1000 }, (_, i) => `openrouter/vendor/model-${i}`);
    expect(validatePolicyInput({ allowed, default: allowed[0] }).ok).toBe(true);
  });

  it('rejects a ref longer than 200 characters', () => {
    const long = `openrouter/${'a'.repeat(200)}`;
    expect(validatePolicyInput({ allowed: [long], default: long })).toMatchObject({
      ok: false,
      code: 'invalid-model-ref',
    });
  });

  it('never echoes a hostile ref at full length in its message', () => {
    const r = validatePolicyInput({ allowed: ['x'.repeat(5000)], default: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeLessThan(200);
  });
});

describe('pickDefault', () => {
  it('honours a preferred default that is in the list', () => {
    expect(pickDefault([SONNET, OPUS], OPUS)).toBe(OPUS);
  });
  it('prefers Claude Sonnet when no preference is given', () => {
    expect(pickDefault([OPUS, SONNET])).toBe(SONNET);
  });
  it('falls back to the first entry', () => {
    expect(pickDefault([KIMI, OPUS])).toBe(KIMI);
  });
  it('ignores a preferred default that is not in the list', () => {
    expect(pickDefault([KIMI], OPUS)).toBe(KIMI);
  });
});

describe('parseStored / serializeStored', () => {
  const doc = {
    version: 3,
    allowed: [SONNET, KIMI],
    default: SONNET,
    updatedAt: '2026-09-30T18:00:00.000Z',
    updatedBy: 'usr_admin',
  };

  it('round-trips a valid document', () => {
    expect(parseStored(serializeStored(doc))).toEqual({ kind: 'ok', doc });
  });
  it('treats undefined and empty bytes as absent', () => {
    expect(parseStored(undefined)).toEqual({ kind: 'absent' });
    expect(parseStored(new Uint8Array())).toEqual({ kind: 'absent' });
  });
  it.each([
    ['invalid utf-8', new Uint8Array([0xff, 0xfe, 0xfd])],
    ['not json', new TextEncoder().encode('{nope')],
    ['the wrong shape', new TextEncoder().encode('{"hello":1}')],
    ['an unknown extra key', new TextEncoder().encode(JSON.stringify({ ...doc, extra: 1 }))],
    ['version 0', new TextEncoder().encode(JSON.stringify({ ...doc, version: 0 }))],
    ['a Default outside allowed', new TextEncoder().encode(JSON.stringify({ ...doc, default: OPUS }))],
    ['a bare id in allowed', new TextEncoder().encode(JSON.stringify({ ...doc, allowed: ['nope'], default: 'nope' }))],
  ])('reports %s as corrupt', (_label, bytes) => {
    expect(parseStored(bytes)).toEqual({ kind: 'corrupt' });
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ax/model-policy test`
Expected: FAIL — `Cannot find module '../policy.js'`.

- [x] **Step 4: Implement `shared.ts` (constants only for now) and `policy.ts`**

`packages/model-policy/src/shared.ts`:

```ts
export const PLUGIN_NAME = '@ax/model-policy';
export const POLICY_STORAGE_KEY = 'settings:model-policy';
export const SERVICE_GET_POLICY = 'models:get-policy';

export const MAX_ALLOWED_MODELS = 1000;
export const MAX_REF_CHARS = 200;
export const POLICY_BODY_MAX_BYTES = 256 * 1024;
```

`packages/model-policy/src/policy.ts`:

```ts
import { isModelRef } from '@ax/core';
import { z } from 'zod';
import { MAX_ALLOWED_MODELS, MAX_REF_CHARS } from './shared.js';

export interface PolicyInput {
  allowed: string[];
  default: string;
}

export type PolicyErrorCode =
  | 'invalid-payload'
  | 'pick-at-least-one-model'
  | 'too-many-models'
  | 'invalid-model-ref'
  | 'duplicate-model'
  | 'default-not-selected';

export type PolicyValidation =
  | { ok: true; value: PolicyInput }
  | { ok: false; code: PolicyErrorCode; message: string };

const PREFERRED_DEFAULT = 'anthropic/claude-sonnet-4-6';

function fail(code: PolicyErrorCode, message: string): PolicyValidation {
  return { ok: false, code, message };
}

/** Validate a policy as an admin would submit it. Shape only: a model the live catalog no longer lists is still valid. */
export function validatePolicyInput(input: unknown): PolicyValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('invalid-payload', 'the policy must be an object');
  }
  const { allowed, default: def } = input as Record<string, unknown>;
  if (!Array.isArray(allowed) || allowed.some((r) => typeof r !== 'string')) {
    return fail('invalid-payload', 'allowed must be a list of model references');
  }
  const refs = allowed as string[];
  if (refs.length === 0) return fail('pick-at-least-one-model', 'pick at least one model');
  if (refs.length > MAX_ALLOWED_MODELS) {
    return fail('too-many-models', `at most ${MAX_ALLOWED_MODELS} models can be available`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.length > MAX_REF_CHARS || !isModelRef(ref)) {
      return fail('invalid-model-ref', `'${ref.slice(0, 80)}' is not a valid model reference`);
    }
    if (seen.has(ref)) return fail('duplicate-model', `'${ref}' is listed twice`);
    seen.add(ref);
  }
  if (typeof def !== 'string' || !seen.has(def)) {
    return fail('default-not-selected', 'the Default must be one of the selected models');
  }
  return { ok: true, value: { allowed: [...refs], default: def } };
}

/** The Default for a built-in list: the preferred one if present, else Claude Sonnet, else the first entry. */
export function pickDefault(allowed: readonly string[], preferred?: string): string {
  if (preferred !== undefined && allowed.includes(preferred)) return preferred;
  if (allowed.includes(PREFERRED_DEFAULT)) return PREFERRED_DEFAULT;
  return allowed[0] ?? '';
}

export interface StoredPolicy {
  version: number;
  allowed: string[];
  default: string;
  updatedAt: string;
  updatedBy: string;
}

const storedSchema = z
  .object({
    version: z.number().int().min(1),
    allowed: z.array(z.string()),
    default: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();

export type ParsedStored =
  | { kind: 'absent' }
  | { kind: 'ok'; doc: StoredPolicy }
  | { kind: 'corrupt' };

export function parseStored(bytes: Uint8Array | undefined): ParsedStored {
  if (bytes === undefined || bytes.length === 0) return { kind: 'absent' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'corrupt' };
  }
  const shape = storedSchema.safeParse(json);
  if (!shape.success) return { kind: 'corrupt' };
  const content = validatePolicyInput({ allowed: shape.data.allowed, default: shape.data.default });
  if (!content.ok) return { kind: 'corrupt' };
  return { kind: 'ok', doc: shape.data };
}

export function serializeStored(doc: StoredPolicy): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}
```

- [x] **Step 5: Run the policy tests to verify they pass**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/policy.test.ts`
Expected: PASS (all cases).

- [x] **Step 6: Write the failing policy-store tests**

`packages/model-policy/src/__tests__/policy-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { createPolicyStore } from '../policy-store.js';
import { serializeStored } from '../policy.js';
import { POLICY_STORAGE_KEY } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const BUILTIN = { allowed: [OPUS, SONNET], default: SONNET };

function fakeLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  const l = {
    errors,
    debug() {},
    info() {},
    warn() {},
    error(msg: string) {
      errors.push(msg);
    },
    child() {
      return l;
    },
  } as Logger & { errors: string[] };
  return l;
}

function setup(opts: { ttlMs?: number } = {}) {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  const counts = { gets: 0, sets: 0 };
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => {
    counts.gets += 1;
    return { value: storage.get(i.key) };
  });
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    counts.sets += 1;
    storage.set(i.key, i.value);
    return {};
  });
  let t = 0;
  const logger = fakeLogger();
  const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin', logger });
  const store = createPolicyStore({
    bus,
    builtin: BUILTIN,
    now: () => new Date(t),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  return { store, storage, counts, ctx, logger, advance: (ms: number) => (t += ms) };
}

describe('createPolicyStore.read', () => {
  it('serves the built-in policy when nothing is saved', async () => {
    const { store, ctx } = setup();
    expect(await store.read(ctx)).toEqual({
      source: 'builtin',
      version: 0,
      allowed: [OPUS, SONNET],
      default: SONNET,
    });
  });

  it('serves a saved policy', async () => {
    const { store, storage, ctx } = setup();
    storage.set(
      POLICY_STORAGE_KEY,
      serializeStored({ version: 4, allowed: [KIMI], default: KIMI, updatedAt: 'T', updatedBy: 'u1' }),
    );
    expect(await store.read(ctx)).toEqual({
      source: 'admin',
      version: 4,
      allowed: [KIMI],
      default: KIMI,
      updatedAt: 'T',
      updatedBy: 'u1',
    });
  });

  it('falls back to the built-in policy, warns, and logs once when the saved document is corrupt', async () => {
    const { store, storage, ctx, logger } = setup();
    storage.set(POLICY_STORAGE_KEY, new TextEncoder().encode('{nope'));
    const view = await store.read(ctx);
    expect(view).toMatchObject({ source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    expect(logger.errors).toEqual(['model_policy_unreadable']);
  });

  it('caches reads inside the ttl and re-reads after it', async () => {
    const { store, counts, ctx, advance } = setup({ ttlMs: 1000 });
    await store.read(ctx);
    await store.read(ctx);
    expect(counts.gets).toBe(1);
    advance(1001);
    await store.read(ctx);
    expect(counts.gets).toBe(2);
  });

  it('returns copies, so a caller cannot corrupt the cache', async () => {
    const { store, ctx } = setup();
    const first = await store.read(ctx);
    first.allowed.push('anthropic/evil');
    expect((await store.read(ctx)).allowed).toEqual([OPUS, SONNET]);
  });
});

describe('createPolicyStore.save', () => {
  it('saves, bumps the version, and is visible to the next read at once (even inside the ttl)', async () => {
    const { store, ctx } = setup({ ttlMs: 60_000 });
    await store.read(ctx); // warm the cache with the built-in view
    const saved = await store.save(ctx, { baseVersion: 0, allowed: [KIMI, SONNET], default: KIMI }, 'usr_admin');
    expect(saved).toMatchObject({ ok: true, policy: { source: 'admin', version: 1, default: KIMI, updatedBy: 'usr_admin' } });
    expect(await store.read(ctx)).toMatchObject({ source: 'admin', version: 1, allowed: [KIMI, SONNET] });
  });

  it('rejects a stale baseVersion and leaves storage untouched', async () => {
    const { store, counts, ctx } = setup();
    await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1');
    const setsBefore = counts.sets;
    const r = await store.save(ctx, { baseVersion: 0, allowed: [OPUS], default: OPUS }, 'u2');
    expect(r).toEqual({ ok: false, code: 'stale-version' });
    expect(counts.sets).toBe(setsBefore);
  });

  it('returns the validation error and writes nothing for an invalid policy', async () => {
    const { store, storage, ctx } = setup();
    const r = await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: OPUS }, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'default-not-selected' });
    expect(storage.size).toBe(0);
  });

  it('lets exactly one of two racing saves win', async () => {
    const { store, ctx } = setup();
    const [a, b] = await Promise.all([
      store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1'),
      store.save(ctx, { baseVersion: 0, allowed: [OPUS], default: OPUS }, 'u2'),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it('repairs a corrupt document: the next save (baseVersion 0) replaces it and clears the warning', async () => {
    const { store, storage, ctx } = setup();
    storage.set(POLICY_STORAGE_KEY, new TextEncoder().encode('garbage'));
    const r = await store.save(ctx, { baseVersion: 0, allowed: [SONNET], default: SONNET }, 'u1');
    expect(r).toMatchObject({ ok: true, policy: { version: 1 } });
    const view = await store.read(ctx);
    expect(view.warning).toBeUndefined();
    expect(view.source).toBe('admin');
  });
});
```

- [x] **Step 7: Run to verify failure, then implement `policy-store.ts`**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/policy-store.test.ts`
Expected: FAIL — `Cannot find module '../policy-store.js'`.

`packages/model-policy/src/policy-store.ts`:

```ts
import type { AgentContext, HookBus } from '@ax/core';
import {
  parseStored,
  serializeStored,
  validatePolicyInput,
  type PolicyErrorCode,
  type PolicyInput,
  type StoredPolicy,
} from './policy.js';
import { POLICY_STORAGE_KEY } from './shared.js';

export interface PolicyView {
  source: 'admin' | 'builtin';
  version: number;
  allowed: string[];
  default: string;
  updatedAt?: string;
  updatedBy?: string;
  warning?: 'saved-policy-unreadable';
}

export interface SaveInput {
  baseVersion: number;
  allowed: unknown;
  default: unknown;
}

export type SaveResult =
  | { ok: true; policy: PolicyView }
  | { ok: false; code: 'stale-version' }
  | { ok: false; code: PolicyErrorCode; message: string };

export interface PolicyStoreDeps {
  bus: HookBus;
  builtin: PolicyInput;
  now?: () => Date;
  /** How long a read is reused. Saves refresh the cache at once. Default 15 s. */
  ttlMs?: number;
}

export interface PolicyStore {
  read(ctx: AgentContext): Promise<PolicyView>;
  save(ctx: AgentContext, input: SaveInput, actorId: string): Promise<SaveResult>;
}

function clone(view: PolicyView): PolicyView {
  return { ...view, allowed: [...view.allowed] };
}

export function createPolicyStore(deps: PolicyStoreDeps): PolicyStore {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? 15_000;
  let cache: { view: PolicyView; at: number } | null = null;

  // `storage:set` has no compare-and-swap, so the version check is only as
  // atomic as this chain. That is enough: the host is single-replica by design
  // (the Helm chart refuses replicas > 1), so every save goes through here.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const builtinView = (warning?: 'saved-policy-unreadable'): PolicyView => ({
    source: 'builtin',
    version: 0,
    allowed: [...deps.builtin.allowed],
    default: deps.builtin.default,
    ...(warning !== undefined ? { warning } : {}),
  });

  async function load(ctx: AgentContext): Promise<PolicyView> {
    const out = await deps.bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, {
      key: POLICY_STORAGE_KEY,
    });
    const parsed = parseStored(out.value);
    if (parsed.kind === 'absent') return builtinView();
    if (parsed.kind === 'corrupt') {
      ctx.logger.error('model_policy_unreadable', { key: POLICY_STORAGE_KEY });
      return builtinView('saved-policy-unreadable');
    }
    const d = parsed.doc;
    return {
      source: 'admin',
      version: d.version,
      allowed: [...d.allowed],
      default: d.default,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
    };
  }

  return {
    async read(ctx) {
      if (cache !== null && now().getTime() - cache.at < ttlMs) return clone(cache.view);
      const view = await load(ctx);
      cache = { view, at: now().getTime() };
      return clone(view);
    },

    save(ctx, input, actorId) {
      return serialize(async (): Promise<SaveResult> => {
        const checked = validatePolicyInput({ allowed: input.allowed, default: input.default });
        if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
        const current = await load(ctx); // bypass the cache: the version check must see the truth
        if (current.version !== input.baseVersion) return { ok: false, code: 'stale-version' };
        const doc: StoredPolicy = {
          version: current.version + 1,
          allowed: checked.value.allowed,
          default: checked.value.default,
          updatedAt: now().toISOString(),
          updatedBy: actorId,
        };
        await deps.bus.call('storage:set', ctx, { key: POLICY_STORAGE_KEY, value: serializeStored(doc) });
        const view: PolicyView = {
          source: 'admin',
          version: doc.version,
          allowed: [...doc.allowed],
          default: doc.default,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
        };
        cache = { view, at: now().getTime() };
        return { ok: true, policy: clone(view) };
      });
    },
  };
}
```

- [x] **Step 8: Run the store tests to verify they pass**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/policy-store.test.ts`
Expected: PASS.

- [x] **Step 9: Write the failing plugin test, then implement `plugin.ts`**

`packages/model-policy/src/__tests__/plugin.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createModelPolicyPlugin } from '../plugin.js';
import { serializeStored } from '../policy.js';
import { POLICY_STORAGE_KEY } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

function bootBus(storage = new Map<string, Uint8Array>()) {
  const bus = new HookBus();
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => ({
    value: storage.get(i.key),
  }));
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    storage.set(i.key, i.value);
    return {};
  });
  return { bus, storage };
}

describe('createModelPolicyPlugin', () => {
  it('declares the documented surface', () => {
    const plugin = createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET] });
    expect(plugin.manifest.name).toBe('@ax/model-policy');
    expect(plugin.manifest.registers).toEqual(['models:get-policy']);
    expect(plugin.manifest.calls).toEqual(['storage:get', 'storage:set']);
  });

  it('refuses an empty or malformed built-in list at construction', () => {
    expect(() => createModelPolicyPlugin({ builtinAllowed: [] })).toThrow(/builtinAllowed is invalid/);
    expect(() => createModelPolicyPlugin({ builtinAllowed: ['bare-id'] })).toThrow(/builtinAllowed is invalid/);
  });

  it('serves the built-in policy through models:get-policy, preferring Claude Sonnet as Default', async () => {
    const { bus } = bootBus();
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET] }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toEqual({
      allowed: [OPUS, SONNET],
      default: SONNET,
      source: 'builtin',
      version: 0,
    });
  });

  it('honours builtinDefault', async () => {
    const { bus } = bootBus();
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET], builtinDefault: OPUS }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toMatchObject({ default: OPUS });
  });

  it('serves a saved policy', async () => {
    const storage = new Map<string, Uint8Array>();
    storage.set(
      POLICY_STORAGE_KEY,
      serializeStored({ version: 2, allowed: [OPUS], default: OPUS, updatedAt: 'T', updatedBy: 'u' }),
    );
    const { bus } = bootBus(storage);
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET], ttlMs: 0 }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:get-policy', ctx, {})).toEqual({
      allowed: [OPUS],
      default: OPUS,
      source: 'admin',
      version: 2,
    });
  });
});
```

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/plugin.test.ts`
Expected: FAIL — `Cannot find module '../plugin.js'`.

`packages/model-policy/src/plugin.ts`:

```ts
import { PluginError, type Plugin } from '@ax/core';
import { z, type ZodType } from 'zod';
import { pickDefault, validatePolicyInput } from './policy.js';
import { createPolicyStore } from './policy-store.js';
import { PLUGIN_NAME, SERVICE_GET_POLICY } from './shared.js';

export interface ModelPolicyConfig {
  /** The list in force until an admin saves one (composition roots pass `resolveAllowedModels(...)`). */
  builtinAllowed: readonly string[];
  /** Preferred built-in Default; falls back to Claude Sonnet, then the first entry. */
  builtinDefault?: string;
  now?: () => Date;
  ttlMs?: number;
}

export interface GetPolicyOutput {
  allowed: string[];
  default: string;
  source: 'admin' | 'builtin';
  version: number;
}

const GetPolicyOutputSchema = z.object({
  allowed: z.array(z.string()),
  default: z.string(),
  source: z.union([z.literal('admin'), z.literal('builtin')]),
  version: z.number(),
}) as unknown as ZodType<GetPolicyOutput>;

export function createModelPolicyPlugin(config: ModelPolicyConfig): Plugin {
  const allowed = [...config.builtinAllowed];
  const builtin = { allowed, default: pickDefault(allowed, config.builtinDefault) };
  const check = validatePolicyInput(builtin);
  if (!check.ok) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `builtinAllowed is invalid: ${check.message}`,
    });
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [SERVICE_GET_POLICY],
      calls: ['storage:get', 'storage:set'],
      subscribes: [],
    },
    async init({ bus }) {
      const store = createPolicyStore({
        bus,
        builtin,
        ...(config.now !== undefined ? { now: config.now } : {}),
        ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
      });
      // The bus cannot unregister a service, so registering it last keeps a
      // throwing init from leaving a half-wired hook behind (usage-limits does the same).
      bus.registerService<Record<string, never>, GetPolicyOutput>(
        SERVICE_GET_POLICY,
        PLUGIN_NAME,
        async (ctx) => {
          const v = await store.read(ctx);
          return { allowed: v.allowed, default: v.default, source: v.source, version: v.version };
        },
        { returns: GetPolicyOutputSchema },
      );
    },
  };
}
```

- [x] **Step 10: Run the whole package, build, and commit**

Run: `pnpm --filter @ax/model-policy test`
Expected: PASS — all three test files.

Run: `pnpm --filter @ax/model-policy build`
Expected: exits 0 (type-checks the sources).

Run: `pnpm --filter @ax/model-policy exec tsc --noEmit -p . && npx eslint packages/model-policy/src`
Expected: exits 0 (the first command type-checks the package; tests are checked by Vitest at runtime).

```bash
git add packages/model-policy tsconfig.json pnpm-lock.yaml
git commit -m "feat(model-policy): policy store and models:get-policy hook

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The live catalog aggregator

**Files:**
- Create: `packages/model-policy/src/catalog.ts`
- Test: `packages/model-policy/src/__tests__/catalog.test.ts`
- Modify: `packages/model-policy/src/index.ts` (export the catalog)

**Interfaces:**
- Produces (used by Task 3): `createCatalog(deps: CatalogDeps): Catalog` with `get(ctx, { refresh }): Promise<CatalogResult>`; exported `sanitizeLabel(raw, fallback)`, `normalizeModels(provider, raw)`; types `ProviderStatus`, `CatalogModel`, `CatalogProvider`, `CatalogResult`.
- Consumes: per-provider `models:list-available:<id>` (`{} → { status: 'live' | 'no-key' | 'error'; models: { ref; label }[] }`, **soft**: skipped when not registered) and `models:list-supported:<id>` (`{} → { models: { id; label }[] }`, soft fallback); `PROVIDER_ENDPOINTS` from `@ax/core`.

- [x] **Step 1: Write the failing tests**

`packages/model-policy/src/__tests__/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { createCatalog, normalizeModels, sanitizeLabel } from '../catalog.js';

function logger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  const l = {
    warns,
    debug() {},
    info() {},
    warn(msg: string) {
      warns.push(msg);
    },
    error() {},
    child() {
      return l;
    },
  } as Logger & { warns: string[] };
  return l;
}

const log = logger();
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'admin', logger: log });
const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openrouter', name: 'OpenRouter' },
];

type Out = { status: 'live' | 'no-key' | 'error'; models: Array<{ ref: string; label: string }> };

function boot(handlers: Record<string, (() => Promise<unknown>) | undefined>) {
  const bus = new HookBus();
  const calls: Record<string, number> = {};
  for (const [hook, fn] of Object.entries(handlers)) {
    if (fn === undefined) continue;
    bus.registerService(hook, 'test', async () => {
      calls[hook] = (calls[hook] ?? 0) + 1;
      return fn();
    });
  }
  let t = 1_000_000;
  const catalog = createCatalog({
    bus,
    providers: PROVIDERS,
    now: () => t,
    ttlMs: 600_000,
    timeoutMs: 50,
    minRefreshMs: 15_000,
  });
  return { catalog, calls, advance: (ms: number) => (t += ms) };
}

const live = (...refs: string[]): Out => ({
  status: 'live',
  models: refs.map((ref) => ({ ref, label: `Label ${ref}` })),
});

describe('sanitizeLabel', () => {
  it('strips control, bidirectional and invisible characters and collapses whitespace', () => {
    expect(sanitizeLabel('  Claude‮ Son\u0000net\n 4.6​ ', 'fb')).toBe('Claude Son net 4.6');
  });
  it('caps the length at 120 characters', () => {
    expect(sanitizeLabel('a'.repeat(10_000), 'fb')).toHaveLength(120);
  });
  it('falls back for empty, whitespace-only, and non-string labels', () => {
    expect(sanitizeLabel('', 'fb')).toBe('fb');
    expect(sanitizeLabel('‮​', 'fb')).toBe('fb');
    expect(sanitizeLabel(42, 'fb')).toBe('fb');
  });
});

describe('normalizeModels', () => {
  it('keeps valid refs for the provider, dedupes, and sanitises labels', () => {
    expect(
      normalizeModels('openrouter', [
        { ref: 'openrouter/x-ai/grok-4.6', label: 'Grok‮ 4.6' },
        { ref: 'openrouter/x-ai/grok-4.6', label: 'dup' },
        { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'GPT batch' },
      ]),
    ).toEqual([
      { ref: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6' },
      { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'GPT batch' },
    ]);
  });

  it('accepts the list-supported shape ({ id, label })', () => {
    expect(normalizeModels('anthropic', [{ id: 'anthropic/claude-opus-4-7', label: 'Opus' }])).toEqual([
      { ref: 'anthropic/claude-opus-4-7', label: 'Opus' },
    ]);
  });

  it('drops hostile entries instead of failing', () => {
    const hostile = [
      { ref: 'anthropic/claude-x', label: 'wrong provider' }, // wrong prefix for openrouter
      { ref: 'openrouter/has space', label: 'x' },
      { ref: 'openrouter/evil‮id', label: 'x' },
      { ref: 'openrouter/line\nbreak', label: 'x' },
      { ref: `openrouter/${'a'.repeat(300)}`, label: 'too long' },
      { ref: 'nope', label: 'bare' },
      { ref: 42, label: 'not a string' },
      null,
      'a string',
      { label: 'no ref' },
    ];
    expect(normalizeModels('openrouter', hostile)).toEqual([]);
  });

  it('caps the list at 2000 models', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ ref: `openrouter/v/m-${i}`, label: `M${i}` }));
    expect(normalizeModels('openrouter', many)).toHaveLength(2000);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeModels('openrouter', { nope: true })).toEqual([]);
  });
});

describe('createCatalog.get', () => {
  it('omits providers that register no list-available hook', async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('returns live models with a fetchedAt and the provider display name', async () => {
    const { catalog } = boot({ 'models:list-available:anthropic': async () => live('anthropic/claude-opus-4-7') });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({
      id: 'anthropic',
      name: 'Anthropic',
      status: 'live',
      models: [{ ref: 'anthropic/claude-opus-4-7', label: 'Label anthropic/claude-opus-4-7' }],
    });
    expect(typeof r.providers[0]!.fetchedAt).toBe('string');
  });

  it('reuses the cache inside the ttl and refetches after it', async () => {
    const { catalog, calls, advance } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    await catalog.get(ctx, { refresh: false });
    await catalog.get(ctx, { refresh: false });
    expect(calls['models:list-available:openrouter']).toBe(1);
    advance(600_001);
    await catalog.get(ctx, { refresh: false });
    expect(calls['models:list-available:openrouter']).toBe(2);
  });

  it('forces a refresh past the cache, but at most once per 15 s per provider', async () => {
    const { catalog, calls, advance } = boot({ 'models:list-available:openrouter': async () => live('openrouter/a/b') });
    await catalog.get(ctx, { refresh: false }); // 1
    await catalog.get(ctx, { refresh: true }); // forced: 2
    await catalog.get(ctx, { refresh: true }); // rate-limited: served from cache
    expect(calls['models:list-available:openrouter']).toBe(2);
    advance(15_001);
    await catalog.get(ctx, { refresh: true }); // allowed again: 3
    expect(calls['models:list-available:openrouter']).toBe(3);
  });

  it('reports no-key with no models', async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => ({ status: 'no-key', models: [] }) });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ id: 'openrouter', status: 'no-key', models: [] });
  });

  it('falls back to models:list-supported when the provider fails and nothing is cached', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => {
        throw new Error('boom');
      },
      'models:list-supported:openrouter': async () => ({
        models: [{ id: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6', kind: 'either' }],
      }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({
      status: 'fallback',
      models: [{ ref: 'openrouter/x-ai/grok-4.6', label: 'Grok 4.6' }],
    });
    expect(log.warns).toContain('model_catalog_provider_failed');
  });

  it("reports 'error' with no models when there is no fallback either", async () => {
    const { catalog } = boot({ 'models:list-available:openrouter': async () => ({ status: 'error', models: [] }) });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'error', models: [] });
  });

  it("serves the last good list as 'cached' when a later fetch fails", async () => {
    let fail = false;
    const { catalog, advance } = boot({
      'models:list-available:openrouter': async () => (fail ? { status: 'error', models: [] } : live('openrouter/a/b')),
    });
    await catalog.get(ctx, { refresh: false });
    fail = true;
    advance(600_001);
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'cached', models: [{ ref: 'openrouter/a/b' }] });
  });

  it('treats a live answer with no valid models as a failure (broken response shape)', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => ({ status: 'live', models: [{ ref: 'nope', label: 'x' }] }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]).toMatchObject({ status: 'error', models: [] });
  });

  it('times out a slow provider without holding up the other one', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': () => new Promise(() => {}), // never resolves
      'models:list-available:anthropic': async () => live('anthropic/claude-opus-4-7'),
    });
    const r = await catalog.get(ctx, { refresh: false });
    const byId = Object.fromEntries(r.providers.map((p) => [p.id, p.status]));
    expect(byId).toEqual({ anthropic: 'live', openrouter: 'error' });
  });

  it('sanitises and filters what a provider returns', async () => {
    const { catalog } = boot({
      'models:list-available:openrouter': async () => ({
        status: 'live',
        models: [
          { ref: 'openrouter/ok/one', label: 'One‮' },
          { ref: 'openrouter/bad id', label: 'spaces' },
          { ref: 'anthropic/not-mine', label: 'wrong provider' },
        ],
      }),
    });
    const r = await catalog.get(ctx, { refresh: false });
    expect(r.providers[0]!.models).toEqual([{ ref: 'openrouter/ok/one', label: 'One' }]);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/catalog.test.ts`
Expected: FAIL — `Cannot find module '../catalog.js'`.

- [x] **Step 3: Implement `catalog.ts`**

`packages/model-policy/src/catalog.ts`:

```ts
import { PROVIDER_ENDPOINTS, isModelRef, parseModelRef, type AgentContext, type HookBus } from '@ax/core';
import { MAX_REF_CHARS } from './shared.js';

export type ProviderStatus = 'live' | 'cached' | 'fallback' | 'no-key' | 'error';

export interface CatalogModel {
  ref: string;
  label: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  status: ProviderStatus;
  fetchedAt?: string;
  models: CatalogModel[];
}

export interface CatalogResult {
  providers: CatalogProvider[];
}

export interface Catalog {
  get(ctx: AgentContext, opts: { refresh: boolean }): Promise<CatalogResult>;
}

export interface CatalogDeps {
  bus: HookBus;
  /** Defaults to every provider in `PROVIDER_ENDPOINTS`. */
  providers?: ReadonlyArray<{ id: string; name: string }>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  minRefreshMs?: number;
}

const LABEL_MAX = 120;
const MODELS_PER_PROVIDER_MAX = 2000;
// Control characters, soft hyphen, zero-width, bidirectional overrides/isolates, BOM.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F­​-‏ -‮⁠-⁯﻿]/g;
// A ref is a routing key, so it gets a strict allow-list rather than a block-list.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

export function sanitizeLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Accepts `{ ref, label }` (list-available) and `{ id, label }` (list-supported). Drops anything unsafe. */
export function normalizeModels(provider: string, raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const item of raw) {
    if (out.length >= MODELS_PER_PROVIDER_MAX) break;
    if (typeof item !== 'object' || item === null) continue;
    const { ref, id, label } = item as { ref?: unknown; id?: unknown; label?: unknown };
    const candidate = typeof ref === 'string' ? ref : typeof id === 'string' ? id : undefined;
    if (candidate === undefined || candidate.length > MAX_REF_CHARS) continue;
    if (!SAFE_REF.test(candidate) || !isModelRef(candidate)) continue;
    if (parseModelRef(candidate).provider !== provider || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push({ ref: candidate, label: sanitizeLabel(label, candidate) });
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface ProviderState {
  good?: { models: CatalogModel[]; at: number };
  lastForcedAt?: number;
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const providers =
    deps.providers ?? Object.values(PROVIDER_ENDPOINTS).map((p) => ({ id: p.id, name: p.name }));
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 600_000;
  const timeoutMs = deps.timeoutMs ?? 8_000;
  const minRefreshMs = deps.minRefreshMs ?? 15_000;
  const states = new Map<string, ProviderState>();

  async function fallbackFor(
    ctx: AgentContext,
    p: { id: string; name: string },
    st: ProviderState,
  ): Promise<CatalogProvider> {
    if (st.good !== undefined) {
      return {
        id: p.id,
        name: p.name,
        status: 'cached',
        fetchedAt: new Date(st.good.at).toISOString(),
        models: st.good.models,
      };
    }
    const hook = `models:list-supported:${p.id}`;
    if (deps.bus.hasService(hook)) {
      try {
        const out = await deps.bus.call<Record<string, never>, { models?: unknown }>(hook, ctx, {});
        const models = normalizeModels(p.id, out.models);
        if (models.length > 0) return { id: p.id, name: p.name, status: 'fallback', models };
      } catch (err) {
        ctx.logger.warn('model_catalog_fallback_failed', {
          provider: p.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { id: p.id, name: p.name, status: 'error', models: [] };
  }

  async function loadOne(
    ctx: AgentContext,
    p: { id: string; name: string },
    refresh: boolean,
  ): Promise<CatalogProvider> {
    const st = states.get(p.id) ?? {};
    states.set(p.id, st);
    const t = now();
    let force = false;
    if (refresh && (st.lastForcedAt === undefined || t - st.lastForcedAt >= minRefreshMs)) {
      force = true;
      st.lastForcedAt = t;
    }
    if (!force && st.good !== undefined && t - st.good.at < ttlMs) {
      return {
        id: p.id,
        name: p.name,
        status: 'live',
        fetchedAt: new Date(st.good.at).toISOString(),
        models: st.good.models,
      };
    }
    let out: { status?: unknown; models?: unknown } | undefined;
    try {
      out = await withTimeout(
        deps.bus.call<Record<string, never>, { status?: unknown; models?: unknown }>(
          `models:list-available:${p.id}`,
          ctx,
          {},
        ),
        timeoutMs,
      );
    } catch (err) {
      ctx.logger.warn('model_catalog_provider_failed', {
        provider: p.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (out?.status === 'no-key') return { id: p.id, name: p.name, status: 'no-key', models: [] };
    if (out?.status === 'live') {
      const models = normalizeModels(p.id, out.models);
      if (models.length > 0) {
        const at = now();
        st.good = { models, at };
        return { id: p.id, name: p.name, status: 'live', fetchedAt: new Date(at).toISOString(), models };
      }
    }
    return fallbackFor(ctx, p, st);
  }

  return {
    async get(ctx, opts) {
      const active = providers.filter((p) => deps.bus.hasService(`models:list-available:${p.id}`));
      return { providers: await Promise.all(active.map((p) => loadOne(ctx, p, opts.refresh))) };
    },
  };
}
```

- [x] **Step 4: Export, run, commit**

Add to `packages/model-policy/src/index.ts`:

```ts
export {
  createCatalog,
  normalizeModels,
  sanitizeLabel,
  type Catalog,
  type CatalogModel,
  type CatalogProvider,
  type CatalogResult,
  type ProviderStatus,
} from './catalog.js';
```

Run: `pnpm --filter @ax/model-policy test`
Expected: PASS — four test files.

Run: `pnpm --filter @ax/model-policy build && npx eslint packages/model-policy/src`
Expected: exits 0.

```bash
git add packages/model-policy
git commit -m "feat(model-policy): live catalog aggregator with cache, timeout and fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Admin routes and plugin wiring

**Files:**
- Modify: `packages/model-policy/src/shared.ts` (route types + `requireAdmin` + `parseRequestBody`), `packages/model-policy/src/plugin.ts`, `packages/model-policy/src/index.ts`
- Create: `packages/model-policy/src/routes.ts`
- Test: `packages/model-policy/src/__tests__/routes.test.ts`; update `src/__tests__/plugin.test.ts`

**Interfaces:**
- Consumes: `createPolicyStore` / `PolicyStore` (Task 1), `createCatalog` / `Catalog` (Task 2), `auth:require-user` (`{ req } → { user: { id; isAdmin } }`), `http:register-route` (`{ method; path; handler; maxBodyBytes? } → { unregister }`).
- Produces (used by Task 11): HTTP contract
  - `GET /admin/models/catalog[?refresh=1]` → `200 { providers: CatalogProvider[] }`
  - `GET /admin/models/policy` → `200 PolicyView`
  - `PUT /admin/models/policy` body `{ baseVersion, allowed, default }` → `200 PolicyView` · `400 { error: PolicyErrorCode | 'invalid-payload' | 'invalid-json', message? }` · `409 { error: 'stale-version' }` · `413 { error: 'body-too-large' }`
  - 401 `{ error: 'unauthenticated' }` / 403 `{ error: 'forbidden' }` on all three.

- [x] **Step 1: Extend `shared.ts` with the route helpers**

Append to `packages/model-policy/src/shared.ts` (and add the import line at the very top of the file):

```ts
import { PluginError, isRejection, type AgentContext, type HookBus } from '@ax/core';
```

```ts
export interface RouteRequest {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  signedCookie(name: string): string | null;
}

export interface RouteResponse {
  status(n: number): RouteResponse;
  header(name: string, value: string): RouteResponse;
  json(v: unknown): void;
  text(s: string): void;
  end(): void;
}

export interface AuthedUser {
  id: string;
  isAdmin: boolean;
}

/** 401 when there is no session, 403 when the user is not an admin. Returns the admin, or null after answering. */
export async function requireAdmin(
  bus: HookBus,
  ctx: AgentContext,
  req: RouteRequest,
  res: RouteResponse,
): Promise<AuthedUser | null> {
  let actor: AuthedUser;
  try {
    const result = await bus.call<{ req: RouteRequest }, { user: { id: string; isAdmin: boolean } }>(
      'auth:require-user',
      ctx,
      { req },
    );
    actor = { id: result.user.id, isAdmin: result.user.isAdmin };
  } catch (err) {
    if (err instanceof PluginError || isRejection(err)) {
      res.status(401).json({ error: 'unauthenticated' });
      return null;
    }
    throw err;
  }
  if (actor.isAdmin !== true) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export function parseRequestBody(body: Buffer): ParseBodyResult {
  if (body.length > POLICY_BODY_MAX_BYTES) return { ok: false, status: 413, message: 'body-too-large' };
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, message: 'invalid-json' };
  }
}
```

- [x] **Step 2: Write the failing route tests**

`packages/model-policy/src/__tests__/routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createCatalog } from '../catalog.js';
import { createPolicyStore } from '../policy-store.js';
import { createHandlers, registerModelPolicyRoutes } from '../routes.js';
import type { RouteRequest, RouteResponse } from '../shared.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

function mkRes() {
  let status = 200;
  let json: unknown;
  const res: RouteResponse = {
    status(n) {
      status = n;
      return res;
    },
    header() {
      return res;
    },
    json(v) {
      json = v;
    },
    text() {},
    end() {},
  };
  return { res, statusOf: () => status, jsonOf: () => json };
}

function mkReq(opts: { body?: unknown; rawBody?: Buffer; query?: Record<string, string> } = {}): RouteRequest {
  return {
    headers: {},
    body:
      opts.rawBody ?? (opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body))),
    cookies: {},
    query: opts.query ?? {},
    params: {},
    signedCookie: () => null,
  };
}

function setup(auth: { id: string; isAdmin: boolean } | 'throw' = { id: 'admin-1', isAdmin: true }) {
  const bus = new HookBus();
  const storage = new Map<string, Uint8Array>();
  const captured: Array<{ method: string; path: string; handler: unknown; maxBodyBytes?: number }> = [];
  let who = auth;
  let openrouterCalls = 0;
  let lastUserId: string | undefined;
  bus.registerService('auth:require-user', 'test', async () => {
    if (who === 'throw') throw new PluginError({ code: 'unauthenticated', plugin: 'test', message: 'no cookie' });
    return { user: who };
  });
  bus.registerService<{ key: string }, { value: Uint8Array | undefined }>('storage:get', 'test', async (_c, i) => ({
    value: storage.get(i.key),
  }));
  bus.registerService<{ key: string; value: Uint8Array }, Record<string, never>>('storage:set', 'test', async (_c, i) => {
    storage.set(i.key, i.value);
    return {};
  });
  bus.registerService('http:register-route', 'test', async (_c, i) => {
    captured.push(i as never);
    return { unregister: () => {} };
  });
  bus.registerService('models:list-available:openrouter', 'test', async (c) => {
    openrouterCalls += 1;
    lastUserId = (c as { userId?: string }).userId;
    return { status: 'live', models: [{ ref: KIMI, label: 'Kimi K3' }] };
  });
  const store = createPolicyStore({ bus, builtin: { allowed: [OPUS, SONNET], default: SONNET }, ttlMs: 0 });
  const catalog = createCatalog({ bus, providers: [{ id: 'openrouter', name: 'OpenRouter' }], minRefreshMs: 0 });
  const handlers = createHandlers({ bus, store, catalog });
  return {
    bus,
    storage,
    captured,
    handlers,
    setAuth: (a: typeof auth) => (who = a),
    openrouterCalls: () => openrouterCalls,
    lastUserId: () => lastUserId,
  };
}

async function run(
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>,
  req: RouteRequest,
) {
  const r = mkRes();
  await handler(req, r.res);
  return r;
}

describe('admin gate', () => {
  it.each(['catalog', 'getPolicy', 'putPolicy'] as const)('%s → 401 without a session', async (name) => {
    const h = setup('throw');
    const r = await run(h.handlers[name], mkReq({ body: {} }));
    expect(r.statusOf()).toBe(401);
    expect(r.jsonOf()).toEqual({ error: 'unauthenticated' });
  });

  it.each(['catalog', 'getPolicy', 'putPolicy'] as const)('%s → 403 for a non-admin', async (name) => {
    const h = setup({ id: 'u1', isAdmin: false });
    const r = await run(h.handlers[name], mkReq({ body: {} }));
    expect(r.statusOf()).toBe(403);
    expect(r.jsonOf()).toEqual({ error: 'forbidden' });
  });
});

describe('GET /admin/models/policy', () => {
  it('returns the built-in policy before any save', async () => {
    const h = setup();
    const r = await run(h.handlers.getPolicy, mkReq());
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toEqual({ source: 'builtin', version: 0, allowed: [OPUS, SONNET], default: SONNET });
  });
});

describe('PUT /admin/models/policy', () => {
  it('saves and returns the new policy, recording who saved it', async () => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [KIMI, SONNET], default: KIMI } }));
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toMatchObject({ source: 'admin', version: 1, allowed: [KIMI, SONNET], default: KIMI, updatedBy: 'admin-1' });
    const again = await run(h.handlers.getPolicy, mkReq());
    expect(again.jsonOf()).toMatchObject({ version: 1, default: KIMI });
  });

  it.each([
    ['an empty selection', { baseVersion: 0, allowed: [], default: SONNET }, 'pick-at-least-one-model'],
    ['a Default that is not selected', { baseVersion: 0, allowed: [SONNET], default: OPUS }, 'default-not-selected'],
    ['a bare id', { baseVersion: 0, allowed: ['nope'], default: 'nope' }, 'invalid-model-ref'],
    ['a duplicate', { baseVersion: 0, allowed: [SONNET, SONNET], default: SONNET }, 'duplicate-model'],
  ])('400s on %s and writes nothing', async (_l, body, code) => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body }));
    expect(r.statusOf()).toBe(400);
    expect(r.jsonOf()).toMatchObject({ error: code });
    expect(h.storage.size).toBe(0);
  });

  it.each([
    ['a missing baseVersion', { allowed: [SONNET], default: SONNET }],
    ['a fractional baseVersion', { baseVersion: 0.5, allowed: [SONNET], default: SONNET }],
    ['a negative baseVersion', { baseVersion: -1, allowed: [SONNET], default: SONNET }],
    ['an unknown extra key', { baseVersion: 0, allowed: [SONNET], default: SONNET, extra: 1 }],
  ])('400s on %s', async (_l, body) => {
    const h = setup();
    const r = await run(h.handlers.putPolicy, mkReq({ body }));
    expect(r.statusOf()).toBe(400);
    expect(r.jsonOf()).toMatchObject({ error: 'invalid-payload' });
  });

  it('400s on invalid JSON and 413s on an oversized body', async () => {
    const h = setup();
    expect((await run(h.handlers.putPolicy, mkReq({ rawBody: Buffer.from('{nope') }))).statusOf()).toBe(400);
    const big = Buffer.alloc(256 * 1024 + 1, 0x20);
    expect((await run(h.handlers.putPolicy, mkReq({ rawBody: big }))).statusOf()).toBe(413);
  });

  it('409s on a stale baseVersion', async () => {
    const h = setup();
    await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [SONNET], default: SONNET } }));
    const r = await run(h.handlers.putPolicy, mkReq({ body: { baseVersion: 0, allowed: [OPUS], default: OPUS } }));
    expect(r.statusOf()).toBe(409);
    expect(r.jsonOf()).toEqual({ error: 'stale-version' });
  });
});

describe('GET /admin/models/catalog', () => {
  it("lists providers, and looks up keys as the requesting admin (not a fixed 'system' user)", async () => {
    const h = setup();
    const r = await run(h.handlers.catalog, mkReq());
    expect(r.statusOf()).toBe(200);
    expect(r.jsonOf()).toMatchObject({ providers: [{ id: 'openrouter', status: 'live', models: [{ ref: KIMI }] }] });
    expect(h.lastUserId()).toBe('admin-1');
  });

  it('honours ?refresh=1', async () => {
    const h = setup();
    await run(h.handlers.catalog, mkReq());
    await run(h.handlers.catalog, mkReq());
    expect(h.openrouterCalls()).toBe(1); // cached
    await run(h.handlers.catalog, mkReq({ query: { refresh: '1' } }));
    expect(h.openrouterCalls()).toBe(2);
  });
});

describe('registerModelPolicyRoutes', () => {
  it('registers the three routes, with a 256 KiB cap on the PUT', async () => {
    const h = setup();
    const unregisters = await registerModelPolicyRoutes(
      h.bus,
      makeAgentContext({ sessionId: 'init', agentId: '@ax/model-policy', userId: 'system' }),
      h.handlers,
    );
    expect(unregisters).toHaveLength(3);
    expect(h.captured.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/models/catalog',
      'GET /admin/models/policy',
      'PUT /admin/models/policy',
    ]);
    expect(h.captured.find((r) => r.method === 'PUT')?.maxBodyBytes).toBe(256 * 1024);
  });
});
```

- [x] **Step 3: Run to verify failure, then implement `routes.ts`**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/routes.test.ts`
Expected: FAIL — `Cannot find module '../routes.js'`.

`packages/model-policy/src/routes.ts`:

```ts
import { makeAgentContext, type AgentContext, type HookBus } from '@ax/core';
import { z } from 'zod';
import type { Catalog } from './catalog.js';
import type { PolicyStore } from './policy-store.js';
import {
  PLUGIN_NAME,
  POLICY_BODY_MAX_BYTES,
  parseRequestBody,
  requireAdmin,
  type RouteRequest,
  type RouteResponse,
} from './shared.js';

export interface RouteHandlers {
  catalog(req: RouteRequest, res: RouteResponse): Promise<void>;
  getPolicy(req: RouteRequest, res: RouteResponse): Promise<void>;
  putPolicy(req: RouteRequest, res: RouteResponse): Promise<void>;
}

const putBodySchema = z
  .object({
    baseVersion: z.number().int().min(0),
    allowed: z.unknown(),
    default: z.unknown(),
  })
  .strict();

export function createHandlers(deps: { bus: HookBus; store: PolicyStore; catalog: Catalog }): RouteHandlers {
  // Run every request as the admin who made it, so the provider hooks look up
  // that admin's key first and the global one second (never a fixed 'system' user).
  const ctxFor = (userId: string): AgentContext =>
    makeAgentContext({ sessionId: 'model-policy', agentId: PLUGIN_NAME, userId });

  return {
    async catalog(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      const result = await deps.catalog.get(ctxFor(actor.id), { refresh: req.query.refresh === '1' });
      res.status(200).json(result);
    },

    async getPolicy(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      res.status(200).json(await deps.store.read(ctxFor(actor.id)));
    },

    async putPolicy(req, res) {
      const actor = await requireAdmin(deps.bus, ctxFor('system'), req, res);
      if (actor === null) return;
      const body = parseRequestBody(req.body);
      if (!body.ok) {
        res.status(body.status).json({ error: body.message });
        return;
      }
      const shape = putBodySchema.safeParse(body.value);
      if (!shape.success) {
        res.status(400).json({ error: 'invalid-payload', message: 'baseVersion must be a whole number of 0 or more' });
        return;
      }
      const result = await deps.store.save(ctxFor(actor.id), shape.data, actor.id);
      if (result.ok) {
        res.status(200).json(result.policy);
        return;
      }
      if (result.code === 'stale-version') {
        res.status(409).json({ error: 'stale-version' });
        return;
      }
      res.status(400).json({ error: result.code, message: result.message });
    },
  };
}

interface RouteSpec {
  method: 'GET' | 'PUT';
  path: string;
  handler: (req: RouteRequest, res: RouteResponse) => Promise<void>;
  maxBodyBytes?: number;
}

/** Register the three routes. Returns the unregister callbacks; on a partial failure it unwinds what it registered. */
export async function registerModelPolicyRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  handlers: RouteHandlers,
): Promise<Array<() => void>> {
  const routes: RouteSpec[] = [
    { method: 'GET', path: '/admin/models/catalog', handler: handlers.catalog },
    { method: 'GET', path: '/admin/models/policy', handler: handlers.getPolicy },
    { method: 'PUT', path: '/admin/models/policy', handler: handlers.putPolicy, maxBodyBytes: POLICY_BODY_MAX_BYTES },
  ];
  const unregisters: Array<() => void> = [];
  try {
    for (const route of routes) {
      const result = await bus.call<RouteSpec, { unregister: () => void }>('http:register-route', initCtx, route);
      unregisters.push(result.unregister);
    }
  } catch (err) {
    while (unregisters.length > 0) {
      try {
        unregisters.pop()?.();
      } catch {
        /* best effort while unwinding */
      }
    }
    throw err;
  }
  return unregisters;
}
```

- [x] **Step 4: Run the route tests to verify they pass**

Run: `pnpm --filter @ax/model-policy exec vitest run src/__tests__/routes.test.ts`
Expected: PASS.

- [x] **Step 5: Wire routes into the plugin and update its test**

Edit `packages/model-policy/src/plugin.ts`:

1. Replace the import line `import { PluginError, type Plugin } from '@ax/core';` with:

```ts
import { PluginError, makeAgentContext, type Plugin } from '@ax/core';
```

2. Add imports:

```ts
import { createCatalog } from './catalog.js';
import { createHandlers, registerModelPolicyRoutes } from './routes.js';
```

3. Replace the `return { manifest: ..., async init ... }` object (everything from `return {` inside `createModelPolicyPlugin` to its closing `};`) with:

```ts
  const unregisterRoutes: Array<() => void> = [];

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [SERVICE_GET_POLICY],
      calls: ['http:register-route', 'auth:require-user', 'storage:get', 'storage:set'],
      subscribes: [],
    },
    async init({ bus }) {
      const store = createPolicyStore({
        bus,
        builtin,
        ...(config.now !== undefined ? { now: config.now } : {}),
        ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
      });
      const catalog = createCatalog({ bus });
      const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
      unregisterRoutes.push(...(await registerModelPolicyRoutes(bus, initCtx, createHandlers({ bus, store, catalog }))));

      // The bus cannot unregister a service, so this goes last: a throwing init
      // (for example a route conflict above) never leaves a half-wired hook.
      bus.registerService<Record<string, never>, GetPolicyOutput>(
        SERVICE_GET_POLICY,
        PLUGIN_NAME,
        async (ctx) => {
          const v = await store.read(ctx);
          return { allowed: v.allowed, default: v.default, source: v.source, version: v.version };
        },
        { returns: GetPolicyOutputSchema },
      );
    },
    async shutdown() {
      while (unregisterRoutes.length > 0) {
        try {
          unregisterRoutes.pop()?.();
        } catch (err) {
          console.warn(`[${PLUGIN_NAME}] failed to unregister a route during shutdown`, err);
        }
      }
    },
  };
```

Edit `packages/model-policy/src/__tests__/plugin.test.ts`:

- Change the expected `calls` in the first test to `['http:register-route', 'auth:require-user', 'storage:get', 'storage:set']`.
- Change the `bootBus` signature to `function bootBus(storage = new Map<string, Uint8Array>(), routes: string[] = [])` and, inside it (before `return { bus, storage };`), register the two services the routes need:

```ts
  bus.registerService('http:register-route', 'test', async (_c, input) => {
    const r = input as { method: string; path: string };
    routes.push(`${r.method} ${r.path}`);
    return { unregister: () => {} };
  });
  bus.registerService('auth:require-user', 'test', async () => ({ user: { id: 'u', isAdmin: true } }));
```

Add this test to the `describe`:

```ts
  it('registers its three admin routes during init', async () => {
    const routes: string[] = [];
    const { bus } = bootBus(new Map(), routes);
    await createModelPolicyPlugin({ builtinAllowed: [OPUS, SONNET] }).init!({ bus, config: {} } as never);
    expect(routes.sort()).toEqual([
      'GET /admin/models/catalog',
      'GET /admin/models/policy',
      'PUT /admin/models/policy',
    ]);
  });
```

Add to `packages/model-policy/src/index.ts`:

```ts
export { createHandlers, registerModelPolicyRoutes, type RouteHandlers } from './routes.js';
```

- [x] **Step 6: Run everything, then commit**

Run: `pnpm --filter @ax/model-policy test`
Expected: PASS — five test files.

Run: `pnpm --filter @ax/model-policy build && npx eslint packages/model-policy/src`
Expected: exits 0.

```bash
git add packages/model-policy
git commit -m "feat(model-policy): admin routes for the catalog and the policy

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 4: `models:list-available:openrouter`

**Files:**
- Create: `packages/llm-openrouter/src/models-available.ts`
- Modify: `packages/llm-openrouter/src/plugin.ts` (import, manifest `registers`, key resolution in `init`, hook registration)
- Test: `packages/llm-openrouter/src/__tests__/models-available.test.ts`; update `packages/llm-openrouter/src/__tests__/plugin.test.ts` (manifest expectations at ~lines 20-33 and 48-58)

**Interfaces:**
- Produces (consumed by Task 2's catalog, by name over the bus): service `models:list-available:openrouter`, input `{}`, output `ModelsListAvailableOutput = { status: 'live' | 'no-key' | 'error'; models: { ref: string; label: string }[] }` where `ref = 'openrouter/' + <OpenRouter id>` and `label = <OpenRouter name>` (falls back to the id).
- Consumes: the plugin's existing `resolveApiKey(bus, ctx, cfg, credentialRef)` (throws a `PluginError` with `code: 'no-openrouter-credential'` when no key exists) and `cfg.fetchImpl`.

- [x] **Step 1: Write the failing tests**

`packages/llm-openrouter/src/__tests__/models-available.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createLlmOpenRouterPlugin } from '../plugin.js';
import { fetchOpenRouterModels } from '../models-available.js';

const BASE = 'https://openrouter.ai/api/v1';
const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

function stub(respond: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), method: init?.method, headers });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchOpenRouterModels', () => {
  it('maps the public list to refs and labels and sends the key as a Bearer token', async () => {
    const s = stub(() =>
      json({
        data: [
          { id: 'x-ai/grok-4.6', name: 'xAI: Grok 4.6' },
          { id: 'openai/gpt-6.1-sol-pro:batch', name: 'OpenAI: GPT-6.1 Sol Pro (batch)' },
          { id: 'no-name/model' },
        ],
      }),
    );
    const out = await fetchOpenRouterModels(s.impl, BASE, 'sk-or-secret');
    expect(out).toEqual({
      status: 'live',
      models: [
        { ref: 'openrouter/x-ai/grok-4.6', label: 'xAI: Grok 4.6' },
        { ref: 'openrouter/openai/gpt-6.1-sol-pro:batch', label: 'OpenAI: GPT-6.1 Sol Pro (batch)' },
        { ref: 'openrouter/no-name/model', label: 'no-name/model' },
      ],
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ url: `${BASE}/models`, method: 'GET' });
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-or-secret');
  });

  it('skips entries without a usable id', async () => {
    const s = stub(() => json({ data: [{ id: 42 }, { id: '' }, null, 'x', { id: 'ok/one', name: 'One' }] }));
    const out = await fetchOpenRouterModels(s.impl, BASE, 'k');
    expect(out.models.map((m) => m.ref)).toEqual(['openrouter/ok/one']);
  });

  it.each([
    ['a non-200 answer', () => json({ error: 'nope' }, 500)],
    ['malformed JSON', () => new Response('{nope', { status: 200 })],
    ['a body without a data array', () => json({ data: 'nope' })],
    ['a body over 5 MiB', () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 })],
  ])('reports an error for %s', async (_label, respond) => {
    const out = await fetchOpenRouterModels(stub(respond).impl, BASE, 'k');
    expect(out).toEqual({ status: 'error', models: [] });
  });

  it('reports an error when the network throws, and never echoes the key', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED sk-or-secret');
    }) as typeof fetch;
    const out = await fetchOpenRouterModels(impl, BASE, 'sk-or-secret');
    expect(out).toEqual({ status: 'error', models: [] });
    expect(JSON.stringify(out)).not.toContain('sk-or-secret');
  });
});

describe('models:list-available:openrouter (the registered hook)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });

  it('static mode: uses the configured key', async () => {
    const s = stub(() => json({ data: [{ id: 'a/b', name: 'B' }] }));
    const bus = new HookBus();
    await createLlmOpenRouterPlugin({ apiKey: 'sk-static', fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    const out = await bus.call('models:list-available:openrouter', ctx, {});
    expect(out).toEqual({ status: 'live', models: [{ ref: 'openrouter/a/b', label: 'B' }] });
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-static');
  });

  it('credential-resolution mode: uses the stored key for the calling user', async () => {
    const s = stub(() => json({ data: [{ id: 'a/b', name: 'B' }] }));
    const bus = new HookBus();
    const asked: Array<{ ref: string; userId: string }> = [];
    bus.registerService<{ ref: string; userId: string }, string>('credentials:get', 'test', async (_c, i) => {
      asked.push(i);
      return 'sk-from-store';
    });
    await createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    await bus.call('models:list-available:openrouter', ctx, {});
    expect(asked).toEqual([{ ref: 'provider:openrouter', userId: 'u1' }]);
    expect(s.calls[0]!.headers.authorization).toBe('Bearer sk-from-store');
  });

  it('credential-resolution mode with no key anywhere: no-key, and nothing goes on the wire', async () => {
    const s = stub(() => json({ data: [] }));
    const bus = new HookBus();
    bus.registerService('credentials:get', 'test', async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'none' });
    });
    await createLlmOpenRouterPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:openrouter', ctx, {})).toEqual({ status: 'no-key', models: [] });
    expect(s.calls).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/llm-openrouter exec vitest run src/__tests__/models-available.test.ts`
Expected: FAIL — `Cannot find module '../models-available.js'`.

- [x] **Step 3: Implement `models-available.ts`**

`packages/llm-openrouter/src/models-available.ts`:

```ts
import { z, type ZodType } from 'zod';

/** Full model list for the admin catalog. Local copy of the contract (invariant 2: the hook bus is the API). */
export interface ModelsListAvailableOutput {
  status: 'live' | 'no-key' | 'error';
  models: Array<{ ref: string; label: string }>;
}

export const ModelsListAvailableOutputSchema = z.object({
  status: z.union([z.literal('live'), z.literal('no-key'), z.literal('error')]),
  models: z.array(z.object({ ref: z.string(), label: z.string() })),
}) as unknown as ZodType<ModelsListAvailableOutput>;

const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;
const ERROR: ModelsListAvailableOutput = { status: 'error', models: [] };

/**
 * GET `${baseUrl}/models` (a fixed URL, never caller-supplied). The endpoint is
 * public; the key is sent anyway to match the plugin's other calls. Never
 * throws and never puts the key, or an upstream error object, in its result.
 */
export async function fetchOpenRouterModels(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
): Promise<ModelsListAvailableOutput> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return ERROR;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > LIST_MAX_BYTES) return ERROR;
    const body = JSON.parse(new TextDecoder().decode(buf)) as { data?: unknown };
    if (!Array.isArray(body.data)) return ERROR;
    const models: ModelsListAvailableOutput['models'] = [];
    for (const item of body.data) {
      if (typeof item !== 'object' || item === null) continue;
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || id.length === 0) continue;
      models.push({ ref: `openrouter/${id}`, label: typeof name === 'string' && name.length > 0 ? name : id });
    }
    return { status: 'live', models };
  } catch {
    return ERROR; // deliberately drops the error: it could echo request details
  } finally {
    clearTimeout(timer);
  }
}
```

- [x] **Step 4: Register the hook in `plugin.ts`**

Edit `packages/llm-openrouter/src/plugin.ts`:

1. Add next to the other relative imports:

```ts
import {
  fetchOpenRouterModels,
  ModelsListAvailableOutputSchema,
  type ModelsListAvailableOutput,
} from './models-available.js';
```

2. In the manifest, add `'models:list-available:openrouter',` to `registers`, right after `'models:list-supported:openrouter',`.

3. In `init`, right after `const fetchImpl = cfg.fetchImpl ?? fetch;` add:

```ts
      let keyFor: (ctx: AgentContext) => Promise<string>;
```

4. In the static branch, immediately after the `if (apiKey === undefined || apiKey.length === 0) { throw ... }` block and before `bus.registerService<LlmCallInput, LlmCallOutput>(` add:

```ts
        keyFor = async () => apiKey;
```

5. In the credential-resolution branch, immediately after the comment `// Credential-resolution mode: resolve the key for each call.` and before its `bus.registerService<LlmCallInput, LlmCallOutput>(` add:

```ts
        keyFor = (ctx) => resolveApiKey(bus, ctx, cfg, credentialRef);
```

6. Immediately after the closing `);` of the `models:list-supported:openrouter` registration add:

```ts
      // Full live list for the admin model picker (@ax/model-policy). A fixed URL,
      // the same key resolution as llm:call, and a structured answer even on
      // failure: no-key when nothing is stored, error for anything else.
      bus.registerService<unknown, ModelsListAvailableOutput>(
        'models:list-available:openrouter',
        PLUGIN_NAME,
        async (ctx) => {
          let apiKey: string;
          try {
            apiKey = await keyFor(ctx);
          } catch (err) {
            if (err instanceof PluginError && err.code === 'no-openrouter-credential') {
              return { status: 'no-key', models: [] };
            }
            return { status: 'error', models: [] };
          }
          return fetchOpenRouterModels(fetchImpl, ENDPOINT.baseUrl, apiKey);
        },
        { returns: ModelsListAvailableOutputSchema, timeoutMs: 15_000 },
      );
```

- [x] **Step 5: Update the existing manifest tests**

In `packages/llm-openrouter/src/__tests__/plugin.test.ts`, add `'models:list-available:openrouter'` to the expected `registers` array (the strict `toEqual` near lines 20-33, in the same position as in the manifest) and to the list of hooks the "every registered hook is present" test checks (near lines 48-58).

- [x] **Step 6: Run and commit**

Run: `pnpm --filter @ax/llm-openrouter test && pnpm --filter @ax/llm-openrouter build`
Expected: PASS and exit 0.

Run: `npx eslint packages/llm-openrouter/src`
Expected: exits 0.

```bash
git add packages/llm-openrouter
git commit -m "feat(llm-openrouter): models:list-available:openrouter for the admin catalog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `models:list-available:anthropic`

**Files:**
- Create: `packages/llm-anthropic/src/models-available.ts`
- Modify: `packages/llm-anthropic/src/plugin.ts` (config `fetchImpl`, import, manifest, key resolution, hook)
- Test: `packages/llm-anthropic/src/__tests__/models-available.test.ts`; update `packages/llm-anthropic/src/__tests__/plugin.test.ts` (strict manifest `toEqual` near lines 51-61)

**Interfaces:**
- Produces: service `models:list-available:anthropic`, input `{}`, output the same `ModelsListAvailableOutput` shape (`ref = 'anthropic/' + id`, `label = display_name`, falling back to the id).
- Consumes: the plugin's existing `resolveApiKey(bus, ctx, cfg, credentialRef)` (throws `code: 'no-anthropic-credential'`).
- API facts (from the vendor docs, 2026-09-30): `GET https://api.anthropic.com/v1/models` with headers `x-api-key` and `anthropic-version: 2023-06-01`; query `limit` (1–1000, default 20) and `after_id`; response `{ data: [{ id, display_name, type, created_at }], first_id, last_id, has_more }`, newest first.

- [x] **Step 1: Write the failing tests**

`packages/llm-anthropic/src/__tests__/models-available.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookBus, PluginError, makeAgentContext } from '@ax/core';
import { createLlmAnthropicPlugin } from '../plugin.js';
import { fetchAnthropicModels } from '../models-available.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u1' });

function stub(pages: Array<() => Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let n = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers });
    const page = pages[Math.min(n, pages.length - 1)]!;
    n += 1;
    return page();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchAnthropicModels', () => {
  it('lists models with the two required headers and a 1000-item page', async () => {
    const s = stub([
      () =>
        json({
          data: [
            { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', type: 'model' },
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', type: 'model' },
            { id: 'claude-noname' },
          ],
          has_more: false,
          last_id: 'claude-noname',
        }),
    ]);
    const out = await fetchAnthropicModels(s.impl, 'sk-ant-secret');
    expect(out).toEqual({
      status: 'live',
      models: [
        { ref: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
        { ref: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { ref: 'anthropic/claude-noname', label: 'claude-noname' },
      ],
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-secret');
    expect(s.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('follows has_more / last_id to the next page', async () => {
    const s = stub([
      () => json({ data: [{ id: 'm1', display_name: 'One' }], has_more: true, last_id: 'm1' }),
      () => json({ data: [{ id: 'm2', display_name: 'Two' }], has_more: false, last_id: 'm2' }),
    ]);
    const out = await fetchAnthropicModels(s.impl, 'k');
    expect(out.models.map((m) => m.ref)).toEqual(['anthropic/m1', 'anthropic/m2']);
    expect(s.calls[1]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=m1');
  });

  it('stops after 5 pages even if the server keeps saying has_more', async () => {
    const s = stub([() => json({ data: [{ id: 'm' }], has_more: true, last_id: 'm' })]);
    await fetchAnthropicModels(s.impl, 'k');
    expect(s.calls).toHaveLength(5);
  });

  it.each([
    ['a non-200 answer', () => json({ error: 'nope' }, 401)],
    ['malformed JSON', () => new Response('{nope', { status: 200 })],
    ['a body without a data array', () => json({ data: 'nope' })],
    ['a body over 5 MiB', () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { status: 200 })],
  ])('reports an error for %s', async (_label, respond) => {
    expect(await fetchAnthropicModels(stub([respond]).impl, 'k')).toEqual({ status: 'error', models: [] });
  });

  it('reports an error when the network throws, and never echoes the key', async () => {
    const impl = (async () => {
      throw new Error('boom sk-ant-secret');
    }) as typeof fetch;
    const out = await fetchAnthropicModels(impl, 'sk-ant-secret');
    expect(out).toEqual({ status: 'error', models: [] });
    expect(JSON.stringify(out)).not.toContain('sk-ant-secret');
  });
});

describe('models:list-available:anthropic (the registered hook)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('static mode: uses the configured key', async () => {
    const s = stub([() => json({ data: [{ id: 'm1', display_name: 'One' }], has_more: false })]);
    const bus = new HookBus();
    await createLlmAnthropicPlugin({ apiKey: 'sk-ant-static', fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:anthropic', ctx, {})).toEqual({
      status: 'live',
      models: [{ ref: 'anthropic/m1', label: 'One' }],
    });
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-static');
  });

  it('credential-resolution mode: uses the stored key for the calling user', async () => {
    const s = stub([() => json({ data: [{ id: 'm1' }], has_more: false })]);
    const bus = new HookBus();
    const asked: Array<{ ref: string; userId: string }> = [];
    bus.registerService<{ ref: string; userId: string }, string>('credentials:get', 'test', async (_c, i) => {
      asked.push(i);
      return 'sk-ant-from-store';
    });
    await createLlmAnthropicPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    await bus.call('models:list-available:anthropic', ctx, {});
    expect(asked).toEqual([{ ref: 'provider:anthropic', userId: 'u1' }]);
    expect(s.calls[0]!.headers['x-api-key']).toBe('sk-ant-from-store');
  });

  it('credential-resolution mode with no key anywhere: no-key, and nothing goes on the wire', async () => {
    const s = stub([() => json({ data: [] })]);
    const bus = new HookBus();
    bus.registerService('credentials:get', 'test', async () => {
      throw new PluginError({ code: 'not-found', plugin: '@ax/credentials', message: 'none' });
    });
    await createLlmAnthropicPlugin({ credentialResolution: true, fetchImpl: s.impl }).init!({ bus, config: {} } as never);
    expect(await bus.call('models:list-available:anthropic', ctx, {})).toEqual({ status: 'no-key', models: [] });
    expect(s.calls).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/llm-anthropic exec vitest run src/__tests__/models-available.test.ts`
Expected: FAIL — `Cannot find module '../models-available.js'`.

- [x] **Step 3: Implement `models-available.ts`**

`packages/llm-anthropic/src/models-available.ts`:

```ts
import { z, type ZodType } from 'zod';

/** Full model list for the admin catalog. Local copy of the contract (invariant 2: the hook bus is the API). */
export interface ModelsListAvailableOutput {
  status: 'live' | 'no-key' | 'error';
  models: Array<{ ref: string; label: string }>;
}

export const ModelsListAvailableOutputSchema = z.object({
  status: z.union([z.literal('live'), z.literal('no-key'), z.literal('error')]),
  models: z.array(z.object({ ref: z.string(), label: z.string() })),
}) as unknown as ZodType<ModelsListAvailableOutput>;

// Fixed URL + version, mirroring the provider-key validator's precedent. Not
// derived from ANTHROPIC_BASE_URL on purpose: this call carries the real key.
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const LIST_TIMEOUT_MS = 10_000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const ERROR: ModelsListAvailableOutput = { status: 'error', models: [] };

/** Never throws, and never puts the key or an upstream error object in its result. */
export async function fetchAnthropicModels(
  fetchImpl: typeof fetch,
  apiKey: string,
): Promise<ModelsListAvailableOutput> {
  const models: ModelsListAvailableOutput['models'] = [];
  let afterId: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = `${MODELS_URL}?limit=${PAGE_SIZE}${afterId !== undefined ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
      let body: { data?: unknown; has_more?: unknown; last_id?: unknown };
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          signal: ctrl.signal,
        });
        if (!res.ok) return ERROR;
        const buf = await res.arrayBuffer();
        if (buf.byteLength > LIST_MAX_BYTES) return ERROR;
        body = JSON.parse(new TextDecoder().decode(buf)) as typeof body;
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(body.data)) return ERROR;
      for (const item of body.data) {
        if (typeof item !== 'object' || item === null) continue;
        const { id, display_name: displayName } = item as { id?: unknown; display_name?: unknown };
        if (typeof id !== 'string' || id.length === 0) continue;
        models.push({
          ref: `anthropic/${id}`,
          label: typeof displayName === 'string' && displayName.length > 0 ? displayName : id,
        });
      }
      if (body.has_more === true && typeof body.last_id === 'string') {
        afterId = body.last_id;
        continue;
      }
      break;
    }
    return { status: 'live', models };
  } catch {
    return ERROR; // deliberately drops the error: it could echo request details
  }
}
```

- [x] **Step 4: Register the hook in `plugin.ts`**

Edit `packages/llm-anthropic/src/plugin.ts`:

1. In `LlmAnthropicConfig`, directly after the `credentialRef?: string;` field (before the closing `}`), add:

```ts
  /** Test seam for `models:list-available:anthropic` (the SDK client is not used for the model list). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
```

2. Add next to the other relative imports:

```ts
import {
  fetchAnthropicModels,
  ModelsListAvailableOutputSchema,
  type ModelsListAvailableOutput,
} from './models-available.js';
```

3. In the manifest `registers`, add `'models:list-available:anthropic'` after `'models:list-supported:anthropic'`.

4. In `init`, directly before `if (!credentialResolution) {` add:

```ts
      const fetchImpl = cfg.fetchImpl ?? fetch;
      let keyFor: (ctx: AgentContext) => Promise<string>;
```

5. In the static branch, immediately after the `if (apiKey === undefined || apiKey.length === 0) { throw ... }` block and before `const client = clientFor(apiKey);` add:

```ts
        keyFor = async () => apiKey;
```

6. In the credential-resolution branch, immediately after the comment `// Credential-resolution mode: resolve the key for each call.` and before its `bus.registerService<LlmCallInput, LlmCallOutput>(` add:

```ts
        keyFor = (ctx) => resolveApiKey(bus, ctx, cfg, credentialRef);
```

7. Immediately after the closing `);` of the `models:list-supported:anthropic` registration (the last statement in `init`) add:

```ts
      // Full live list for the admin model picker (@ax/model-policy). Fixed URL,
      // the same key resolution as llm:call, and a structured answer on failure.
      bus.registerService<unknown, ModelsListAvailableOutput>(
        'models:list-available:anthropic',
        PLUGIN_NAME,
        async (ctx) => {
          let apiKey: string;
          try {
            apiKey = await keyFor(ctx);
          } catch (err) {
            if (err instanceof PluginError && err.code === 'no-anthropic-credential') {
              return { status: 'no-key', models: [] };
            }
            return { status: 'error', models: [] };
          }
          return fetchAnthropicModels(fetchImpl, apiKey);
        },
        { returns: ModelsListAvailableOutputSchema, timeoutMs: 60_000 },
      );
```

(`timeoutMs: 60_000` covers up to 5 pages at the 10 s per-page fetch timeout.)

- [x] **Step 5: Update the existing manifest test, run, commit**

In `packages/llm-anthropic/src/__tests__/plugin.test.ts`, add `'models:list-available:anthropic'` to the expected `registers` array in the strict manifest `toEqual` (near lines 51-61), in the same position.

Run: `pnpm --filter @ax/llm-anthropic test && pnpm --filter @ax/llm-anthropic build && npx eslint packages/llm-anthropic/src`
Expected: PASS, exit 0, exit 0.

```bash
git add packages/llm-anthropic
git commit -m "feat(llm-anthropic): models:list-available:anthropic for the admin catalog

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `@ax/agents` — derive the runner from the model

**Files:**
- Modify: `packages/agents/src/store.ts` (import, remove `DEFAULT_RUNNER`, `ValidationContext`, `validateCreateInput`, `validateUpdatePatch`)
- Test: create `packages/agents/src/__tests__/runner-rule.test.ts` (pure, no database)

**Interfaces:**
- Produces (used by Tasks 7–8): `export function runnerForModel(ref: string): RunnerId` (`'claude-sdk'` for provider `anthropic`, else `'aisdk'`); `ValidationContext` gains `currentModel?: string`.
- Behavior change: `validateCreateInput` derives `runner` when omitted and rejects `claude-sdk` + non-Anthropic; `validateUpdatePatch` re-derives `runner` when `model` changes and no `runner` is supplied, and validates a `runner`-only patch against `currentModel`.

- [x] **Step 1: Write the failing tests**

`packages/agents/src/__tests__/runner-rule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runnerForModel, validateCreateInput, validateUpdatePatch } from '../store.js';
import type { AgentInput } from '../types.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const vctx = { allowedModels: [SONNET, KIMI] };

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    displayName: 'Agent',
    allowedTools: [],
    mcpConfigIds: [],
    model: SONNET,
    visibility: 'personal',
    ...overrides,
  };
}

describe('runnerForModel', () => {
  it('runs Anthropic models on claude-sdk and everything else on aisdk', () => {
    expect(runnerForModel(SONNET)).toBe('claude-sdk');
    expect(runnerForModel(KIMI)).toBe('aisdk');
    expect(runnerForModel('openrouter/anthropic/claude-sonnet-4-6')).toBe('aisdk');
  });
});

describe('validateCreateInput — runner', () => {
  it('derives claude-sdk for an Anthropic model and aisdk for an OpenRouter model when runner is omitted', () => {
    expect(validateCreateInput(makeInput(), vctx).runner).toBe('claude-sdk');
    expect(validateCreateInput(makeInput({ model: KIMI }), vctx).runner).toBe('aisdk');
  });

  it('rejects claude-sdk with a non-Anthropic model, in plain words', () => {
    expect(() => validateCreateInput(makeInput({ model: KIMI, runner: 'claude-sdk' }), vctx)).toThrow(
      /claude-sdk.*only run Anthropic models.*aisdk/,
    );
  });

  it('allows aisdk with an Anthropic model', () => {
    expect(validateCreateInput(makeInput({ runner: 'aisdk' }), vctx).runner).toBe('aisdk');
  });

  it('still rejects an unknown runner id', () => {
    expect(() => validateCreateInput(makeInput({ runner: 'nope' as never }), vctx)).toThrow(/not in the allow-list/);
  });
});

describe('validateUpdatePatch — runner', () => {
  it('re-derives the runner when the model changes and no runner is supplied', () => {
    expect(validateUpdatePatch({ model: KIMI }, { ...vctx, currentModel: SONNET })).toMatchObject({
      model: KIMI,
      runner: 'aisdk',
    });
    expect(validateUpdatePatch({ model: SONNET }, { ...vctx, currentModel: KIMI })).toMatchObject({
      model: SONNET,
      runner: 'claude-sdk',
    });
  });

  it('does not touch the runner when neither model nor runner is in the patch', () => {
    expect(validateUpdatePatch({ displayName: 'New' }, { ...vctx, currentModel: KIMI })).toEqual({
      displayName: 'New',
    });
  });

  it('rejects a model+runner patch that cannot work together', () => {
    expect(() => validateUpdatePatch({ model: KIMI, runner: 'claude-sdk' }, vctx)).toThrow(/only run Anthropic models/);
  });

  it('validates a runner-only patch against the current model', () => {
    expect(() => validateUpdatePatch({ runner: 'claude-sdk' }, { ...vctx, currentModel: KIMI })).toThrow(
      /only run Anthropic models/,
    );
    expect(validateUpdatePatch({ runner: 'aisdk' }, { ...vctx, currentModel: SONNET })).toEqual({ runner: 'aisdk' });
  });

  it('accepts a runner-only patch when the current model is unknown (nothing to contradict)', () => {
    expect(validateUpdatePatch({ runner: 'claude-sdk' }, vctx)).toEqual({ runner: 'claude-sdk' });
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/runner-rule.test.ts`
Expected: FAIL — `runnerForModel is not a function` (not exported yet).

- [x] **Step 3: Implement in `store.ts`**

1. Change the import on line 2 to:

```ts
import { isModelRef, parseModelRef, PluginError } from '@ax/core';
```

2. Delete the line `const DEFAULT_RUNNER: RunnerId = 'claude-sdk';` (it becomes unused; nothing else references it).

3. Replace the `ValidationContext` interface:

```ts
interface ValidationContext {
  allowedModels: readonly string[];
}
```

with:

```ts
interface ValidationContext {
  allowedModels: readonly string[];
  /** The agent's stored model, for a runner-only update. Absent on create. */
  currentModel?: string;
}
```

4. Directly after the `validateRunner` function add:

```ts
/**
 * Which runner can run this model. The `claude-sdk` runner only talks to
 * Anthropic (it throws on any other provider), so Anthropic models use it and
 * everything else uses `aisdk`. Callers pass a valid `provider/model-id` ref.
 */
export function runnerForModel(ref: string): RunnerId {
  return parseModelRef(ref).provider === 'anthropic' ? 'claude-sdk' : 'aisdk';
}

function assertRunnerCanRun(runner: RunnerId, model: string): void {
  if (runner === 'claude-sdk' && runnerForModel(model) !== 'claude-sdk') {
    throw invalid(
      `runner 'claude-sdk' can only run Anthropic models; '${model}' needs runner 'aisdk'`,
    );
  }
}
```

5. In `validateCreateInput`, replace the `return { ... }` block with:

```ts
  const model = validateModel(input.model, vctx.allowedModels);
  const runner =
    input.runner === undefined
      ? runnerForModel(model)
      : validateRunner(input.runner, SUPPORTED_RUNNERS);
  assertRunnerCanRun(runner, model);
  return {
    displayName: validateDisplayName(input.displayName),
    allowedTools: validateAllowedTools(input.allowedTools),
    mcpConfigIds: validateMcpConfigIds(input.mcpConfigIds),
    model,
    runner,
    workspaceRef: validateWorkspaceRef(input.workspaceRef ?? null),
    visibility,
    teamId,
  };
```

6. In `validateUpdatePatch`, replace the two blocks `if (patch.model !== undefined) { ... }` and `if (patch.runner !== undefined) { ... }` with:

```ts
  if (patch.model !== undefined) {
    out.model = validateModel(patch.model, vctx.allowedModels);
    // A new model brings its own runner unless the caller named one.
    out.runner =
      patch.runner === undefined
        ? runnerForModel(out.model)
        : validateRunner(patch.runner, SUPPORTED_RUNNERS);
    assertRunnerCanRun(out.runner, out.model);
  } else if (patch.runner !== undefined) {
    out.runner = validateRunner(patch.runner, SUPPORTED_RUNNERS);
    if (vctx.currentModel !== undefined) assertRunnerCanRun(out.runner, vctx.currentModel);
  }
```

- [x] **Step 4: Run, type-check, commit**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/runner-rule.test.ts`
Expected: PASS.

Run: `pnpm --filter @ax/agents build && npx eslint packages/agents/src/store.ts`
Expected: exit 0, exit 0. (The Postgres-backed suites are run in Task 7 after the plugin is updated; `updateAgent` does not yet pass `currentModel`, which is fine because that field is optional.)

Also run the pure validator tests that already exist: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents exec vitest run src/__tests__/store.test.ts`. If an existing assertion expects `runner: 'claude-sdk'` for an **OpenRouter** model created without a runner, that expectation is the old (broken) behaviour: change it to `'aisdk'`. Do not weaken any other assertion.

```bash
git add packages/agents
git commit -m "feat(agents): derive the runner from the model and reject claude-sdk on non-Anthropic models

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `@ax/agents` — take the allowed models from the policy hook

**Files:**
- Create: `packages/agents/src/model-policy.ts`
- Modify: `packages/agents/src/plugin.ts` (imports, `bootPolicy`, manifest `optionalCalls`, create/update handlers, `createAgent`/`updateAgent` signatures, admin-route registration call), `packages/agents/src/admin-routes.ts` (deps type, `listModels`, `registerAdminAgentRoutes`)
- Test: create `packages/agents/src/__tests__/model-policy.test.ts` (pure + fake bus); extend `packages/agents/src/__tests__/plugin.test.ts` and `packages/agents/src/__tests__/admin-routes.test.ts` (Postgres-backed — need `DOCKER_HOST`)

**Interfaces:**
- Produces (used by Tasks 8–9): `ModelPolicy = { allowed: readonly string[]; default: string }`; `builtinPolicy(allowed): ModelPolicy`; `loadPolicy(bus, ctx, boot): Promise<ModelPolicy>` (calls `models:get-policy` when registered, else/or on any failure/invalid answer returns `boot`). `GET /admin/agents/models` now answers `{ models, defaultModel }`.
- Consumes: optional service `models:get-policy` (`{} → { allowed: string[]; default: string; source; version }`).

- [x] **Step 1: Write the failing pure tests**

`packages/agents/src/__tests__/model-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type Logger } from '@ax/core';
import { builtinPolicy, loadPolicy } from '../model-policy.js';

const SONNET = 'anthropic/claude-sonnet-4-6';
const OPUS = 'anthropic/claude-opus-4-7';
const KIMI = 'openrouter/moonshotai/kimi-k3';

function logger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  const l = {
    errors,
    debug() {},
    info() {},
    warn() {},
    error(msg: string) {
      errors.push(msg);
    },
    child() {
      return l;
    },
  } as Logger & { errors: string[] };
  return l;
}

describe('builtinPolicy', () => {
  it('prefers Claude Sonnet as the Default, else the first entry', () => {
    expect(builtinPolicy([OPUS, SONNET])).toEqual({ allowed: [OPUS, SONNET], default: SONNET });
    expect(builtinPolicy([KIMI, OPUS])).toEqual({ allowed: [KIMI, OPUS], default: KIMI });
  });
});

describe('loadPolicy', () => {
  const boot = builtinPolicy([OPUS, SONNET]);

  it('returns the boot policy when models:get-policy is not registered', async () => {
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    expect(await loadPolicy(new HookBus(), ctx, boot)).toBe(boot);
  });

  it("returns the hook's answer when it is registered", async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => ({
      allowed: [KIMI, SONNET],
      default: KIMI,
      source: 'admin',
      version: 3,
    }));
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    expect(await loadPolicy(bus, ctx, boot)).toEqual({ allowed: [KIMI, SONNET], default: KIMI });
  });

  it('falls back to the boot policy and logs when the hook throws', async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => {
      throw new Error('storage down');
    });
    const log = logger();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: log });
    expect(await loadPolicy(bus, ctx, boot)).toBe(boot);
    expect(log.errors).toEqual(['agents_model_policy_unavailable']);
  });

  it('falls back to the boot policy and logs when the answer is unusable', async () => {
    const bus = new HookBus();
    bus.registerService('models:get-policy', 'test', async () => ({
      allowed: [KIMI],
      default: SONNET, // not in allowed
      source: 'admin',
      version: 1,
    }));
    const log = logger();
    const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u', logger: log });
    expect(await loadPolicy(bus, ctx, boot)).toBe(boot);
    expect(log.errors).toEqual(['agents_model_policy_invalid']);
  });
});
```

- [x] **Step 2: Run to verify failure, then implement `model-policy.ts`**

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/model-policy.test.ts`
Expected: FAIL — `Cannot find module '../model-policy.js'`.

`packages/agents/src/model-policy.ts`:

```ts
import type { AgentContext, HookBus } from '@ax/core';

/** Which models may be chosen, and which one is the Default. */
export interface ModelPolicy {
  allowed: readonly string[];
  default: string;
}

const PREFERRED_DEFAULT = 'anthropic/claude-sonnet-4-6';

/** The policy in force before (or without) @ax/model-policy: the boot list, Sonnet as Default when present. */
export function builtinPolicy(allowed: readonly string[]): ModelPolicy {
  return {
    allowed,
    default: allowed.includes(PREFERRED_DEFAULT) ? PREFERRED_DEFAULT : (allowed[0] ?? ''),
  };
}

interface GetPolicyOutput {
  allowed: string[];
  default: string;
}

/**
 * Ask @ax/model-policy for the live policy. Soft dependency: with no plugin, or
 * on any failure or unusable answer, the boot policy applies, so a storage
 * hiccup never blocks chats or agent edits (it is the pre-feature behaviour).
 */
export async function loadPolicy(
  bus: HookBus,
  ctx: AgentContext,
  boot: ModelPolicy,
): Promise<ModelPolicy> {
  if (!bus.hasService('models:get-policy')) return boot;
  try {
    const out = await bus.call<Record<string, never>, GetPolicyOutput>('models:get-policy', ctx, {});
    if (out.allowed.length > 0 && out.allowed.includes(out.default)) {
      return { allowed: out.allowed, default: out.default };
    }
    ctx.logger.error('agents_model_policy_invalid', {});
  } catch (err) {
    ctx.logger.error('agents_model_policy_unavailable', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return boot;
}
```

Run: `pnpm --filter @ax/agents exec vitest run src/__tests__/model-policy.test.ts`
Expected: PASS.

- [x] **Step 3: Write the failing Postgres-backed tests**

Append to `packages/agents/src/__tests__/plugin.test.ts` (inside the file, after the existing `describe` blocks; reuse its `makeHarness`, `makeInput` and type imports):

```ts
describe('model policy (models:get-policy)', () => {
  const SONNET = 'anthropic/claude-sonnet-4-6';
  const OPUS = 'anthropic/claude-opus-4-7';
  const DEEPSEEK = 'openrouter/deepseek/deepseek-v4-pro'; // not in the built-in list

  function policyServices(state: { allowed: string[]; default: string }) {
    return {
      'models:get-policy': async () => ({
        allowed: state.allowed,
        default: state.default,
        source: 'admin',
        version: 1,
      }),
    };
  }
  const actor = { userId: 'u1', isAdmin: false };

  it('create accepts a model only the policy allows, and derives the aisdk runner for it', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
      actor,
      input: makeInput({ model: DEEPSEEK }),
    });
    expect(created.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
  });

  it('create rejects a model the policy removed even though the built-in list has it', async () => {
    const state = { allowed: [SONNET], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    await expect(
      h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
        actor,
        input: makeInput({ model: OPUS }),
      }),
    ).rejects.toThrow(/not in the allow-list/);
  });

  it('update follows the policy live: a model allowed a moment ago is refused once removed', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: SONNET }) });
    state.allowed = [SONNET];
    await expect(
      h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { model: DEEPSEEK },
      }),
    ).rejects.toThrow(/not in the allow-list/);
  });

  it('update re-derives the runner when the model changes', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: SONNET }) });
    const updated = await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
      actor,
      agentId: created.agent.id,
      patch: { model: DEEPSEEK },
    });
    expect(updated.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
  });

  it('update refuses a runner-only change that contradicts the stored model', async () => {
    const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
    const h = await makeHarness({ extraServices: policyServices(state) });
    const ctx = h.ctx({ userId: 'u1' });
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
    await expect(
      h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { runner: 'claude-sdk' },
      }),
    ).rejects.toThrow(/only run Anthropic models/);
  });

  it('keeps today\'s behaviour when @ax/model-policy is not loaded (built-in list)', async () => {
    const h = await makeHarness();
    const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', h.ctx({ userId: 'u1' }), {
      actor,
      input: makeInput({ model: OPUS }),
    });
    expect(created.agent.model).toBe(OPUS);
  });
});
```

Update the manifest test (same file, `manifest matches the documented surface`): add this object as the **last** entry of the expected `optionalCalls` array:

```ts
        {
          hook: 'models:get-policy',
          degradation:
            "the model allow-list, the Default model and the runner rule fall back to the built-in list (today's behaviour)",
        },
```

In `packages/agents/src/__tests__/admin-routes.test.ts`, change the first `GET /admin/agents/models` test (`...NO registrant at all → 200 + the whole allow-list, each label === id`) so its expected body also has the Default — add `defaultModel: 'anthropic/claude-sonnet-4-6',` as a sibling of `models:` in the `toEqual({...})`. Then add after the existing `GET /admin/agents/models ...` tests:

```ts
  it('GET /admin/agents/models follows models:get-policy: its allowed list and its Default', async () => {
    await stack.harness.close({ onError: () => {} });
    stack = await bootStack({
      'models:get-policy': async () => ({
        allowed: ['openrouter/moonshotai/kimi-k3', 'anthropic/claude-sonnet-4-6'],
        default: 'openrouter/moonshotai/kimi-k3',
        source: 'admin',
        version: 2,
      }),
    });
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'GET', '/admin/agents/models', { cookie });
    expect(r.status).toBe(200);
    const body = r.body as { models: Array<{ id: string }>; defaultModel: string };
    expect(body.models.map((m) => m.id)).toEqual(['openrouter/moonshotai/kimi-k3', 'anthropic/claude-sonnet-4-6']);
    expect(body.defaultModel).toBe('openrouter/moonshotai/kimi-k3');
  });
```

- [x] **Step 4: Run to verify failure**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents exec vitest run src/__tests__/plugin.test.ts src/__tests__/admin-routes.test.ts`
Expected: FAIL — the new policy tests fail (the plugin still uses the boot constant), and the manifest and first `/admin/agents/models` tests fail on the new expectations.

- [x] **Step 5: Implement the plugin and route changes**

`packages/agents/src/plugin.ts`:

1. Add the import next to the other relative imports: `import { builtinPolicy, loadPolicy, type ModelPolicy } from './model-policy.js';`
2. Directly after `const allowedModels = resolveAllowedModels(config.allowedModels);` add: `const bootPolicy = builtinPolicy(allowedModels);`
3. Add to the manifest `optionalCalls` array, as its last entry:

```ts
        {
          hook: 'models:get-policy',
          degradation:
            "the model allow-list, the Default model and the runner rule fall back to the built-in list (today's behaviour)",
        },
```

4. Replace the two handler registrations:

```ts
        async (ctx, input) =>
          createAgent(localStore, bus, ctx, input, { allowedModels }),
```
with
```ts
        async (ctx, input) =>
          createAgent(localStore, bus, ctx, input, {
            policy: await loadPolicy(bus, ctx, bootPolicy),
          }),
```
and
```ts
        async (ctx, input) =>
          updateAgent(localStore, bus, ctx, input, { allowedModels }),
```
with
```ts
        async (ctx, input) =>
          updateAgent(localStore, bus, ctx, input, {
            policy: await loadPolicy(bus, ctx, bootPolicy),
          }),
```

5. In `async function createAgent(...)` change `cfg: { allowedModels: readonly string[] },` to `cfg: { policy: ModelPolicy },` and its validation call to:

```ts
  const validated = validateCreateInput(input.input, {
    allowedModels: cfg.policy.allowed,
  });
```

6. In `async function updateAgent(...)` change `cfg: { allowedModels: readonly string[] },` to `cfg: { policy: ModelPolicy },` and its validation call to:

```ts
  const validated = validateUpdatePatch(input.patch, {
    allowedModels: cfg.policy.allowed,
    currentModel: existing.model,
  });
```

7. Change the route registration `await registerAdminAgentRoutes(bus, initCtx, allowedModels)` to `await registerAdminAgentRoutes(bus, initCtx, bootPolicy)`.

`packages/agents/src/admin-routes.ts`:

1. Add `import { loadPolicy, type ModelPolicy } from './model-policy.js';` with the other relative imports.
2. In the handlers' deps interface replace `allowedModels: readonly string[];` with `boot: ModelPolicy;`.
3. In `listModels`, replace the body from `// Providers named by the allow-list` through the final `res.status(200).json({ models });` so every `deps.allowedModels` becomes `policy.allowed`, with `const policy = await loadPolicy(deps.bus, ctx, deps.boot);` as the first line after the `requireUser` check, and the last line becomes:

```ts
      res.status(200).json({ models, defaultModel: policy.default });
```

4. Change the signature and first line of `registerAdminAgentRoutes`:

```ts
export async function registerAdminAgentRoutes(
  bus: HookBus,
  initCtx: AgentContext,
  boot: ModelPolicy,
): Promise<Array<() => void>> {
  const handlers = createAdminAgentRouteHandlers({ bus, boot });
```

5. Find any other caller: run `grep -rn "registerAdminAgentRoutes\|createAdminAgentRouteHandlers" packages --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist` and update each (production code only calls it from `plugin.ts`; fix any test that calls it directly by passing `builtinPolicy([...])` for `boot`).

- [x] **Step 6: Run the suites, type-check, commit**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents test`
Expected: PASS (all files, including the Postgres-backed ones).

Run: `pnpm --filter @ax/agents build && npx eslint packages/agents/src`
Expected: exit 0, exit 0.

```bash
git add packages/agents
git commit -m "feat(agents): validate and pick models from the live policy (models:get-policy)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `@ax/agents` — lazy swap in `agents:resolve`

**Files:**
- Modify: `packages/agents/src/types.ts` (`Agent.requestedModel?`, `AgentSchema`), `packages/agents/src/model-policy.ts` (`applyPolicy`), `packages/agents/src/plugin.ts` (`resolveAgent`), `packages/agents/src/admin-routes.ts` (`serializeAgent`)
- Test: extend `packages/agents/src/__tests__/model-policy.test.ts`, `return-schemas.test.ts`, `plugin.test.ts`, `admin-routes.test.ts`

**Interfaces:**
- Produces: `applyPolicy(agent: Agent, policy: ModelPolicy): Agent`; `Agent.requestedModel?: string` (present only on a swapped record); `agents:resolve` returns the swapped record; `GET /admin/agents/:id` exposes `requestedModel`.
- Consumes: `runnerForModel` (Task 6), `loadPolicy`/`ModelPolicy` (Task 7).
- **Invariant:** nothing here ever writes to the store.

- [x] **Step 1: Write the failing tests**

Append to `packages/agents/src/__tests__/model-policy.test.ts`:

```ts
import { applyPolicy } from '../model-policy.js';
import type { Agent } from '../types.js';

const baseAgent: Agent = {
  id: 'agt_1',
  ownerId: 'u1',
  ownerType: 'user',
  visibility: 'personal',
  displayName: 'A',
  allowedTools: [],
  mcpConfigIds: [],
  model: KIMI,
  runner: 'aisdk',
  workspaceRef: null,
  skillAttachments: [],
  connectorAttachments: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('applyPolicy', () => {
  const policy = { allowed: [SONNET, OPUS], default: SONNET };

  it('swaps a no-longer-allowed model for the Default, re-derives the runner, and records the request', () => {
    const out = applyPolicy(baseAgent, policy);
    expect(out).toMatchObject({ model: SONNET, runner: 'claude-sdk', requestedModel: KIMI });
  });

  it('returns the very same object when the model is allowed and compatible', () => {
    const agent = { ...baseAgent, model: SONNET, runner: 'claude-sdk' as const };
    expect(applyPolicy(agent, policy)).toBe(agent);
  });

  it('keeps an explicit aisdk runner on an allowed Anthropic model', () => {
    const agent = { ...baseAgent, model: SONNET, runner: 'aisdk' as const };
    expect(applyPolicy(agent, policy)).toBe(agent);
  });

  it('heals an allowed non-Anthropic model stuck on claude-sdk (runs on aisdk) without claiming a swap', () => {
    const agent = { ...baseAgent, model: KIMI, runner: 'claude-sdk' as const };
    const out = applyPolicy(agent, { allowed: [KIMI, SONNET], default: SONNET });
    expect(out).toMatchObject({ model: KIMI, runner: 'aisdk' });
    expect(out.requestedModel).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const snapshot = { ...baseAgent };
    applyPolicy(baseAgent, policy);
    expect(baseAgent).toEqual(snapshot);
  });
});
```

Add to `packages/agents/src/__tests__/return-schemas.test.ts`, inside the `describe`:

```ts
  // `requestedModel` marks an agent whose model the admin removed (the lazy swap
  // in agents:resolve). The schema strips undeclared keys, so it must be declared.
  it('keeps requestedModel when present and stays valid without it', () => {
    const parsed = ResolveOutputSchema.parse({
      agent: { ...agent, requestedModel: 'openrouter/moonshotai/kimi-k3' },
    }) as { agent: Agent };
    expect(parsed.agent.requestedModel).toBe('openrouter/moonshotai/kimi-k3');
    expect(ResolveOutputSchema.safeParse({ agent }).success).toBe(true);
    expect(ResolveOutputSchema.safeParse({ agent: { ...agent, requestedModel: 7 } }).success).toBe(false);
  });
```

Append to the `describe('model policy (models:get-policy)', ...)` block in `plugin.test.ts`:

```ts
  describe('lazy swap in agents:resolve', () => {
    it('runs a no-longer-allowed agent on the Default, reports requestedModel, and leaves the stored row alone', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET]; // the admin removes DEEPSEEK

      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: SONNET, runner: 'claude-sdk', requestedModel: DEEPSEEK });

      const listed = await h.bus.call<ListForUserInput, ListForUserOutput>('agents:list-for-user', ctx, { userId: 'u1' });
      expect(listed.agents[0]).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
      expect(listed.agents[0]!.requestedModel).toBeUndefined();
    });

    it('brings the agent back when the model is added again', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      state.allowed = [SONNET, DEEPSEEK];
      const back = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(back.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
      expect(back.agent.requestedModel).toBeUndefined();
    });

    it('an update that does not touch the model never persists the swapped-in Default', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { displayName: 'Renamed' },
      });
      const listed = await h.bus.call<ListForUserInput, ListForUserOutput>('agents:list-for-user', ctx, { userId: 'u1' });
      expect(listed.agents[0]).toMatchObject({ displayName: 'Renamed', model: DEEPSEEK, runner: 'aisdk' });
    });

    it("an explicit model choice on a swapped agent is saved as the owner's choice", async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      state.allowed = [SONNET];
      await h.bus.call<UpdateInput, UpdateOutput>('agents:update', ctx, {
        actor,
        agentId: created.agent.id,
        patch: { model: SONNET },
      });
      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: SONNET, runner: 'claude-sdk' });
      expect(resolved.agent.requestedModel).toBeUndefined();
    });

    it('heals an existing claude-sdk agent on a non-Anthropic model so it runs on aisdk', async () => {
      const state = { allowed: [SONNET, DEEPSEEK], default: SONNET };
      const h = await makeHarness({ extraServices: policyServices(state) });
      const ctx = h.ctx({ userId: 'u1' });
      const created = await h.bus.call<CreateInput, CreateOutput>('agents:create', ctx, { actor, input: makeInput({ model: DEEPSEEK }) });
      // Recreate the broken combination that exists in production today.
      const { sql } = await import('kysely');
      const { db } = await h.bus.call<unknown, { db: import('kysely').Kysely<unknown> }>('database:get-instance', h.ctx(), {});
      await sql`UPDATE agents_v1_agents SET runner = 'claude-sdk' WHERE agent_id = ${created.agent.id}`.execute(db);

      const resolved = await h.bus.call<ResolveInput, ResolveOutput>('agents:resolve', ctx, { agentId: created.agent.id, userId: 'u1' });
      expect(resolved.agent).toMatchObject({ model: DEEPSEEK, runner: 'aisdk' });
    });
  });
```

Add to `packages/agents/src/__tests__/admin-routes.test.ts` (next to the other `GET /admin/agents/:id` tests):

```ts
  it('GET /admin/agents/:id exposes requestedModel once the admin has removed the agent\'s model', async () => {
    const state = { allowed: ['openrouter/deepseek/deepseek-v4-pro', 'anthropic/claude-sonnet-4-6'], default: 'anthropic/claude-sonnet-4-6' };
    await stack.harness.close({ onError: () => {} });
    stack = await bootStack({
      'models:get-policy': async () => ({ allowed: state.allowed, default: state.default, source: 'admin', version: 1 }),
    });
    const cookie = await signIn(stack);
    const made = await http(stack.port, 'POST', '/admin/agents', {
      cookie,
      body: makeBody({ model: 'openrouter/deepseek/deepseek-v4-pro' }),
    });
    expect(made.status).toBe(201);
    const id = (made.body as { agent: { id: string } }).agent.id;

    state.allowed = ['anthropic/claude-sonnet-4-6'];
    const shown = await http(stack.port, 'GET', `/admin/agents/${id}`, { cookie });
    expect(shown.status).toBe(200);
    expect((shown.body as { agent: Record<string, unknown> }).agent).toMatchObject({
      model: 'anthropic/claude-sonnet-4-6',
      runner: 'claude-sdk',
      requestedModel: 'openrouter/deepseek/deepseek-v4-pro',
    });
  });
```

- [x] **Step 2: Run to verify failure**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents test`
Expected: FAIL — `applyPolicy` is not exported; `requestedModel` is stripped / undefined.

- [x] **Step 3: Implement**

`packages/agents/src/types.ts`:

1. In `interface Agent`, add after the `connectorAttachments: string[];` field (before `createdAt`):

```ts
  /**
   * Set only on the record `agents:resolve` returns, when the admin has since
   * removed this agent's stored model: `model` is then the Default and this is
   * what the owner originally chose. Never persisted.
   */
  requestedModel?: string;
```

2. In `AgentSchema`, add after `connectorAttachments: z.array(z.string()),`:

```ts
  // Declared explicitly for the same reason as `runner`: a zod object strips
  // undeclared keys, and this schema is the `returns` contract of agents:resolve.
  requestedModel: z.string().optional(),
```

`packages/agents/src/model-policy.ts`: add the imports and function:

```ts
import { runnerForModel } from './store.js';
import type { Agent } from './types.js';
```

```ts
/**
 * The agent as chats should see it under `policy`. A model the admin has removed
 * is replaced by the Default (the original is kept in `requestedModel`), and the
 * runner follows the model. An allowed model on the wrong runner (`claude-sdk`
 * with a non-Anthropic model, which fails every turn) is corrected in the same
 * way. Pure: returns the same object when nothing needs to change, and never
 * touches storage, so re-adding a model brings agents back on their own.
 */
export function applyPolicy(agent: Agent, policy: ModelPolicy): Agent {
  if (!policy.allowed.includes(agent.model)) {
    return {
      ...agent,
      model: policy.default,
      runner: runnerForModel(policy.default),
      requestedModel: agent.model,
    };
  }
  if (agent.runner === 'claude-sdk' && runnerForModel(agent.model) !== 'claude-sdk') {
    return { ...agent, runner: 'aisdk' };
  }
  return agent;
}
```

`packages/agents/src/plugin.ts`:

1. Extend the import: `import { applyPolicy, builtinPolicy, loadPolicy, type ModelPolicy } from './model-policy.js';`
2. Change the registration `async (ctx, input) => resolveAgent(localStore, bus, ctx, input),` to `async (ctx, input) => resolveAgent(localStore, bus, ctx, input, bootPolicy),`
3. Change `async function resolveAgent(...)`: add the parameter `boot: ModelPolicy,` after `input: ResolveInput,`, and replace the last line `return { agent };` with:

```ts
  // The swap lives only in what chats see. `agent` (the stored row) is never written back.
  const policy = await loadPolicy(bus, ctx, boot);
  return { agent: applyPolicy(agent, policy) };
```

`packages/agents/src/admin-routes.ts`: in `serializeAgent`, after the `runner: a.runner,` line add:

```ts
    ...(a.requestedModel !== undefined ? { requestedModel: a.requestedModel } : {}),
```

- [x] **Step 4: Run, type-check, commit**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents test`
Expected: PASS.

Run: `pnpm --filter @ax/agents build && npx eslint packages/agents/src`
Expected: exit 0, exit 0.

Run the consumers that type against `Agent`/`agents:resolve`: `pnpm --filter @ax/chat-orchestrator build && pnpm --filter @ax/conversations build`
Expected: exit 0 (they declare their own structural copies, so an optional extra field is harmless).

```bash
git add packages/agents
git commit -m "feat(agents): run agents on the Default when their model is removed (lazy, never persisted)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `@ax/agents` — the save-time impact route

**Files:**
- Modify: `packages/agents/src/store.ts` (`AgentStore.countByModel` + implementation), `packages/agents/src/admin-routes.ts` (`impact` handler, route, deps `store`), `packages/agents/src/plugin.ts` (pass `localStore`)
- Test: extend `packages/agents/src/__tests__/store.test.ts` and `admin-routes.test.ts`

**Interfaces:**
- Produces (used by Task 13): `POST /admin/agents/models/impact`, body `{ remove: string[] }` (≤ 1000 strings, each ≤ 200 chars) → `200 { affected: [{ model: string; agentCount: number }] }` listing only models with at least one agent, ordered by model; `401` / `403` (non-admin) / `400 { error }`.
- Produces: `AgentStore.countByModel(models: readonly string[]): Promise<Array<{ model: string; agentCount: number }>>` (cross-owner, counts only).

- [x] **Step 1: Write the failing tests**

Add to `packages/agents/src/__tests__/store.test.ts` (new `describe` at the end; it reuses `makeKysely`, `makeInput`, `createAgentStore`, `validateCreateInput`, `runAgentsMigration` already imported there):

```ts
describe('store.countByModel', () => {
  const KIMI = 'openrouter/moonshotai/kimi-k3';
  const SONNET = 'anthropic/claude-sonnet-4-6';
  const OPUS = 'anthropic/claude-opus-4-7';

  it('counts agents per model across every owner, only for the asked-about models', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    const store = createAgentStore(db);
    const allowed = [KIMI, SONNET, OPUS];
    const mk = (model: string, name: string) =>
      validateCreateInput(makeInput({ model, displayName: name }), { allowedModels: allowed });
    await store.create({ ownerId: 'u1', ownerType: 'user', validated: mk(KIMI, 'A') });
    await store.create({ ownerId: 'u2', ownerType: 'user', validated: mk(KIMI, 'B') });
    await store.create({ ownerId: 'u3', ownerType: 'user', validated: mk(OPUS, 'C') });

    expect(await store.countByModel([KIMI, SONNET])).toEqual([{ model: KIMI, agentCount: 2 }]);
    expect(await store.countByModel([OPUS, KIMI])).toEqual([
      { model: KIMI, agentCount: 2 },
      { model: OPUS, agentCount: 1 },
    ]);
  });

  it('answers [] without touching the database for an empty list', async () => {
    const db = makeKysely();
    await runAgentsMigration(db);
    expect(await createAgentStore(db).countByModel([])).toEqual([]);
  });
});
```

Add to `packages/agents/src/__tests__/admin-routes.test.ts`:

```ts
  // POST /admin/agents/models/impact — the save-time "N agents use this" count
  it('POST /admin/agents/models/impact anonymous → 401', async () => {
    const r = await http(stack.port, 'POST', '/admin/agents/models/impact', { body: { remove: [] } });
    expect(r.status).toBe(401);
  });

  it('POST /admin/agents/models/impact as a non-admin → 403', async () => {
    const { cookie } = await mintSecondUserCookie();
    const r = await http(stack.port, 'POST', '/admin/agents/models/impact', { cookie, body: { remove: [] } });
    expect(r.status).toBe(403);
  });

  it('POST /admin/agents/models/impact counts agents per removed model (counts only)', async () => {
    const cookie = await signIn(stack);
    for (const model of ['anthropic/claude-opus-4-7', 'anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6']) {
      const made = await http(stack.port, 'POST', '/admin/agents', { cookie, body: makeBody({ model }) });
      expect(made.status).toBe(201);
    }
    const r = await http(stack.port, 'POST', '/admin/agents/models/impact', {
      cookie,
      body: { remove: ['anthropic/claude-opus-4-7', 'openrouter/moonshotai/kimi-k3'] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ affected: [{ model: 'anthropic/claude-opus-4-7', agentCount: 2 }] });
  });

  it.each([
    ['a missing remove', {}],
    ['a non-array remove', { remove: 'x' }],
    ['a non-string entry', { remove: [1] }],
    ['an over-long entry', { remove: ['x'.repeat(201)] }],
    ['more than 1000 entries', { remove: Array.from({ length: 1001 }, (_, i) => `a/${i}`) }],
    ['an unknown key', { remove: [], extra: 1 }],
  ])('POST /admin/agents/models/impact 400s on %s', async (_label, body) => {
    const cookie = await signIn(stack);
    const r = await http(stack.port, 'POST', '/admin/agents/models/impact', { cookie, body });
    expect(r.status).toBe(400);
  });
```

- [x] **Step 2: Run to verify failure**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents exec vitest run src/__tests__/store.test.ts src/__tests__/admin-routes.test.ts`
Expected: FAIL — `countByModel is not a function`; the route answers 404.

- [x] **Step 3: Implement**

`packages/agents/src/store.ts`:

1. In the `AgentStore` interface, after `listPersonalAgentOwners(): ...;` add:

```ts
  /**
   * How many agents use each of `models`, across ALL owners (counts only, no
   * identities). Models with no agent are omitted; result is ordered by model.
   * Admin-only caller (the model-policy save confirmation), not ACL-scoped.
   */
  countByModel(models: readonly string[]): Promise<Array<{ model: string; agentCount: number }>>;
```

2. In the object returned by `createAgentStore`, directly after the `listAll()` implementation block, add:

```ts
    async countByModel(models) {
      if (models.length === 0) return [];
      const rows = await db
        .selectFrom('agents_v1_agents')
        .select(['model', sql<string>`count(*)`.as('n')])
        .where('model', 'in', [...models])
        .groupBy('model')
        .orderBy('model')
        .execute();
      return rows.map((r) => ({ model: r.model, agentCount: Number(r.n) }));
    },
```

`packages/agents/src/admin-routes.ts`:

1. Add `import type { AgentStore } from './store.js';` (if `./store.js` is already imported for values, add `type AgentStore` to that import instead).
2. In the handlers' deps interface add `store: AgentStore;`.
3. Near the other zod body schemas add:

```ts
const impactBodySchema = z
  .object({ remove: z.array(z.string().max(200)).max(1000) })
  .strict();
```

4. Add the handler next to `listModels` inside the handlers object:

```ts
    /**
     * POST /admin/agents/models/impact — how many agents use each model an
     * admin is about to remove. Admin-only; counts across all owners, never
     * identities. Used by the Models tab's save confirmation.
     */
    async impact(req: RouteRequest, res: RouteResponse): Promise<void> {
      const actor = await requireUser(deps.bus, ctx, req, res);
      if (actor === null) return;
      if (!actor.isAdmin) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const parsed = parseAndValidate(req.body, impactBodySchema);
      if (!parsed.ok) {
        res.status(parsed.status).json({ error: parsed.message });
        return;
      }
      const remove = (parsed.value as { remove: string[] }).remove;
      res.status(200).json({ affected: await deps.store.countByModel(remove) });
    },
```

5. Change `registerAdminAgentRoutes` to take the store: signature `(bus, initCtx, boot: ModelPolicy, store: AgentStore)`, first line `createAdminAgentRouteHandlers({ bus, boot, store })`, and add to the route list, directly after the `GET /admin/agents/models` entry:

```ts
    { method: 'POST', path: '/admin/agents/models/impact', handler: handlers.impact },
```

`packages/agents/src/plugin.ts`: change the call to `await registerAdminAgentRoutes(bus, initCtx, bootPolicy, localStore)`.

Also fix any other caller found by `grep -rn "registerAdminAgentRoutes\|createAdminAgentRouteHandlers" packages --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist` (pass a store or a stub with `countByModel`).

- [x] **Step 4: Run, type-check, commit**

Run: `DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/agents test`
Expected: PASS.

Run: `pnpm --filter @ax/agents build && npx eslint packages/agents/src`
Expected: exit 0, exit 0. (`local/no-bare-tenant-tables` allows the new query because it is in `store.ts`.)

```bash
git add packages/agents
git commit -m "feat(agents): POST /admin/agents/models/impact counts agents on models about to be removed

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 10: Wire `@ax/model-policy` into the k8s preset (same PR, no half-wired plugin)

**Files:**
- Modify: `presets/k8s/package.json`, `presets/k8s/tsconfig.json`, `presets/k8s/src/index.ts`
- Modify (tests that enumerate plugins): `presets/k8s/src/__tests__/preset.test.ts`, `acceptance.test.ts`, `multi-tenant-acceptance.test.ts`, `usage-limits-acceptance.test.ts`, `disk-quota-acceptance.test.ts`, `prod-bootstrap.test.ts` (and `provider-metering-acceptance.test.ts` if it lists sibling plugins)
- Modify: `docs/plans/2026-05-24-current-architecture.md` (Section 6 "Stable" list)

**Interfaces:**
- Consumes: `createModelPolicyPlugin({ builtinAllowed })` (Task 1) and `resolveAllowedModels(undefined)` from `@ax/agents` (already exported). The preset calls `createAgentsPlugin()` with no config, so both plugins resolve the built-in list the same way (env `AX_AGENT_MODELS_ALLOWED`, else the built-ins).
- Only `presets/k8s` loads `@ax/agents`; `presets/memory` and the CLI do not, so they need no change.

- [x] **Step 1: Find every list to update**

Run: `grep -n "@ax/usage-limits\|@ax/branding" presets/k8s/src/__tests__/*.ts presets/k8s/package.json presets/k8s/tsconfig.json`
Expected: a line per list/dependency. Each file that names `@ax/branding` or `@ax/usage-limits` in a plugin-name list gets `'@ax/model-policy'` too.

- [x] **Step 2: Write the failing wiring test**

In `presets/k8s/src/__tests__/preset.test.ts`, add `'@ax/model-policy'` to the expected sorted plugin-name list (the test "contains the expected production plugin set", ~line 190), at its alphabetical position (after `@ax/memory…`, before `@ax/onboarding`). Do not touch the other lists yet.

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts`
Expected: FAIL — the diff shows `@ax/model-policy` missing from the actual list.

- [x] **Step 3: Implement the wiring**

`presets/k8s/package.json`: add `"@ax/model-policy": "workspace:*",` in `dependencies`, in alphabetical position.

`presets/k8s/tsconfig.json`: add `{ "path": "../../packages/model-policy" }` to `references`, next to the other package references (`scripts/__tests__/tsconfig-references.test.js` fails the PR otherwise).

`presets/k8s/src/index.ts`:

1. Change `import { createAgentsPlugin } from '@ax/agents';` to `import { createAgentsPlugin, resolveAllowedModels } from '@ax/agents';`
2. Add `import { createModelPolicyPlugin } from '@ax/model-policy';` with the other plugin imports.
3. Directly after `plugins.push(createAgentsPlugin());` add:

```ts
  // @ax/model-policy owns the admin-editable list of models people may use in
  // their agents (the Models tab) and the live provider catalog behind it.
  // @ax/agents asks it for the policy through the soft `models:get-policy` hook.
  // The built-in list below is what applies until an admin saves one; it is the
  // SAME resolution `createAgentsPlugin()` does for itself (no config here), so
  // the two plugins can never disagree about the starting list.
  plugins.push(createModelPolicyPlugin({ builtinAllowed: resolveAllowedModels(undefined) }));
```

Run: `pnpm install`
Expected: the lockfile gains the `@ax/model-policy` link under the `presets/k8s` importer only.

- [x] **Step 4: Run the preset tests and update the remaining lists**

Run: `pnpm --filter @ax/preset-k8s exec vitest run src/__tests__/preset.test.ts`
Expected: PASS.

Run the other suites that load the preset. They need Docker:

```bash
DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock pnpm --filter @ax/preset-k8s test
```

For each failure that says the plugin needs a service that the test does not provide, or lists the loaded plugins, add `'@ax/model-policy'` next to `'@ax/branding'` in that file's list: `acceptance.test.ts` (~211), `multi-tenant-acceptance.test.ts` (~161), `usage-limits-acceptance.test.ts` (~102) and `disk-quota-acceptance.test.ts` take it in their `PLUGINS_TO_DROP`; `prod-bootstrap.test.ts` (~227) takes it in its loaded-plugins list. Re-run until green. Do not delete any existing entry.

- [x] **Step 5: Document the hook and commit**

In `docs/plans/2026-05-24-current-architecture.md` Section 6 ("Stable vs. transitional hooks", the **Stable** list), add a bullet in the same style as the `@ax/usage-limits` one:

```markdown
- **`models:get-policy`** (`@ax/model-policy`) — which models may be chosen and which is the Default, `{} → { allowed, default, source: 'admin' | 'builtin', version }`. Soft-consumed by `@ax/agents` (create/update validation, the picker, the lazy swap in `agents:resolve`); absent, agents use their built-in list. **`models:list-available:<provider>`** (`@ax/llm-anthropic`, `@ax/llm-openrouter`) — a provider's full live model list for the admin catalog, `{} → { status: 'live' | 'no-key' | 'error', models: { ref, label }[] }`, called only by `@ax/model-policy`.
```

Run: `pnpm --filter @ax/preset-k8s build && pnpm test:scripts`
Expected: exit 0 and PASS (the tsconfig-references guard is satisfied).

```bash
git add presets docs/plans/2026-05-24-current-architecture.md pnpm-lock.yaml
git commit -m "feat(preset-k8s): load @ax/model-policy next to @ax/agents

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web wire client, copy, and agent types

**Files:**
- Create: `packages/channel-web/src/lib/models-admin.ts`, `packages/channel-web/src/lib/models-copy.ts`
- Modify: `packages/channel-web/src/lib/admin.ts` (`AdminAgent.requestedModel?`, new `listAgentModelOptions`)
- Test: `packages/channel-web/src/lib/__tests__/models-admin.test.ts`

**Interfaces:**
- Produces (used by Tasks 12–15):
  - `fetchCatalog(opts?: { refresh?: boolean }): Promise<CatalogProvider[]>`, `fetchPolicy(): Promise<ModelPolicy>`, `savePolicy(input: { baseVersion: number; allowed: string[]; default: string }): Promise<ModelPolicy>`, `fetchImpact(remove: string[]): Promise<ImpactRow[]>`; class `ModelsHttpError { status: number; serverError?: string }`; types `ProviderStatus`, `CatalogModel`, `CatalogProvider`, `ModelPolicy`, `ImpactRow`.
  - `models-copy.ts`: plain-language strings and helpers (listed in Step 3).
  - `lib/admin.ts`: `AdminAgent.requestedModel?: string`; `listAgentModelOptions(): Promise<{ models: AgentModelOption[]; defaultModel: string | null }>`; `listAgentModels()` keeps working (returns `.models`).
- Consumes: `HTTP_SESSION_ENDED`, `HTTP_NO_ACCESS` from `lib/http.ts`.

- [x] **Step 1: Write the failing wire-client tests**

`packages/channel-web/src/lib/__tests__/models-admin.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCatalog, fetchImpact, fetchPolicy, ModelsHttpError, savePolicy } from '../models-admin';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let respond: (c: Call) => Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  respond = () => json(200, {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        path: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(c);
      return respond(c);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const POLICY = { source: 'admin', version: 2, allowed: ['a/b'], default: 'a/b', updatedAt: 'T', updatedBy: 'u' };

describe('fetchPolicy', () => {
  it('GETs the policy with the session cookie', async () => {
    respond = () => json(200, POLICY);
    expect(await fetchPolicy()).toEqual(POLICY);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/admin/models/policy' });
  });
  it('keeps the unreadable-policy warning', async () => {
    respond = () => json(200, { ...POLICY, source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    expect((await fetchPolicy()).warning).toBe('saved-policy-unreadable');
  });
  it('rejects a 200 that is not a policy', async () => {
    respond = () => json(200, { providers: [] });
    await expect(fetchPolicy()).rejects.toMatchObject({ name: 'ModelsHttpError', serverError: 'unexpected-response' });
  });
  it('carries the status and server error code on a failure', async () => {
    respond = () => json(403, { error: 'forbidden' });
    await expect(fetchPolicy()).rejects.toMatchObject({ status: 403, serverError: 'forbidden' });
  });
});

describe('fetchCatalog', () => {
  const provider = { id: 'openrouter', name: 'OpenRouter', status: 'live', fetchedAt: 'T', models: [{ ref: 'openrouter/a/b', label: 'B' }] };
  it('GETs the catalog, asking for a refresh only when told to', async () => {
    respond = () => json(200, { providers: [provider] });
    expect(await fetchCatalog()).toEqual([provider]);
    await fetchCatalog({ refresh: true });
    expect(calls.map((c) => c.path)).toEqual(['/admin/models/catalog', '/admin/models/catalog?refresh=1']);
  });
  it.each([
    ['no providers array', {}],
    ['an unknown status', { providers: [{ ...provider, status: 'weird' }] }],
    ['a model without a ref', { providers: [{ ...provider, models: [{ label: 'x' }] }] }],
  ])('rejects %s', async (_l, body) => {
    respond = () => json(200, body);
    await expect(fetchCatalog()).rejects.toBeInstanceOf(ModelsHttpError);
  });
});

describe('savePolicy', () => {
  it('PUTs the draft with the admin CSRF header and returns the saved policy', async () => {
    respond = () => json(200, POLICY);
    const saved = await savePolicy({ baseVersion: 1, allowed: ['a/b'], default: 'a/b' });
    expect(saved).toEqual(POLICY);
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      path: '/admin/models/policy',
      body: { baseVersion: 1, allowed: ['a/b'], default: 'a/b' },
    });
    expect(calls[0]!.headers['x-requested-with']).toBe('ax-admin');
  });
  it('surfaces a stale-version conflict', async () => {
    respond = () => json(409, { error: 'stale-version' });
    await expect(savePolicy({ baseVersion: 0, allowed: ['a/b'], default: 'a/b' })).rejects.toMatchObject({
      status: 409,
      serverError: 'stale-version',
    });
  });
});

describe('fetchImpact', () => {
  it('POSTs the models to be removed and returns the per-model counts', async () => {
    respond = () => json(200, { affected: [{ model: 'a/b', agentCount: 3 }] });
    expect(await fetchImpact(['a/b'])).toEqual([{ model: 'a/b', agentCount: 3 }]);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/admin/agents/models/impact', body: { remove: ['a/b'] } });
    expect(calls[0]!.headers['x-requested-with']).toBe('ax-admin');
  });
  it('rejects a malformed answer', async () => {
    respond = () => json(200, { affected: [{ model: 'a/b' }] });
    await expect(fetchImpact(['a/b'])).rejects.toBeInstanceOf(ModelsHttpError);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/models-admin.test.ts`
Expected: FAIL — `Failed to resolve import '../models-admin'`.

- [x] **Step 3: Implement the client and the copy**

`packages/channel-web/src/lib/models-admin.ts`:

```ts
/**
 * Models wire client — the wire and nothing else; sentences live in models-copy.ts.
 * Every endpoint is admin-gated server-side; hiding the tab is convenience only.
 */

const writeHeaders = { 'content-type': 'application/json', 'x-requested-with': 'ax-admin' } as const;

export type ProviderStatus = 'live' | 'cached' | 'fallback' | 'no-key' | 'error';
const STATUSES: ReadonlySet<string> = new Set(['live', 'cached', 'fallback', 'no-key', 'error']);

export interface CatalogModel {
  ref: string;
  label: string;
}
export interface CatalogProvider {
  id: string;
  name: string;
  status: ProviderStatus;
  fetchedAt?: string;
  models: CatalogModel[];
}
export interface ModelPolicy {
  source: 'admin' | 'builtin';
  version: number;
  allowed: string[];
  default: string;
  updatedAt?: string;
  updatedBy?: string;
  warning?: 'saved-policy-unreadable';
}
export interface ImpactRow {
  model: string;
  agentCount: number;
}

export class ModelsHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverError?: string,
  ) {
    super(serverError !== undefined && serverError.length > 0 ? serverError : `models request failed: ${status}`);
    this.name = 'ModelsHttpError';
  }
}

async function failure(res: Response): Promise<ModelsHttpError> {
  let serverError: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') serverError = body.error;
  } catch {
    /* non-JSON body */
  }
  return new ModelsHttpError(res.status, serverError);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const bad = (status: number): ModelsHttpError => new ModelsHttpError(status, 'unexpected-response');

function asProvider(v: unknown): CatalogProvider | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  if (typeof v.status !== 'string' || !STATUSES.has(v.status) || !Array.isArray(v.models)) return null;
  const models: CatalogModel[] = [];
  for (const m of v.models) {
    if (!isObj(m) || typeof m.ref !== 'string' || typeof m.label !== 'string') return null;
    models.push({ ref: m.ref, label: m.label });
  }
  return {
    id: v.id,
    name: v.name,
    status: v.status as ProviderStatus,
    ...(typeof v.fetchedAt === 'string' ? { fetchedAt: v.fetchedAt } : {}),
    models,
  };
}

function asPolicy(v: unknown): ModelPolicy | null {
  if (!isObj(v) || (v.source !== 'admin' && v.source !== 'builtin')) return null;
  if (typeof v.version !== 'number' || !isStrings(v.allowed) || typeof v.default !== 'string') return null;
  return {
    source: v.source,
    version: v.version,
    allowed: v.allowed,
    default: v.default,
    ...(typeof v.updatedAt === 'string' ? { updatedAt: v.updatedAt } : {}),
    ...(typeof v.updatedBy === 'string' ? { updatedBy: v.updatedBy } : {}),
    ...(v.warning === 'saved-policy-unreadable' ? { warning: 'saved-policy-unreadable' as const } : {}),
  };
}

export async function fetchCatalog(opts: { refresh?: boolean } = {}): Promise<CatalogProvider[]> {
  const res = await fetch(`/admin/models/catalog${opts.refresh === true ? '?refresh=1' : ''}`, {
    credentials: 'include',
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isObj(body) || !Array.isArray(body.providers)) throw bad(res.status);
  const providers: CatalogProvider[] = [];
  for (const p of body.providers) {
    const parsed = asProvider(p);
    if (parsed === null) throw bad(res.status);
    providers.push(parsed);
  }
  return providers;
}

export async function fetchPolicy(): Promise<ModelPolicy> {
  const res = await fetch('/admin/models/policy', { credentials: 'include' });
  if (!res.ok) throw await failure(res);
  const policy = asPolicy(await res.json());
  if (policy === null) throw bad(res.status);
  return policy;
}

export async function savePolicy(input: {
  baseVersion: number;
  allowed: string[];
  default: string;
}): Promise<ModelPolicy> {
  const res = await fetch('/admin/models/policy', {
    method: 'PUT',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await failure(res);
  const policy = asPolicy(await res.json());
  if (policy === null) throw bad(res.status);
  return policy;
}

/** How many agents use each model an admin is about to remove (counts only). */
export async function fetchImpact(remove: string[]): Promise<ImpactRow[]> {
  const res = await fetch('/admin/agents/models/impact', {
    method: 'POST',
    headers: writeHeaders,
    credentials: 'include',
    body: JSON.stringify({ remove }),
  });
  if (!res.ok) throw await failure(res);
  const body: unknown = await res.json();
  if (!isObj(body) || !Array.isArray(body.affected)) throw bad(res.status);
  const rows: ImpactRow[] = [];
  for (const r of body.affected) {
    if (!isObj(r) || typeof r.model !== 'string' || typeof r.agentCount !== 'number') throw bad(res.status);
    rows.push({ model: r.model, agentCount: r.agentCount });
  }
  return rows;
}
```

`packages/channel-web/src/lib/models-copy.ts`:

```ts
/**
 * Every sentence the Models tab and the agent editor's moved-model notice say.
 * Project voice: plain words, short sentences, "we", no blame.
 */
import { HTTP_NO_ACCESS, HTTP_SESSION_ENDED } from './http';
import { ModelsHttpError } from './models-admin';

export const TAB_INTRO = 'Choose which models people can use when they create or edit an agent.';
export const BUILTIN_NOTICE = "You're using the built-in list. Nothing changes until you save.";
export const UNREADABLE_NOTICE =
  "We couldn't read the saved list, so we're using the built-in one for now. Saving will replace the saved list.";
export const POLICY_LOAD_FAILED = "We couldn't load the saved list of models.";
export const CATALOG_LOAD_FAILED = "We couldn't load the model list. Your current selection is safe.";
export const DEFAULT_HELP =
  'The Default is what new agents start with, and where an agent moves if its model is removed.';
export const NONE_SELECTED_TITLE = 'No models yet';
export const NONE_SELECTED_BODY = 'Pick at least one on the left so people can create agents.';
export const NO_LONGER_LISTED = 'No longer listed';
export const NEEDS_KEY = 'Needs an API key';
export const SAVED_TITLE = 'Models saved';
export const SAVED_DETAIL = 'People can now use the models you selected.';

export function providerProblem(name: string): string {
  return `We couldn't reach ${name} just now, so we're showing a shorter list.`;
}
export function providerNoKey(name: string): string {
  return `Add an API key to see ${name}'s models.`;
}
export function timeAgo(iso: string | undefined, nowMs: number): string {
  if (iso === undefined) return 'earlier';
  const mins = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!(mins >= 1)) return 'a moment ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
}
export function cachedNote(iso: string | undefined, nowMs: number): string {
  return `Showing models from ${timeAgo(iso, nowMs)}.`;
}
export function countLine(shown: number, total: number, filtering: boolean): string {
  if (!filtering) return `${total} model${total === 1 ? '' : 's'}`;
  return `${shown} of ${total} models`;
}

export function impactTitle(totalAgents: number | null, defaultLabel: string): string {
  if (totalAgents === null) return `Some agents may move to ${defaultLabel}`;
  return `Move ${totalAgents} agent${totalAgents === 1 ? '' : 's'} to ${defaultLabel}?`;
}
export function impactLine(label: string, agentCount: number): string {
  return `${label}: ${agentCount} agent${agentCount === 1 ? '' : 's'}`;
}
export function impactExplain(defaultLabel: string, known: boolean): string {
  if (!known) {
    return `We couldn't check which agents use the models you removed. Any agent on a removed model will use ${defaultLabel} from its next chat.`;
  }
  return `From their next chat they'll use ${defaultLabel} instead. If you add a model back, the agents that use it switch back on their own.`;
}

export function movedNotice(defaultLabel: string): string {
  return `Your admin changed the available models, so this agent is using ${defaultLabel} now. Pick a different model to change it.`;
}

const CODE_COPY: Record<string, string> = {
  'pick-at-least-one-model': 'Pick at least one model so people can still create agents.',
  'default-not-selected': 'Choose a Default from the selected models.',
  'too-many-models': "That's more models than we can save at once. Try a smaller selection.",
  'invalid-model-ref': "One of the selected models isn't valid. Remove it and try again.",
  'duplicate-model': 'A model is selected twice. Reload and try again.',
};

/** What to tell the admin when a save fails. `stale` means "someone else saved first". */
export function saveFailure(err: unknown): { message: string; stale: boolean } {
  if (err instanceof ModelsHttpError) {
    if (err.status === 409) {
      return { message: 'Someone else just changed this list. Reload to see their version.', stale: true };
    }
    if (err.status === 401) return { message: HTTP_SESSION_ENDED, stale: false };
    if (err.status === 403) return { message: HTTP_NO_ACCESS, stale: false };
    const specific = err.serverError !== undefined ? CODE_COPY[err.serverError] : undefined;
    if (specific !== undefined) return { message: specific, stale: false };
  }
  return { message: "We couldn't save that. Nothing changed. Try again in a moment.", stale: false };
}
```

- [x] **Step 4: Extend `lib/admin.ts`**

In `packages/channel-web/src/lib/admin.ts`:

1. In `interface AdminAgent` add (after `model: string;`): `requestedModel?: string;`
2. Replace the existing `listAgentModels` function (the `GET /admin/agents/models` wrapper) with these two, keeping the existing `AgentModelOption` interface as it is:

```ts
export interface AgentModelList {
  models: AgentModelOption[];
  /** The Default the admin chose; `null` when the server did not say (older host). */
  defaultModel: string | null;
}

export async function listAgentModelOptions(): Promise<AgentModelList> {
  const res = await fetch('/admin/agents/models', { credentials: 'include' });
  if (!res.ok) throw new Error(`list models: ${res.status}`);
  const body = (await res.json()) as { models?: AgentModelOption[]; defaultModel?: unknown };
  return {
    models: body.models ?? [],
    defaultModel: typeof body.defaultModel === 'string' ? body.defaultModel : null,
  };
}

export async function listAgentModels(): Promise<AgentModelOption[]> {
  return (await listAgentModelOptions()).models;
}
```

(Keep whatever error handling the existing function had if it differs from the `throw` above — match its current style.)

- [x] **Step 5: Run and commit**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/models-admin.test.ts src/__tests__/vocabulary.test.ts`
Expected: PASS (the vocabulary scan sees no retired words in the new copy).

Run: `pnpm --filter @ax/channel-web exec tsc --noEmit -p . && npx eslint packages/channel-web/src/lib`
Expected: exit 0, exit 0 (`channel-web`'s `tsc` covers test files and is strict).

```bash
git add packages/channel-web
git commit -m "feat(channel-web): models wire client, copy, and listAgentModelOptions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The picker's pure logic and the two panes

**Files:**
- Create: `packages/channel-web/src/lib/models-picker.ts`, `packages/channel-web/src/components/admin/ModelCatalogPane.tsx`, `packages/channel-web/src/components/admin/SelectedModelsPane.tsx`
- Test: `packages/channel-web/src/lib/__tests__/models-picker.test.ts`, `packages/channel-web/src/components/admin/__tests__/ModelPanes.test.tsx`

**Interfaces:**
- Produces (used by Task 13):
  - `models-picker.ts`: `type Draft = { allowed: string[]; default: string }`; `filterProviders(providers, query)`, `countModels(providers)`, `toggleModel(draft, ref)`, `removeModel(draft, ref)`, `addModels(draft, refs)`, `setDefault(draft, ref)`, `isDirty(saved, draft)`, `removedModels(saved, draft)`, `labelFor(ref, providers)`, `selectedInfo(ref, providers)`.
  - `<ModelCatalogPane providers shown selected query onQueryChange onToggle onSelectAllShown onRetry retrying onOpenKeys? nowMs />`
  - `<SelectedModelsPane draft providers onSetDefault onRemove />`
- Consumes: `CatalogProvider`/`CatalogModel` (Task 11), copy helpers (Task 11).

- [x] **Step 1: Write the failing logic tests**

`packages/channel-web/src/lib/__tests__/models-picker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CatalogProvider } from '../models-admin';
import {
  addModels,
  countModels,
  filterProviders,
  isDirty,
  labelFor,
  removeModel,
  removedModels,
  selectedInfo,
  setDefault,
  toggleModel,
} from '../models-picker';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

const providers: CatalogProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    status: 'live',
    models: [
      { ref: OPUS, label: 'Claude Opus 4.7' },
      { ref: SONNET, label: 'Claude Sonnet 4.6' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    status: 'live',
    models: [
      { ref: KIMI, label: 'Kimi K3' },
      { ref: GROK, label: 'xAI: Grok 4.6' },
    ],
  },
];

describe('filterProviders', () => {
  it('returns every provider untouched for an empty or blank query', () => {
    expect(filterProviders(providers, '')).toEqual(providers);
    expect(filterProviders(providers, '   ')).toEqual(providers);
  });
  it('matches label, ref and provider name, case-insensitively', () => {
    expect(filterProviders(providers, 'OPUS').flatMap((p) => p.models.map((m) => m.ref))).toEqual([OPUS]);
    expect(filterProviders(providers, 'moonshotai').flatMap((p) => p.models.map((m) => m.ref))).toEqual([KIMI]);
    expect(filterProviders(providers, 'openrouter').flatMap((p) => p.models.map((m) => m.ref))).toEqual([KIMI, GROK]);
  });
  it('requires every word to match, in any order', () => {
    expect(filterProviders(providers, 'sonnet claude').flatMap((p) => p.models.map((m) => m.ref))).toEqual([SONNET]);
    expect(filterProviders(providers, 'claude grok')).toEqual([]);
  });
  it('drops providers with no match while searching', () => {
    expect(filterProviders(providers, 'kimi').map((p) => p.id)).toEqual(['openrouter']);
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify(providers);
    filterProviders(providers, 'kimi');
    expect(JSON.stringify(providers)).toBe(before);
  });
});

describe('countModels', () => {
  it('sums across providers', () => expect(countModels(providers)).toBe(4));
});

describe('draft edits', () => {
  const draft = { allowed: [SONNET, KIMI], default: SONNET };

  it('toggling a new model appends it and keeps the Default', () => {
    expect(toggleModel(draft, OPUS)).toEqual({ allowed: [SONNET, KIMI, OPUS], default: SONNET });
  });
  it('toggling a selected model removes it', () => {
    expect(toggleModel(draft, KIMI)).toEqual({ allowed: [SONNET], default: SONNET });
  });
  it('the first model added to an empty draft becomes the Default', () => {
    expect(toggleModel({ allowed: [], default: '' }, KIMI)).toEqual({ allowed: [KIMI], default: KIMI });
  });
  it('removing the Default makes the first remaining model the Default', () => {
    expect(removeModel(draft, SONNET)).toEqual({ allowed: [KIMI], default: KIMI });
  });
  it('removing the last model leaves an empty draft with no Default', () => {
    expect(removeModel({ allowed: [KIMI], default: KIMI }, KIMI)).toEqual({ allowed: [], default: '' });
  });
  it('removing an unselected model is a no-op', () => {
    expect(removeModel(draft, OPUS)).toEqual(draft);
  });
  it('addModels appends only the missing ones, in order, and never changes the Default', () => {
    expect(addModels(draft, [KIMI, OPUS, GROK])).toEqual({ allowed: [SONNET, KIMI, OPUS, GROK], default: SONNET });
  });
  it('addModels on an empty draft picks the first as the Default', () => {
    expect(addModels({ allowed: [], default: '' }, [OPUS, KIMI])).toEqual({ allowed: [OPUS, KIMI], default: OPUS });
  });
  it('setDefault only accepts a selected model', () => {
    expect(setDefault(draft, KIMI).default).toBe(KIMI);
    expect(setDefault(draft, OPUS)).toEqual(draft);
  });
});

describe('isDirty / removedModels', () => {
  const saved = { allowed: [SONNET, KIMI], default: SONNET };
  it('is clean for the same selection, in any order', () => {
    expect(isDirty(saved, { allowed: [KIMI, SONNET], default: SONNET })).toBe(false);
  });
  it('is dirty when the selection or the Default changes', () => {
    expect(isDirty(saved, { allowed: [SONNET], default: SONNET })).toBe(true);
    expect(isDirty(saved, { allowed: [SONNET, KIMI], default: KIMI })).toBe(true);
  });
  it('lists what was removed, and only that', () => {
    expect(removedModels(saved, { allowed: [SONNET, OPUS], default: SONNET })).toEqual([KIMI]);
    expect(removedModels(saved, { allowed: [SONNET, KIMI, OPUS], default: SONNET })).toEqual([]);
  });
});

describe('labels and badges', () => {
  it('uses the catalog label, else the ref', () => {
    expect(labelFor(KIMI, providers)).toBe('Kimi K3');
    expect(labelFor('openrouter/gone/model', providers)).toBe('openrouter/gone/model');
  });
  it('reports the provider name and no badges for a listed model', () => {
    expect(selectedInfo(KIMI, providers)).toEqual({
      label: 'Kimi K3',
      providerName: 'OpenRouter',
      noLongerListed: false,
      needsKey: false,
    });
  });
  it('flags "no longer listed" only when the provider list is authoritative', () => {
    expect(selectedInfo('openrouter/gone/model', providers).noLongerListed).toBe(true);
    const shaky = providers.map((p) => (p.id === 'openrouter' ? { ...p, status: 'fallback' as const } : p));
    expect(selectedInfo('openrouter/gone/model', shaky).noLongerListed).toBe(false);
  });
  it('flags a model whose provider has no key', () => {
    const noKey = providers.map((p) => (p.id === 'openrouter' ? { ...p, status: 'no-key' as const, models: [] } : p));
    expect(selectedInfo(KIMI, noKey)).toMatchObject({ needsKey: true, noLongerListed: false });
  });
  it('names an unknown provider by its id', () => {
    expect(selectedInfo('mystery/model-1', providers).providerName).toBe('mystery');
  });
});
```

- [x] **Step 2: Run to verify failure, then implement the logic**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/models-picker.test.ts`
Expected: FAIL — `Failed to resolve import '../models-picker'`.

`packages/channel-web/src/lib/models-picker.ts`:

```ts
/**
 * Pure logic behind the Models tab: search, selection, the Default, and what
 * changed. No React, no fetch, so every rule is unit-tested on its own.
 */
import type { CatalogProvider } from './models-admin';

export interface Draft {
  allowed: string[];
  default: string;
}

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Every word must appear in the label, the ref, or the provider name. Empty query keeps everything. */
export function filterProviders(providers: readonly CatalogProvider[], query: string): CatalogProvider[] {
  const words = terms(query);
  if (words.length === 0) return providers.map((p) => p);
  const out: CatalogProvider[] = [];
  for (const p of providers) {
    const models = p.models.filter((m) => {
      const hay = `${m.label} ${m.ref} ${p.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (models.length > 0) out.push({ ...p, models });
  }
  return out;
}

export function countModels(providers: readonly CatalogProvider[]): number {
  return providers.reduce((n, p) => n + p.models.length, 0);
}

export function toggleModel(draft: Draft, ref: string): Draft {
  return draft.allowed.includes(ref) ? removeModel(draft, ref) : addModels(draft, [ref]);
}

export function removeModel(draft: Draft, ref: string): Draft {
  if (!draft.allowed.includes(ref)) return draft;
  const allowed = draft.allowed.filter((r) => r !== ref);
  const def = draft.default === ref ? (allowed[0] ?? '') : draft.default;
  return { allowed, default: def };
}

export function addModels(draft: Draft, refs: readonly string[]): Draft {
  const allowed = [...draft.allowed];
  for (const ref of refs) if (!allowed.includes(ref)) allowed.push(ref);
  if (allowed.length === draft.allowed.length) return draft;
  return { allowed, default: draft.default !== '' && draft.allowed.includes(draft.default) ? draft.default : (allowed[0] ?? '') };
}

export function setDefault(draft: Draft, ref: string): Draft {
  return draft.allowed.includes(ref) ? { allowed: draft.allowed, default: ref } : draft;
}

export function isDirty(saved: Draft, draft: Draft): boolean {
  if (saved.default !== draft.default) return true;
  if (saved.allowed.length !== draft.allowed.length) return true;
  const have = new Set(saved.allowed);
  return draft.allowed.some((r) => !have.has(r));
}

/** Models in the saved list that the draft no longer has. */
export function removedModels(saved: Draft, draft: Draft): string[] {
  const keep = new Set(draft.allowed);
  return saved.allowed.filter((r) => !keep.has(r));
}

function find(ref: string, providers: readonly CatalogProvider[]) {
  for (const p of providers) {
    const m = p.models.find((x) => x.ref === ref);
    if (m !== undefined) return { provider: p, model: m };
  }
  return null;
}

export function labelFor(ref: string, providers: readonly CatalogProvider[]): string {
  return find(ref, providers)?.model.label ?? ref;
}

export interface SelectedInfo {
  label: string;
  providerName: string;
  noLongerListed: boolean;
  needsKey: boolean;
}

export function selectedInfo(ref: string, providers: readonly CatalogProvider[]): SelectedInfo {
  const hit = find(ref, providers);
  if (hit !== null) {
    return { label: hit.model.label, providerName: hit.provider.name, noLongerListed: false, needsKey: hit.provider.status === 'no-key' };
  }
  const providerId = ref.split('/')[0] ?? ref;
  const provider = providers.find((p) => p.id === providerId);
  return {
    label: ref,
    providerName: provider?.name ?? providerId,
    // Only claim "no longer listed" when the provider's list is the real one
    // (live or recently cached); a fallback or failed list proves nothing.
    noLongerListed: provider !== undefined && (provider.status === 'live' || provider.status === 'cached'),
    needsKey: provider?.status === 'no-key',
  };
}
```

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/models-picker.test.ts`
Expected: PASS.

- [x] **Step 3: Write the failing pane tests**

`packages/channel-web/src/components/admin/__tests__/ModelPanes.test.tsx`:

```tsx
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { CatalogProvider } from '@/lib/models-admin';
import { filterProviders, removeModel, setDefault, toggleModel, addModels, type Draft } from '@/lib/models-picker';
import { ModelCatalogPane } from '../ModelCatalogPane';
import { SelectedModelsPane } from '../SelectedModelsPane';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

const PROVIDERS: CatalogProvider[] = [
  { id: 'anthropic', name: 'Anthropic', status: 'live', models: [{ ref: OPUS, label: 'Claude Opus 4.7' }, { ref: SONNET, label: 'Claude Sonnet 4.6' }] },
  { id: 'openrouter', name: 'OpenRouter', status: 'live', models: [{ ref: KIMI, label: 'Kimi K3' }, { ref: GROK, label: 'xAI: Grok 4.6' }] },
];

/** A tiny host so the panes behave as they do inside ModelsTab. */
function Harness(props: { providers?: CatalogProvider[]; initial?: Draft; onOpenKeys?: () => void; onRetry?: () => void }) {
  const providers = props.providers ?? PROVIDERS;
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(props.initial ?? { allowed: [SONNET], default: SONNET });
  const shown = filterProviders(providers, query);
  return (
    <>
      <ModelCatalogPane
        providers={providers}
        shown={shown}
        selected={new Set(draft.allowed)}
        query={query}
        onQueryChange={setQuery}
        onToggle={(ref) => setDraft((d) => toggleModel(d, ref))}
        onSelectAllShown={(refs) => setDraft((d) => addModels(d, refs))}
        onRetry={props.onRetry ?? (() => {})}
        retrying={false}
        {...(props.onOpenKeys !== undefined ? { onOpenKeys: props.onOpenKeys } : {})}
        nowMs={Date.parse('2026-09-30T12:10:00Z')}
      />
      <SelectedModelsPane
        draft={draft}
        providers={providers}
        onSetDefault={(ref) => setDraft((d) => setDefault(d, ref))}
        onRemove={(ref) => setDraft((d) => removeModel(d, ref))}
      />
    </>
  );
}

describe('ModelCatalogPane', () => {
  it('lists every model grouped by provider, with a live count', () => {
    render(<Harness />);
    expect(screen.getByText('4 models')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument();
  });

  it('filters on every keystroke (no waiting), narrows as words are typed, and widens when they are deleted', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox', { name: 'Search models' });
    // One keystroke is enough to filter: "k" appears in Kimi K3 and Grok only.
    fireEvent.change(box, { target: { value: 'k' } });
    expect(screen.getByText('2 of 4 models')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Claude/ })).toBeNull();
    fireEvent.change(box, { target: { value: 'claude' } });
    expect(screen.getByText('2 of 4 models')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'claude opus' } });
    expect(screen.getByText('1 of 4 models')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Sonnet/ })).toBeNull();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText('4 models')).toBeInTheDocument();
  });

  it('says so plainly when nothing matches', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'zzz' } });
    expect(screen.getByText('0 of 4 models')).toBeInTheDocument();
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it('ticking a model selects it and the right pane shows it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Kimi K3/ }));
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' })).toBeInTheDocument();
  });

  it('offers "Select all N shown" only while searching, and it selects every match', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all 2 shown' }));
    expect(screen.getByRole('heading', { name: 'Available to users (3)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make xAI: Grok 4.6 the Default' })).toBeInTheDocument();
  });

  it('opens a matching provider group while searching even if the admin collapsed it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/ })); // collapse
    expect(screen.queryByRole('checkbox', { name: /Kimi K3/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'kimi' } });
    expect(screen.getByRole('checkbox', { name: /Kimi K3/ })).toBeInTheDocument();
  });

  it('a provider we could not reach shows a plain message and a working Try again', () => {
    const onRetry = vi.fn();
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'fallback' as const } : p));
    render(<Harness providers={providers} onRetry={onRetry} />);
    expect(screen.getByText("We couldn't reach OpenRouter just now, so we're showing a shorter list.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('a cached list says how old it is', () => {
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'cached' as const, fetchedAt: '2026-09-30T12:00:00Z' } : p));
    render(<Harness providers={providers} />);
    expect(screen.getByText('Showing models from 10 minutes ago.')).toBeInTheDocument();
  });

  it('a provider with no key says what to do, and the link opens the keys tab', () => {
    const onOpenKeys = vi.fn();
    const providers = PROVIDERS.map((p) => (p.id === 'openrouter' ? { ...p, status: 'no-key' as const, models: [] } : p));
    render(<Harness providers={providers} onOpenKeys={onOpenKeys} />);
    expect(screen.getByText(/Add an API key to see OpenRouter's models\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open AI model keys' }));
    expect(onOpenKeys).toHaveBeenCalledOnce();
  });
});

describe('SelectedModelsPane', () => {
  it('explains the Default and shows the empty state when nothing is selected', () => {
    render(<Harness initial={{ allowed: [], default: '' }} />);
    expect(screen.getByRole('heading', { name: 'Available to users (0)' })).toBeInTheDocument();
    expect(screen.getByText('No models yet')).toBeInTheDocument();
    expect(screen.getByText('Pick at least one on the left so people can create agents.')).toBeInTheDocument();
  });

  it('marks the Default and lets the admin move it', () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    expect(screen.getByRole('radio', { name: 'Make Claude Sonnet 4.6 the Default' })).toBeChecked();
    expect(screen.getByText('Default')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' }));
    expect(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' })).toBeChecked();
  });

  it('removing the Default promotes the first remaining model, visibly', () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Sonnet 4.6' }));
    expect(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' })).toBeChecked();
  });

  it('badges a model the provider no longer lists and one whose provider has no key', () => {
    const providers = PROVIDERS.map((p) => (p.id === 'anthropic' ? { ...p, status: 'no-key' as const, models: [] } : p));
    render(<Harness providers={providers} initial={{ allowed: [SONNET, 'openrouter/gone/model'], default: SONNET }} />);
    expect(screen.getByText('Needs an API key')).toBeInTheDocument();
    expect(screen.getByText('No longer listed')).toBeInTheDocument();
  });

  it('moves focus to the next row after a remove, and to the list when none remain', () => {
    render(<Harness initial={{ allowed: [SONNET, KIMI], default: SONNET }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Sonnet 4.6' }));
    expect(screen.getByRole('radio', { name: 'Make Kimi K3 the Default' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    expect(screen.getByText('No models yet')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
  });
});
```

- [x] **Step 4: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/ModelPanes.test.tsx`
Expected: FAIL — cannot resolve `../ModelCatalogPane`.

- [x] **Step 5: Implement the panes**

`packages/channel-web/src/components/admin/ModelCatalogPane.tsx`:

```tsx
import { useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import type { CatalogProvider } from '@/lib/models-admin';
import { countModels } from '@/lib/models-picker';
import { cachedNote, countLine, providerNoKey, providerProblem } from '@/lib/models-copy';

export interface ModelCatalogPaneProps {
  /** Everything the catalog returned (unfiltered). */
  providers: readonly CatalogProvider[];
  /** The same providers after the search filter. */
  shown: readonly CatalogProvider[];
  selected: ReadonlySet<string>;
  query: string;
  onQueryChange(query: string): void;
  onToggle(ref: string): void;
  onSelectAllShown(refs: string[]): void;
  onRetry(): void;
  retrying: boolean;
  onOpenKeys?: () => void;
  nowMs: number;
}

export function ModelCatalogPane(props: ModelCatalogPaneProps) {
  const { providers, shown, selected, query, onQueryChange, onToggle, onSelectAllShown } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const filtering = query.trim() !== '';
  const total = countModels(providers);
  const shownCount = countModels(shown);
  const shownRefs = shown.flatMap((p) => p.models.map((m) => m.ref));
  const allShownSelected = shownRefs.every((r) => selected.has(r));

  // While searching, providers that still have matches stay visible even with
  // no models listed only when they carry a problem note worth showing.
  const groups = filtering ? shown : providers;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <CardTitle role="heading" aria-level={2} className="text-lg">
          All models
        </CardTitle>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name or provider"
            aria-label="Search models"
            className="pl-8"
          />
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <p role="status" aria-live="polite">
            {countLine(shownCount, total, filtering)}
          </p>
          {filtering && shownCount > 0 && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={allShownSelected}
              onClick={() => onSelectAllShown(shownRefs)}
            >
              Select all {shownCount} shown
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="max-h-[60vh] space-y-4 overflow-y-auto">
        {filtering && shownCount === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No models match “{query.trim()}”</EmptyTitle>
              <EmptyDescription>Try a different word, or clear the search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {groups.map((p) => {
          const open = filtering || !collapsed.has(p.id);
          return (
            <Collapsible
              key={p.id}
              open={open}
              onOpenChange={(next) =>
                setCollapsed((prev) => {
                  const copy = new Set(prev);
                  if (next) copy.delete(p.id);
                  else copy.add(p.id);
                  return copy;
                })
              }
            >
              <CollapsibleTrigger asChild>
                <button type="button" className="flex w-full items-center gap-1 text-left text-sm font-medium">
                  {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                  {p.name}
                  <span className="text-muted-foreground">({p.models.length})</span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {(p.status === 'fallback' || p.status === 'error') && (
                  <Alert>
                    <AlertDescription className="flex flex-wrap items-center gap-3">
                      <span>{providerProblem(p.name)}</span>
                      <Button type="button" variant="outline" size="sm" disabled={props.retrying} onClick={props.onRetry}>
                        Try again
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {p.status === 'cached' && (
                  <p className="text-xs text-muted-foreground">{cachedNote(p.fetchedAt, props.nowMs)}</p>
                )}
                {p.status === 'no-key' && (
                  <p className="text-sm text-muted-foreground">
                    {providerNoKey(p.name)}{' '}
                    {props.onOpenKeys !== undefined && (
                      <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={props.onOpenKeys}>
                        Open AI model keys
                      </Button>
                    )}
                  </p>
                )}
                <ul className="space-y-1">
                  {p.models.map((m) => (
                    <li key={m.ref}>
                      {/* The raw ref is in the native title: 400+ rows make a Radix Tooltip per row too heavy. */}
                      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted" title={m.ref}>
                        <Checkbox checked={selected.has(m.ref)} onCheckedChange={() => onToggle(m.ref)} />
                        <span>{m.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

`packages/channel-web/src/components/admin/SelectedModelsPane.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { CatalogProvider } from '@/lib/models-admin';
import { selectedInfo, type Draft } from '@/lib/models-picker';
import { DEFAULT_HELP, NEEDS_KEY, NONE_SELECTED_BODY, NONE_SELECTED_TITLE, NO_LONGER_LISTED } from '@/lib/models-copy';

export interface SelectedModelsPaneProps {
  draft: Draft;
  providers: readonly CatalogProvider[];
  onSetDefault(ref: string): void;
  onRemove(ref: string): void;
}

export function SelectedModelsPane({ draft, providers, onSetDefault, onRemove }: SelectedModelsPaneProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfterRemove = useRef<number | null>(null);

  // The remove button the admin just pressed is gone after the re-render, so keyboard
  // and screen-reader users would land on <body>. Put focus on the row that took its
  // place (or the one above it), and on the list itself when nothing is left.
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const radios = listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    const target = radios !== undefined && radios.length > 0 ? radios[Math.min(index, radios.length - 1)] : listRef.current;
    target?.focus();
  }, [draft.allowed]);

  function remove(ref: string) {
    focusAfterRemove.current = draft.allowed.indexOf(ref);
    onRemove(ref);
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle role="heading" aria-level={2} className="text-lg">
          Available to users ({draft.allowed.length})
        </CardTitle>
        <CardDescription>{DEFAULT_HELP}</CardDescription>
      </CardHeader>
      <CardContent>
        <div ref={listRef} tabIndex={-1} className="outline-none">
          {draft.allowed.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{NONE_SELECTED_TITLE}</EmptyTitle>
                <EmptyDescription>{NONE_SELECTED_BODY}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RadioGroup value={draft.default} onValueChange={onSetDefault} className="gap-2">
              {draft.allowed.map((ref) => {
                const info = selectedInfo(ref, providers);
                return (
                  <div key={ref} className="flex items-center gap-2 rounded border border-border px-2 py-1.5" title={ref}>
                    <RadioGroupItem value={ref} id={`default-${ref}`} aria-label={`Make ${info.label} the Default`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{info.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{info.providerName}</p>
                    </div>
                    {ref === draft.default && <Badge>Default</Badge>}
                    {info.noLongerListed && <Badge variant="outline">{NO_LONGER_LISTED}</Badge>}
                    {info.needsKey && <Badge variant="outline">{NEEDS_KEY}</Badge>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${info.label}`}
                      onClick={() => remove(ref)}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </RadioGroup>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [x] **Step 6: Run, type-check, commit**

Run: `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/models-picker.test.ts src/components/admin/__tests__/ModelPanes.test.tsx`
Expected: PASS. If a query by role/name fails because Radix renders the checkbox's accessible name differently, keep the component as written and adjust the **test** query (for example `screen.getByLabelText(...)`), not the copy.

Run: `pnpm --filter @ax/channel-web exec tsc --noEmit -p . && npx eslint packages/channel-web/src`
Expected: exit 0, exit 0.

```bash
git add packages/channel-web
git commit -m "feat(channel-web): model picker logic and the two panes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The Models tab — loading, saving, the impact dialog

**Files:**
- Create: `packages/channel-web/src/components/admin/ModelsTab.tsx`, `packages/channel-web/src/components/admin/SaveImpactDialog.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/ModelsTab.test.tsx`

**Interfaces:**
- Produces (used by Task 14): `<ModelsTab onOpenKeys?: () => void />`.
- Consumes: Tasks 11–12 (`fetchPolicy`, `fetchCatalog`, `savePolicy`, `fetchImpact`, `saveFailure`, panes, picker logic), `toastActions` from `@/lib/toast-store`.

- [x] **Step 1: Write the failing tab tests**

`packages/channel-web/src/components/admin/__tests__/ModelsTab.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toastActions } from '@/lib/toast-store';
import { ModelsTab } from '../ModelsTab';

const OPUS = 'anthropic/claude-opus-4-7';
const SONNET = 'anthropic/claude-sonnet-4-6';
const KIMI = 'openrouter/moonshotai/kimi-k3';
const GROK = 'openrouter/x-ai/grok-4.6';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let handler: (c: Call) => Response | Promise<Response>;
let showToast: ReturnType<typeof vi.spyOn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const policy = (over: Record<string, unknown> = {}) => ({
  source: 'admin',
  version: 2,
  allowed: [SONNET, KIMI],
  default: SONNET,
  updatedAt: 'T',
  updatedBy: 'u',
  ...over,
});
const catalog = (over: { openrouter?: Record<string, unknown>; anthropic?: Record<string, unknown> } = {}) => ({
  providers: [
    { id: 'anthropic', name: 'Anthropic', status: 'live', fetchedAt: '2026-09-30T12:00:00Z', models: [{ ref: OPUS, label: 'Claude Opus 4.7' }, { ref: SONNET, label: 'Claude Sonnet 4.6' }], ...over.anthropic },
    { id: 'openrouter', name: 'OpenRouter', status: 'live', fetchedAt: '2026-09-30T12:00:00Z', models: [{ ref: KIMI, label: 'Kimi K3' }, { ref: GROK, label: 'xAI: Grok 4.6' }], ...over.openrouter },
  ],
});

let pol = policy();
let cat = catalog();
let impact: Array<{ model: string; agentCount: number }> = [];

function defaultHandler(c: Call): Response {
  if (c.method === 'GET' && c.path.startsWith('/admin/models/policy')) return json(200, pol);
  if (c.method === 'GET' && c.path.startsWith('/admin/models/catalog')) return json(200, cat);
  if (c.method === 'POST' && c.path === '/admin/agents/models/impact') return json(200, { affected: impact });
  if (c.method === 'PUT' && c.path === '/admin/models/policy') {
    const b = c.body as { allowed: string[]; default: string; baseVersion: number };
    return json(200, policy({ version: b.baseVersion + 1, allowed: b.allowed, default: b.default }));
  }
  return json(404, {});
}
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.startsWith(path));

beforeEach(() => {
  pol = policy();
  cat = catalog();
  impact = [];
  calls = [];
  handler = defaultHandler;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c: Call = {
        method: init?.method ?? 'GET',
        path: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(c);
      return handler(c);
    }),
  );
  toastActions.reset();
  showToast = vi.spyOn(toastActions, 'show');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  render(<ModelsTab />);
  await screen.findByRole('heading', { name: 'All models' });
}
const save = () => screen.getByRole('button', { name: 'Save changes' });

describe('ModelsTab — loading', () => {
  it('shows both panes with the saved selection and Default', async () => {
    await ready();
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make Claude Sonnet 4.6 the Default' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Kimi K3/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).not.toBeChecked();
  });

  it('tells the admin they are on the built-in list until they save', async () => {
    pol = policy({ source: 'builtin', version: 0 });
    await ready();
    expect(screen.getByText("You're using the built-in list. Nothing changes until you save.")).toBeInTheDocument();
  });

  it('warns when the saved list could not be read', async () => {
    pol = policy({ source: 'builtin', version: 0, warning: 'saved-policy-unreadable' });
    await ready();
    expect(screen.getByText(/We couldn't read the saved list, so we're using the built-in one for now\./)).toBeInTheDocument();
  });

  it('says what happened and recovers with Try again when the saved list will not load', async () => {
    let n = 0;
    handler = (c) => (c.path.startsWith('/admin/models/policy') && ++n === 1 ? json(500, { error: 'db' }) : defaultHandler(c));
    render(<ModelsTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load the saved list of models.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'All models' });
  });

  it('still shows the saved selection when only the catalog fails', async () => {
    handler = (c) => (c.path.startsWith('/admin/models/catalog') ? json(500, {}) : defaultHandler(c));
    render(<ModelsTab />);
    await screen.findByRole('heading', { name: 'Available to users (2)' });
    expect(screen.getByText("We couldn't load the model list. Your current selection is safe.")).toBeInTheDocument();
  });

  it('Try again on a provider asks for a refreshed catalog', async () => {
    cat = catalog({ openrouter: { status: 'fallback' } });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(callsTo('GET', '/admin/models/catalog?refresh=1')).toHaveLength(1));
  });
});

describe('ModelsTab — saving', () => {
  it('Save is off until something changes, and Cancel puts everything back', async () => {
    await ready();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    expect(save()).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(save()).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Available to users (2)' })).toBeInTheDocument();
  });

  it('Save is off when nothing is selected', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Sonnet 4.6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    expect(save()).toBeDisabled();
  });

  it('adding a model saves straight away (no agents to move), with the version it loaded', async () => {
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
    const put = callsTo('PUT', '/admin/models/policy')[0]!;
    expect(put.body).toEqual({ baseVersion: 2, allowed: [SONNET, KIMI, OPUS], default: SONNET });
    expect(put.headers['x-requested-with']).toBe('ax-admin');
    expect(callsTo('POST', '/admin/agents/models/impact')).toHaveLength(0);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Models saved' })));
    expect(save()).toBeDisabled(); // now clean, at version 3
  });

  it('removing a model nobody uses saves without a confirmation', async () => {
    impact = [];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
    expect(callsTo('POST', '/admin/agents/models/impact')[0]!.body).toEqual({ remove: [KIMI] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removing a model agents use asks first, names the count and the Default, and saves only on confirm', async () => {
    impact = [{ model: KIMI, agentCount: 3 }];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    const dialog = await screen.findByRole('dialog', { name: 'Move 3 agents to Claude Sonnet 4.6?' });
    expect(within(dialog).getByText('Kimi K3: 3 agents')).toBeInTheDocument();
    expect(within(dialog).getByText(/From their next chat they'll use Claude Sonnet 4\.6 instead\./)).toBeInTheDocument();
    expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
    expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(save());
    fireEvent.click(await screen.findByRole('button', { name: 'Save and move them' }));
    await waitFor(() => expect(callsTo('PUT', '/admin/models/policy')).toHaveLength(1));
  });

  it("uses the singular for one agent", async () => {
    impact = [{ model: KIMI, agentCount: 1 }];
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    expect(await screen.findByRole('dialog', { name: 'Move 1 agent to Claude Sonnet 4.6?' })).toBeInTheDocument();
  });

  it("still confirms, honestly, when the agent count can't be fetched", async () => {
    handler = (c) => (c.path === '/admin/agents/models/impact' ? json(500, {}) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K3' }));
    fireEvent.click(save());
    const dialog = await screen.findByRole('dialog', { name: 'Some agents may move to Claude Sonnet 4.6' });
    expect(within(dialog).getByText(/We couldn't check which agents use the models you removed\./)).toBeInTheDocument();
  });

  it('reports a conflict with a Reload that brings back the other admin’s version', async () => {
    handler = (c) => (c.method === 'PUT' ? json(409, { error: 'stale-version' }) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    expect(await screen.findByText('Someone else just changed this list. Reload to see their version.')).toBeInTheDocument();
    pol = policy({ version: 3, allowed: [KIMI], default: KIMI });
    handler = defaultHandler;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await screen.findByRole('heading', { name: 'Available to users (1)' });
    expect(screen.queryByText(/Someone else just changed/)).toBeNull();
  });

  it('says plainly what went wrong, keeps the draft, and lets the admin try again', async () => {
    handler = (c) => (c.method === 'PUT' ? json(500, { error: 'boom' }) : defaultHandler(c));
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    fireEvent.click(save());
    expect(await screen.findByText("We couldn't save that. Nothing changed. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ })).toBeChecked();
    expect(save()).toBeEnabled();
  });
});

describe('ModelsTab — unsaved changes', () => {
  it('asks the browser to confirm before leaving the page with unsaved changes', async () => {
    await ready();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Claude Opus 4\.7/ }));
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe('ModelsTab — the keys link', () => {
  it('passes onOpenKeys through to a provider with no key', async () => {
    cat = catalog({ openrouter: { status: 'no-key', models: [] } });
    const onOpenKeys = vi.fn();
    render(<ModelsTab onOpenKeys={onOpenKeys} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open AI model keys' }));
    expect(onOpenKeys).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/ModelsTab.test.tsx`
Expected: FAIL — cannot resolve `../ModelsTab`.

- [x] **Step 3: Implement the dialog**

`packages/channel-web/src/components/admin/SaveImpactDialog.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { impactExplain, impactLine, impactTitle } from '@/lib/models-copy';

export interface ImpactLine {
  label: string;
  agentCount: number;
}

export interface SaveImpactDialogProps {
  open: boolean;
  /** `null` = we could not count; say so honestly instead of guessing. */
  lines: ImpactLine[] | null;
  defaultLabel: string;
  saving: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export function SaveImpactDialog({ open, lines, defaultLabel, saving, onConfirm, onCancel }: SaveImpactDialogProps) {
  const total = lines === null ? null : lines.reduce((n, l) => n + l.agentCount, 0);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{impactTitle(total, defaultLabel)}</DialogTitle>
          <DialogDescription>{impactExplain(defaultLabel, lines !== null)}</DialogDescription>
        </DialogHeader>
        {lines !== null && (
          <ul className="space-y-1 text-sm">
            {lines.map((l) => (
              <li key={l.label}>{impactLine(l.label, l.agentCount)}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Go back
          </Button>
          <Button type="button" onClick={onConfirm} disabled={saving}>
            {saving ? 'Saving…' : 'Save and move them'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [x] **Step 4: Implement the tab**

`packages/channel-web/src/components/admin/ModelsTab.tsx`:

```tsx
/**
 * ModelsTab — the admin picks which models people may use in their agents.
 *
 * Two panes: every model the providers offer (search, tick) and the ones that
 * will be available (one marked Default). Saving asks first only when agents
 * use a model being removed; those agents run on the Default from their next
 * chat (resolved at chat time on the server, never rewritten).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchCatalog,
  fetchImpact,
  fetchPolicy,
  savePolicy,
  type CatalogProvider,
  type ModelPolicy,
} from '@/lib/models-admin';
import {
  BUILTIN_NOTICE,
  CATALOG_LOAD_FAILED,
  POLICY_LOAD_FAILED,
  SAVED_DETAIL,
  SAVED_TITLE,
  TAB_INTRO,
  UNREADABLE_NOTICE,
  saveFailure,
} from '@/lib/models-copy';
import {
  addModels,
  filterProviders,
  isDirty,
  labelFor,
  removeModel,
  removedModels,
  setDefault,
  toggleModel,
  type Draft,
} from '@/lib/models-picker';
import { toastActions } from '@/lib/toast-store';
import { ModelCatalogPane } from './ModelCatalogPane';
import { SaveImpactDialog, type ImpactLine } from './SaveImpactDialog';
import { SelectedModelsPane } from './SelectedModelsPane';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; policy: ModelPolicy; providers: CatalogProvider[]; catalogFailed: boolean };

const draftOf = (p: ModelPolicy): Draft => ({ allowed: [...p.allowed], default: p.default });

export function ModelsTab({ onOpenKeys }: { onOpenKeys?: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; stale: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ lines: ImpactLine[] | null } | null>(null);
  const readSeq = useRef(0);

  const loadAll = useCallback(async () => {
    const mine = ++readSeq.current;
    setLoad({ kind: 'loading' });
    const [pol, cat] = await Promise.allSettled([fetchPolicy(), fetchCatalog()]);
    if (mine !== readSeq.current) return; // a newer read (or an unmount) owns the screen
    if (pol.status === 'rejected') {
      console.warn('models: could not load the saved policy', pol.reason);
      setLoad({ kind: 'error', message: POLICY_LOAD_FAILED });
      return;
    }
    if (cat.status === 'rejected') console.warn('models: could not load the catalog', cat.reason);
    setLoad({
      kind: 'ready',
      policy: pol.value,
      providers: cat.status === 'fulfilled' ? cat.value : [],
      catalogFailed: cat.status === 'rejected',
    });
    setDraft(draftOf(pol.value));
    setSaveError(null);
  }, []);

  useEffect(() => {
    void loadAll();
    return () => {
      readSeq.current += 1; // ignore anything still in flight after unmount
    };
  }, [loadAll]);

  const policy = load.kind === 'ready' ? load.policy : null;
  const dirty = policy !== null && draft !== null && isDirty(draftOf(policy), draft);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function retryCatalog() {
    setRetrying(true);
    try {
      const providers = await fetchCatalog({ refresh: true });
      setLoad((prev) => (prev.kind === 'ready' ? { ...prev, providers, catalogFailed: false } : prev));
    } catch (err) {
      console.warn('models: catalog refresh failed', err);
    } finally {
      setRetrying(false);
    }
  }

  async function commit() {
    if (policy === null || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await savePolicy({ baseVersion: policy.version, allowed: draft.allowed, default: draft.default });
      setLoad((prev) => (prev.kind === 'ready' ? { ...prev, policy: saved } : prev));
      setDraft(draftOf(saved));
      setConfirm(null);
      toastActions.show({ title: SAVED_TITLE, detail: SAVED_DETAIL, kind: 'info' });
    } catch (err) {
      console.warn('models: save failed', err);
      setConfirm(null);
      setSaveError(saveFailure(err));
    } finally {
      setSaving(false);
    }
  }

  async function onSave() {
    if (policy === null || draft === null) return;
    const removed = removedModels(draftOf(policy), draft);
    if (removed.length === 0) {
      await commit();
      return;
    }
    setChecking(true);
    try {
      const rows = await fetchImpact(removed);
      if (rows.length === 0) {
        setChecking(false);
        await commit();
        return;
      }
      const providers = load.kind === 'ready' ? load.providers : [];
      setConfirm({ lines: rows.map((r) => ({ label: labelFor(r.model, providers), agentCount: r.agentCount })) });
    } catch (err) {
      console.warn('models: could not count the agents on removed models', err);
      setConfirm({ lines: null });
    } finally {
      setChecking(false);
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="mx-auto max-w-[960px] font-sans" role="status">
        <span className="sr-only">Loading models…</span>
        <div className="grid gap-4 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (load.kind === 'error') {
    return (
      <div className="mx-auto max-w-[960px] font-sans">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-3">
            <p>{load.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { providers } = load;
  const current = draft ?? draftOf(load.policy);
  const defaultLabel = labelFor(current.default, providers);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4 pb-4 font-sans">
      <p className="text-sm text-muted-foreground">{TAB_INTRO}</p>

      {load.policy.warning === 'saved-policy-unreadable' ? (
        <Alert>
          <AlertDescription>{UNREADABLE_NOTICE}</AlertDescription>
        </Alert>
      ) : (
        load.policy.source === 'builtin' && (
          <Alert>
            <AlertDescription>{BUILTIN_NOTICE}</AlertDescription>
          </Alert>
        )
      )}
      {load.catalogFailed && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{CATALOG_LOAD_FAILED}</span>
            <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={() => void retryCatalog()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-4 md:grid-cols-2">
        <ModelCatalogPane
          providers={providers}
          shown={filterProviders(providers, query)}
          selected={new Set(current.allowed)}
          query={query}
          onQueryChange={setQuery}
          onToggle={(ref) => setDraft((d) => toggleModel(d ?? current, ref))}
          onSelectAllShown={(refs) => setDraft((d) => addModels(d ?? current, refs))}
          onRetry={() => void retryCatalog()}
          retrying={retrying}
          {...(onOpenKeys !== undefined ? { onOpenKeys } : {})}
          nowMs={Date.now()}
        />
        <SelectedModelsPane
          draft={current}
          providers={providers}
          onSetDefault={(ref) => setDraft((d) => setDefault(d ?? current, ref))}
          onRemove={(ref) => setDraft((d) => removeModel(d ?? current, ref))}
        />
      </div>

      {saveError !== null && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{saveError.message}</span>
            {saveError.stale && (
              <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
                Reload
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-border bg-background px-1 py-3">
        {dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
        <Button type="button" variant="outline" disabled={!dirty || saving} onClick={() => setDraft(draftOf(load.policy))}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!dirty || saving || checking || current.allowed.length === 0}
          onClick={() => void onSave()}
        >
          {saving || checking ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <SaveImpactDialog
        open={confirm !== null}
        lines={confirm?.lines ?? null}
        defaultLabel={defaultLabel}
        saving={saving}
        onConfirm={() => void commit()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
```

- [x] **Step 5: Run the tab tests, fix only real defects, commit**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/ModelsTab.test.tsx`
Expected: PASS. If a role/name query fails because of how Radix renders a control, adjust the **query**, not the user-facing copy. If `Save changes` reads `Saving…` during the "removing a model nobody uses" flow, that is the `checking` state and the test already waits for the PUT.

Run: `pnpm --filter @ax/channel-web exec tsc --noEmit -p . && npx eslint packages/channel-web/src`
Expected: exit 0, exit 0.

```bash
git add packages/channel-web
git commit -m "feat(channel-web): the Models tab with save confirmation for models agents use

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Register the tab in the admin shell

**Files:**
- Modify: `packages/channel-web/src/components/admin/AdminSidebar.tsx`, `packages/channel-web/src/components/admin/AdminShell.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/AdminSidebar.test.tsx`, `AdminShellHeadings.test.tsx`, `AdminShell.test.tsx`

**Interfaces:**
- Consumes: `<ModelsTab onOpenKeys />` (Task 13).
- Produces: the `'models'` tab id, nav label "Models", heading "Available models", placed right after "AI model keys".

- [x] **Step 1: Write the failing tests**

In `AdminSidebar.test.tsx`, add (inside the existing `describe` that builds the admin nav, reusing its render helper and `items` list of nav labels):

```tsx
  it('lists Models right after AI model keys, for admins only', () => {
    // `items` is the list of nav labels the existing tests in this file build for an admin.
    expect(items.indexOf('Models')).toBe(items.indexOf('AI model keys') + 1);
  });
```

(Use the same variable/helper names the neighbouring tests in that file use for "the admin nav labels"; do not invent a new render path. The two existing adjacency pins — Usage right after Branding, Storage right after Routines — must still pass.)

In `AdminShellHeadings.test.tsx`, add `['Models', 'Available models']` to the `TABS` array of `[nav label, expected h1]` pairs (~lines 129-139).

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/AdminSidebar.test.tsx src/components/admin/__tests__/AdminShellHeadings.test.tsx`
Expected: FAIL — no "Models" nav item.

- [x] **Step 3: Implement**

`AdminSidebar.tsx`:

1. Add `Layers` to the `lucide-react` import list.
2. Add `| 'models'` to `AdminTabId`, directly after `| 'providers'`.
3. In `ADMIN_NAV`, insert this entry directly after the `providers` entry and before `model-config`:

```ts
  { id: 'models', label: 'Models', icon: Layers },
```

`AdminShell.tsx`:

1. Add `import { ModelsTab } from './ModelsTab';` next to the other tab imports.
2. In `TAB_META` add (the record is exhaustive, so this is required to compile):

```ts
  models: { eyebrow: 'Admin', title: 'Available models' },
```

3. Next to `{activeTab === 'model-config' && <ModelConfigTab />}` add:

```tsx
        {activeTab === 'models' && <ModelsTab onOpenKeys={() => onTabChange('providers')} />}
```

Use the name of the function the shell already passes to `AdminSidebar` as `onTabChange` (if the shell holds the tab in `useState`, that is its setter; call it with `'providers'`). Do not add a second source of truth for the active tab.

- [x] **Step 4: Run, fix fall-through responses, commit**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/AdminSidebar.test.tsx src/components/admin/__tests__/AdminShellHeadings.test.tsx src/components/admin/__tests__/AdminShell.test.tsx`
Expected: PASS. If the headings or shell test fails because its fetch fall-through (`{ providers: [], agents: [], teams: [], connectors: [] }`) is not a valid policy, add two branches to that test's fetch handler, before the fall-through: `/admin/models/policy` → `{ source: 'builtin', version: 0, allowed: [], default: '' }` hmm — no: use a valid non-empty shape `{ source: 'builtin', version: 0, allowed: ['anthropic/claude-sonnet-4-6'], default: 'anthropic/claude-sonnet-4-6' }`, and `/admin/models/catalog` → `{ providers: [] }`. (The error state would also satisfy the one-`h1` outline check, but the ready state is the honest one to test.)

Run: `pnpm --filter @ax/channel-web test`
Expected: PASS (whole package, including `vocabulary.test.ts` and the heading-outline guards).

Run: `pnpm --filter @ax/channel-web exec tsc --noEmit -p . && npx eslint packages/channel-web/src`
Expected: exit 0, exit 0.

```bash
git add packages/channel-web
git commit -m "feat(channel-web): add the Models tab to the admin sidebar

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Agent editor — the Default, the moved-model notice, and never re-saving the model

**Files:**
- Modify: `packages/channel-web/src/components/admin/AgentForm.tsx`
- Test: `packages/channel-web/src/components/admin/__tests__/AgentForm.test.tsx`

**Interfaces:**
- Consumes: `listAgentModelOptions()` / `AdminAgent.requestedModel` (Task 11), `movedNotice` (Task 11).
- Behavior: a new agent pre-selects the admin's Default; an edit sends `model` in the `PATCH` **only if the user changed it**; an agent whose model was swapped shows a notice.

- [x] **Step 1: Migrate the existing test mocks to the new client function**

The form will call `listAgentModelOptions`. In `AgentForm.test.tsx` run this mechanical rewrite (the first substitution handles the seven `mockResolvedValue(MODEL_OPTIONS)` lines, the second renames the import and the closed `vi.mock` factory entry):

```bash
perl -0pi -e 's/vi\.mocked\(listAgentModels\)\.mockResolvedValue\(MODEL_OPTIONS\)/vi.mocked(listAgentModelOptions).mockResolvedValue({ models: MODEL_OPTIONS, defaultModel: null })/g; s/\blistAgentModels\b/listAgentModelOptions/g' packages/channel-web/src/components/admin/__tests__/AgentForm.test.tsx
grep -n "listAgentModel" packages/channel-web/src/components/admin/__tests__/AgentForm.test.tsx
```

Expected: only `listAgentModelOptions` remains (in the factory, the import list and the `mockResolvedValue` lines).

- [x] **Step 2: Write the failing tests**

Append to `AgentForm.test.tsx`:

```tsx
describe('AgentForm — model policy (Default, moved notice, PATCH body)', () => {
  const ADMIN_DEFAULT_OPTIONS = [
    { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', kind: 'either' as const },
    { id: 'openrouter/moonshotai/kimi-k3', label: 'Kimi K3', kind: 'either' as const },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTeams).mockResolvedValue([]);
    vi.mocked(listConnectors).mockResolvedValue([]);
    vi.mocked(patchAgent).mockResolvedValue(undefined);
    vi.mocked(patchAgentConnectorAttachments).mockResolvedValue(AGENT);
    vi.mocked(putAgentIdentity).mockResolvedValue(undefined);
    vi.mocked(createAgent).mockResolvedValue(AGENT);
    vi.mocked(getAgentIdentity).mockResolvedValue({ identity: '', soul: '', operating: '' });
  });

  const modelSelect = () => document.querySelector<HTMLSelectElement>('#agent-model')!;

  it("pre-selects the admin's Default for a NEW agent (not just the first option)", async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({
      models: ADMIN_DEFAULT_OPTIONS,
      defaultModel: 'openrouter/moonshotai/kimi-k3',
    });
    mockList.mockResolvedValue([]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText(/No agents yet/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect(modelSelect().value).toBe('openrouter/moonshotai/kimi-k3'));
  });

  it('falls back to the first option when the server names no Default', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: null });
    mockList.mockResolvedValue([]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText(/No agents yet/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /new agent/i }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));
  });

  it('an edit that leaves the model alone sends NO model in the PATCH (a swapped agent keeps its stored model)', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    // The server resolved this agent onto the Default because its own model was removed.
    mockList.mockResolvedValue([{ ...AGENT, requestedModel: 'openrouter/moonshotai/kimi-k3' }]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchAgent).toHaveBeenCalledTimes(1));
    const body = vi.mocked(patchAgent).mock.calls[0]?.[1] ?? {};
    expect(body).toMatchObject({ displayName: 'Renamed Bot' });
    expect(body).not.toHaveProperty('model');
  });

  it('an edit that changes the model sends it', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));

    fireEvent.change(modelSelect(), { target: { value: 'openrouter/moonshotai/kimi-k3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(patchAgent).mock.calls[0]?.[1]).toMatchObject({ model: 'openrouter/moonshotai/kimi-k3' });
  });

  it('tells the owner their agent moved, in plain words', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([{ ...AGENT, requestedModel: 'openrouter/moonshotai/kimi-k3' }]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    expect(
      await screen.findByText(
        'Your admin changed the available models, so this agent is using Claude Sonnet 4.6 now. Pick a different model to change it.',
      ),
    ).toBeInTheDocument();
  });

  it('shows no notice for an agent on its own model', async () => {
    vi.mocked(listAgentModelOptions).mockResolvedValue({ models: ADMIN_DEFAULT_OPTIONS, defaultModel: 'anthropic/claude-sonnet-4-6' });
    mockList.mockResolvedValue([AGENT]);
    render(<AgentForm isAdmin />);
    await waitFor(() => expect(screen.getByText('Research Bot')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(modelSelect().value).toBe('anthropic/claude-sonnet-4-6'));
    expect(screen.queryByText(/Your admin changed the available models/)).toBeNull();
  });
});
```

- [x] **Step 3: Run to verify failure**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/AgentForm.test.tsx`
Expected: FAIL — the form still calls `listAgentModels` (the mocks return `undefined`), ignores the Default, and always sends `model`.

- [x] **Step 4: Implement in `AgentForm.tsx`**

1. Imports: replace `listAgentModels` with `listAgentModelOptions` in the `@/lib/admin` import; add `import { movedNotice } from '@/lib/models-copy';`. If `Alert`/`AlertDescription` are not already imported, add `import { Alert, AlertDescription } from '@/components/ui/alert';`.
2. `effectiveModelId` (near line 189) becomes:

```ts
export function effectiveModelId(
  formModel: string,
  options: ReadonlyArray<{ id: string }>,
  defaultModel: string | null = null,
): string {
  if (formModel !== '') return formModel;
  if (defaultModel !== null && options.some((o) => o.id === defaultModel)) return defaultModel;
  return options[0]?.id ?? '';
}
```

3. Next to `const [models, setModels] = useState<AgentModelOption[] | null>(null);` add `const [defaultModel, setDefaultModel] = useState<string | null>(null);`
4. In the effect that loads models (near line 295) replace

```ts
void listAgentModels().then((m) => setModels(m)).catch(...)
```

with (keep the existing `.catch` body exactly as it is):

```ts
void listAgentModelOptions()
  .then(({ models: m, defaultModel: d }) => {
    setModels(m);
    setDefaultModel(d);
  })
  .catch(/* unchanged existing handler */)
```

5. Where `selectedModel` is computed (near line 439) pass the default: `const selectedModel = effectiveModelId(form.model, modelOptions, defaultModel);`
6. In the submit path (near lines 491-531), change the edit `patch` so `model` is sent only when the user changed it. Replace

```ts
const patch: Partial<AdminAgentInput> = { displayName: base.displayName, model: base.model };
```

with

```ts
// `model` goes out ONLY if the user changed it. For an agent the admin moved
// onto the Default, `editing.model` is that Default; re-sending it would save
// the swap as the owner's own choice.
const patch: Partial<AdminAgentInput> = { displayName: base.displayName };
if (base.model !== editing.model) patch.model = base.model;
```

7. Directly above the `<select id="agent-model" …>` field (inside the same field group), render the notice for an edit of a moved agent:

```tsx
{editing?.requestedModel !== undefined && (
  <Alert>
    <AlertDescription>
      {movedNotice(modelOptions.find((o) => o.id === selectedModel)?.label ?? selectedModel)}
    </AlertDescription>
  </Alert>
)}
```

(`editing` and `modelOptions` are the names the file already uses for the agent being edited and the option list including the "(not available)" fallback entry.)

- [x] **Step 5: Run the suite, type-check, commit**

Run: `pnpm --filter @ax/channel-web exec vitest run src/components/admin/__tests__/AgentForm.test.tsx`
Expected: PASS, including every pre-existing test (the identity-only test that asserts `allowedTools`/`mcpConfigIds` are not sent still passes: only `model` changed in that logic).

Run: `pnpm --filter @ax/channel-web test && pnpm --filter @ax/channel-web exec tsc --noEmit -p . && npx eslint packages/channel-web/src`
Expected: PASS, exit 0, exit 0.

```bash
git add packages/channel-web
git commit -m "feat(channel-web): agent editor uses the admin's Default, explains a moved model, and stops re-saving it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

### Task 16: Whole-repo gates, spec reconciliation, real-browser walk, memory, PR notes

**Files:**
- Modify: `docs/plans/2026-09-30-model-policy-design.md` (record what planning changed)
- Create: memory shards under `.claude/memory/` (via `scripts/memory-write-target.sh`)
- No product code changes unless a gate below fails; fix the cause in the owning task's files.

**Interfaces:** none new.

- [x] **Step 1: Run the full repo gate, the way CI does (not the partial one)**

`pnpm -r run test` stops at the first failing package, so always use the `--no-bail` form and run all three suites:

```bash
DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock \
  pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts
```

Expected: PASS. A Docker teardown timeout in `@ax/auth-better` with all its assertions passing is a known local flake, not a failure of this work; re-run that package alone to confirm (`pnpm --filter @ax/auth-better test`).

Run: `pnpm typecheck`
Expected: exit 0.

Run the scoped lint (the root `pnpm lint` can fail on stale sibling worktrees):

```bash
npx eslint packages/model-policy packages/agents packages/llm-openrouter packages/llm-anthropic packages/channel-web/src presets/k8s/src
```

Expected: exit 0.

Run: `pnpm audit --audit-level moderate`
Expected: `No known vulnerabilities found`. This change adds no npm dependency (a workspace link only), so a failure here is the repo's current audit state, not this work; report it and do not "fix" it in this PR.

- [x] **Step 2: Record what planning changed in the spec**

Edit `docs/plans/2026-09-30-model-policy-design.md` with exactly these four replacements (each old text appears once).

1. Section 5, the row line. Old:

```markdown
- Row: `Checkbox` + friendly name; the raw ref is in a `Tooltip`.
```

   New:

```markdown
- Row: `Checkbox` + friendly name; the raw ref is in the row's native `title` (a Radix `Tooltip` on each of 400+ rows is too heavy).
```

2. Section 5, the footer sentence. Old:

```markdown
Leaving with unsaved changes asks first.
```

   New:

```markdown
Closing or reloading the page with unsaved changes asks first (the browser's own prompt). Switching to another admin tab does not ask yet: that needs the dirty flag lifted into `AdminShell`, which this design deliberately leaves to a follow-up.
```

3. Section 4.1, directly after the paragraph that ends `(a model a provider has stopped listing stays valid).` add a new paragraph:

```markdown
**Concurrency:** `storage:set` has no compare-and-swap, so the `baseVersion` check is serialized inside the process (a promise chain around read-check-write). That is sufficient because the host is single-replica by design (the Helm chart refuses `replicas > 1`).
```

4. Replace the whole of section 10 (from the heading `## 10. Open items for the implementation plan` to the end of the file) with:

```markdown
## 10. Open items — resolved during planning

1. Provider list APIs confirmed against the vendor docs: Anthropic `GET /v1/models` (`x-api-key` + `anthropic-version: 2023-06-01`, `limit` up to 1000, `after_id` paging, `data[].id/display_name`); OpenRouter `GET /api/v1/models` (works unauthenticated, ~464 models today, `data[].id/name`, ids may carry a `:variant` suffix).
2. Consumer audit done: the orchestrator reads the model, provider endpoint, runner binary and recorded runner type from the `agents:resolve` record, and `@ax/conversations` records `agent.runner` from its own `agents:resolve` call, so the lazy swap covers chat. Runners read the frozen `agentConfig`.
3. The agent editor re-sent `model` on every save; it now sends it only when changed (implementation plan, Task 15).
4. Only `presets/k8s` loads `@ax/agents`; `presets/memory` and the CLI do not and need no change.
5. The `aisdk` runner runs both providers that exist (`anthropic`, `openrouter`), so no catalog provider is unusable.
6. Tab icon `Layers`, placed right after "AI model keys".
```

- [x] **Step 3: The real-browser walk on the local kind cluster**

The host-side TypeScript changed, so use the **image-rebuild loop** of the `k8s-acceptance-loop` skill against `ax-next-dev` (`make image`, then `make rollout`; every kind target is pinned to `kind-ax-next-dev` by `kube-guard`, but name `--context kind-ax-next-dev` yourself on any ad-hoc `kubectl`/`helm`). **Never** run any of this against the GKE context. Invoke the `k8s-acceptance-loop` skill and drive the chat UI with Playwright through this checklist, at widths **1280** and **390**, in **light and dark**:

1. **Admin only.** As the admin the sidebar shows "Models" right after "AI model keys". As a non-admin there is no such tab, and `curl` of `/admin/models/policy` with that user's cookie returns 403.
2. **Before any save.** The info notice "You're using the built-in list…" shows; the right pane lists the built-in models with Claude Sonnet as the Default.
3. **Catalog states.** Anthropic without a stored key shows "Add an API key to see Anthropic's models." and its link opens "AI model keys". OpenRouter shows its full list (hundreds) if the cluster has outbound access; otherwise the plain "We couldn't reach OpenRouter just now…" message with a working "Try again".
4. **Search.** Type one letter at a time into "Search models": the count line updates on every keystroke with no delay; multi-word queries narrow; clearing restores; a nonsense query shows "No models match …".
5. **Select.** Tick models, use "Select all N shown" during a search, move the Default, remove the Default (the first remaining model takes over), Cancel restores the saved list, Save is disabled with nothing selected.
6. **Save and use.** Save; "Models saved" appears. Reload the page: the saved list is back. Open Agents → New agent: the model picker offers exactly the saved models and pre-selects the Default.
7. **Moving agents.** Create an agent on model X. In Models, remove X and Save: the dialog says "Move 1 agent to …?" with "X: 1 agent"; "Go back" saves nothing; "Save and move them" saves. Open that agent: the notice "Your admin changed the available models, so this agent is using … now…" shows, and saving an unrelated edit (rename) leaves the stored model alone (confirm with `GET /admin/agents/<id>` still showing `requestedModel`).
8. **Coming back.** Add X back and Save: the agent's notice disappears and it is on X again.
9. **Two tabs.** Open Models in two browser tabs, save in one, then save in the other: the second shows "Someone else just changed this list. Reload to see their version." and Reload brings in the first tab's list.
10. **A chat on a moved agent.** Start a chat with the moved agent: the host log shows the turn using the Default's provider (`kubectl --context kind-ax-next-dev -n ax-next logs deploy/ax-next-host | grep -i model`), and the request succeeds or fails only for provider-credential reasons, never "claude-sdk … non-Anthropic".

Save screenshots of steps 2, 4, 5, 7 at both widths. Fix any defect at its cause in the owning task's files, add the test that would have caught it (repo Bug Fix Policy), and re-run that task's test command.

- [x] **Step 4: Memory shards (these files are tracked; write shards, never the root archives)**

Set `TASK_ID` to the id of the board card this ships under (format `TASK-<number>`; `memory-write-target.sh` rejects anything else, and the id is assigned by the board, so ask the repo owner if you were not given one):

```bash
: "${TASK_ID:?set TASK_ID to the board card id first, for example TASK_ID=TASK-123}"
path=$(scripts/memory-write-target.sh --shard decisions "$TASK_ID")
mkdir -p "$(dirname "$path")"
cat >> "$path" <<'EOF'
- 2026-09-30 (admin-selectable models): new plugin `@ax/model-policy` owns the allowed-model policy (`settings:model-policy`) and the live provider catalog; `@ax/agents` consumes it through the soft hook `models:get-policy`. Why a plugin and not a settings key: one owner for the concept (invariant 4), and the catalog is not an agents concern. Agents on a removed model are swapped to the admin's Default LAZILY inside `agents:resolve` (never written back), so re-adding a model restores them and a save is one small write. The runner is derived from the model (`anthropic/*` → `claude-sdk`, else `aisdk`) because `claude-sdk` throws on any non-Anthropic ref.
EOF
path=$(scripts/memory-write-target.sh --shard patterns "$TASK_ID")
mkdir -p "$(dirname "$path")"
cat >> "$path" <<'EOF'
- 2026-09-30: (1) `agents:resolve` has a `returns` zod schema that STRIPS undeclared keys — any new field on the resolved agent (here `requestedModel`) must be added to `AgentSchema` or it silently vanishes before the orchestrator sees it. (2) `storage:set` has no compare-and-swap; a versioned write is only atomic inside one process (promise chain) — fine because the host is single-replica. (3) A record the server swaps for display (the moved agent) must never be PATCHed back: the client sends `model` only when the user changed it. (4) `@ax/core` exports `PROVIDER_ENDPOINTS`; iterate it for "all providers" and gate each on `bus.hasService('…:<id>')` instead of configuring a list.
EOF
```

Commit them with the work: `git add .claude/memory && git commit -m "docs(memory): record the model-policy decisions and patterns"` (end the message with the standard `Co-Authored-By` line).

- [x] **Step 5: Commit the spec update and prepare the PR text**

```bash
git add docs/plans/2026-09-30-model-policy-design.md
git commit -m "docs: reconcile the model-policy design with what planning found

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

CLAUDE.md requires the boundary review and the security note in the PR description. Use this text (it is the final state of the work):

```markdown
## Boundary review (new hooks)
- **`models:get-policy`** — Alternate impl: a policy read from a remote policy service or a per-team table. Payload field names that might leak: none (`provider/model-id` refs are provider-agnostic). Subscriber risk: none — it is a service with a single soft consumer (`@ax/agents`), not a subscriber hook. Wire surface: not an IPC action; the admin HTTP routes live in `packages/model-policy`.
- **`models:list-available:<provider>`** — Alternate impl: any further provider plugin (for example an OpenAI one). Fields `ref`, `label`, `status` are backend-neutral. Per-provider name because `registerService` is single-owner (same as `llm:call:<provider>` and `models:list-supported:<provider>`). Soft dependency (`bus.hasService`), so a preset without a provider plugin simply omits it.

## Security review
- Sandbox: the host gains two outbound HTTPS calls to fixed provider model-list URLs (hosts it already calls for `llm:call`); no caller-supplied URL or path, no filesystem paths, keys come from the existing credential resolution and are never returned or logged; new routes are admin-gated server-side (401/403) and CSRF-headed; the impact route returns counts only.
- Injection: provider responses are untrusted — refs must match a strict allow-list pattern, start with the provider id and pass `isModelRef`; labels are stripped of control/bidirectional/invisible characters and capped; size (5 MiB), count (2000) and time (8–10 s) limits; model refs reach no shell, path, SQL or prompt (only the provider call's `model` parameter, as before); labels render as plain text.
- Supply chain: N/A — no dependency was added or changed (a workspace link and lockfile importer block only; `pnpm audit --audit-level moderate` is unaffected).
```

Open the PR only when asked. Do not deploy: shipping to production is a separate step that needs explicit approval.

---

## Spec coverage map (for the reviewer)

| Spec section | Implemented by |
|--------------|----------------|
| §4.1 policy store, `models:get-policy`, built-in policy, validation, corrupt fallback, in-process versioning | Task 1 |
| §4.2 catalog aggregation, limits, sanitising, statuses | Task 2 |
| §4.2 provider hooks (OpenRouter, Anthropic) | Tasks 4, 5 |
| §4.3 admin routes | Task 3 |
| §4.4 (1)(2) policy source + `defaultModel` | Task 7 |
| §4.4 (3) runner rule | Task 6 |
| §4.4 (4) lazy swap + `requestedModel` + never persisted | Tasks 8, 15 |
| §4.4 (5) impact route | Task 9 |
| §4.5 wiring | Task 10 |
| §5 UI (tab, panes, states, save flow, dialog) | Tasks 11–14 |
| §5 agent editor (Default, notice, changed-only `model`) | Task 15 |
| §6 edge cases (409, unreadable policy, plugin absent, no-key badge, refresh rate limit) | Tasks 1, 2, 3, 7, 12, 13 |
| §7 security review | Tasks 2, 4, 5; text in Task 16 |
| §8 testing, §9 rollout | every task's tests; Task 16 |
