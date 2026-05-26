# JIT Broker Tool + `skills:search-catalog` Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the model-brokered surfacing spine — a new always-on host tool (`search_catalog` + `request_capability`) the agent calls to match a user's intent against the capability catalog, plus the read-only `skills:search-catalog` service hook that backs it.

**Architecture:** The broker is a thin new plugin, `@ax/skill-broker`, built on the **existing host-tool mechanism** (`tool:register` + `tool:execute:${name}`, the same surface `@ax/web-tools` uses for `web_search`/`web_extract` — *not* an MCP server; `web_search`'s backend is Anthropic cloud, but its *registration/surfacing* is the generic host-tool path). It registers two `executesIn: 'host'` tools that round-trip through the **already-shipped** `tool.execute-host` IPC action — so **no new IPC action is added**. `search_catalog` forwards to a new `skills:search-catalog` service hook (registered by `@ax/skills`, the catalog owner) that keyword-matches the global catalog and returns `{ id, description, tier, hosts, slots }` candidate summaries. `request_capability` validates a skill id against the catalog and returns a structured ack — the pause→card→install wiring it ultimately drives lands in TASK-35/36. A skill's **tier** (`inert`/`bounded`/`registry`) is **derived** from its declared capabilities (per design §3's fault line), not a stored column.

**Tech Stack:** TypeScript, pnpm workspace, tsconfig project refs, kysely + Postgres (testcontainers in the canary), zod (`returns`-schema validation), vitest.

---

## Scope guardrails

- **One new service hook: `skills:search-catalog`** (in `@ax/skills`). Boundary-review note (confirming design §11.1): *Alternate impl* — keyword/substring match today, vector/embedding search tomorrow; the payload is impl-agnostic. *Payload fields* — in `{ intent, limit? }`, out `{ skills: [{ id, description, tier, hosts, slots }] }`; `tier` is an enum, `hosts` are hostnames already public in manifests, `slots` are slot names — **no** `sha`/`pod`/`socket`/`bucket`/`generation`/row vocabulary. *Subscriber risk* — none; it is a service hook (single impl), read-only. *Wire surface* — **no new IPC action**: the hook is in-process (called only by the broker host-side); the agent reaches the broker through the existing `tool.execute-host` IPC action, whose schema already lives in `@ax/ipc-protocol`. `request_capability` introduces **no** hook of its own this phase, so it needs no boundary review.
- **No cross-plugin imports (invariant I2).** `@ax/skill-broker`'s only `@ax/*` import is `@ax/core` (kernel). It mirrors the catalog-candidate shape **locally** (it never imports `@ax/skills` types) and reaches the catalog purely through the hook bus (`skills:search-catalog`, `skills:get`, `tool:register`). Trust is re-validated at the broker boundary (it re-checks the `skillId` shape itself before calling `skills:get`).
- **One source of truth (invariant I4).** Tier derivation lives **only** in `@ax/skills` (`classifyTier`), exposed through `skills:search-catalog`. The broker does not classify; it forwards. The catalog itself stays owned by `@ax/skills`.
- **Capabilities minimized (invariant I5).** The broker grants the model exactly one new reach: a **read** of the catalog. `request_capability` returns the minimum (`status` + `skillId`) — it deliberately does **not** echo hosts/keys back to the model (the approval card, TASK-35, is the surface for that; §7 wants the agent to not narrate the handoff).
- **Security-checklist applies** (always-on host tool consuming untrusted model-supplied intent text) — it is a **pre-PR gate** (Task 7 Step 4). Pre-stated threat model in the [Security threat model](#security-threat-model-pre-stated) section below.
- **Half-wired window (stated):** see [Half-wired window](#half-wired-window) below — `request_capability`'s downstream and the broker's production "always-on" surfacing.

## Dependency status & as-built re-verification (READ FIRST)

This card depends on **TASK-33** (per-user attach layer) which depends on **TASK-32** (bundle model). yolo-ship only pulls this card once **TASK-33 is Done**, so by execution time TASK-32 + TASK-33 are merged to `main`. This plan was written against design §4/§6A/§10/§11 + the committed TASK-32/33 impl plans + the **pre-32/33** as-built code. Before Task 1, **re-confirm against `main`** (hard requirement #1 — do not trust file:line anchors) and adjust if any of these moved:

- [ ] **`tier` is still derived, not stored.** Confirm TASK-32 did **not** add a `tier` field to `SkillSummary`/`SkillCapabilities`/the catalog row. If it **did**, delete `classifyTier` (Task 1) and read the stored field instead — one source of truth (I4). (As of writing: no `tier` field exists.)
- [ ] **`SkillCapabilities` shape unchanged** — `{ allowedHosts: string[], credentials: CapabilitySlot[], mcpServers: McpServerSpec[], packages: { npm: string[], pypi: string[] } }` (`packages/skills-parser/src/capabilities.ts`). `classifyTier` keys off all four.
- [ ] **`SkillSummary` still carries `capabilities` + `description` + `id`** (`packages/skills/src/types.ts`) and **`store.list()`** still returns `SkillSummary[]` for the global catalog (`packages/skills/src/store.ts`).
- [ ] **`skills:get` still exists**, throws `PluginError` code `skill-not-found` on a missing id, and accepts `{ skillId, scope: 'global' }` (`packages/skills/src/plugin.ts`).
- [ ] **`skills:search-catalog` still does not exist** (TASK-32/33 didn't add it).
- [ ] **Host-tool mechanism unchanged**: `ToolDescriptor = { name, description?, inputSchema: Record<string,unknown>, executesIn: 'sandbox'|'host' }` (`packages/core/src/types.ts`); `tool:register` registered by `@ax/tool-dispatcher` (`packages/mcp-client/src/tool-dispatcher-plugin.ts`); host tools dispatched via `tool.execute-host`, handler at `packages/ipc-core/src/handlers/tool-execute-host.ts` calls `bus.call('tool:execute:${name}', ctx, call)` and wraps the return as `{ output }`.
- [ ] **`@ax/web-tools` is still wired in `presets/k8s/src/index.ts`** alongside `@ax/skills` + the tool-dispatcher — the broker rides the same preset (Task 6).
- [ ] **`preset.test.ts`** still statically asserts "every `calls` is satisfied by some `registers`" (`presets/k8s/src/__tests__/preset.test.ts`) — this is the invariant-#3 reachability guard the broker must pass.

> **Implementation forks resolved (hard requirement #7):**
> 1. **What `request_capability` does this phase** → it **validates the id against the catalog and returns `{ status, skillId }`** (no new hook, no pause). Rationale: the card scopes this phase's only new hook to `skills:search-catalog`; the pending-turn mechanism is owned by TASK-36 and the card by TASK-35 — defining their seam now would be guessing at their payload needs (boundary-review rule: don't promote to a hook before the second consumer exists). TASK-36 evolves this handler from synchronous-ack to pending-yield. This is a **product-neutral sequencing** call, not a human-only decision.
> 2. **Tier is derived, not stored** → keeps one source of truth and avoids a migration/backfill this phase. §3's fault line is "does it download unreviewed registry code" → `packages.{npm,pypi}` non-empty ⇒ `registry`; else any egress/credential ⇒ `bounded`; else `inert`. Known simplification: a *bundled* script that shells out to `pip`/`npx` without declaring `packages` reads as `bounded` here — acceptable, because the admit-time bundle review (a later component) is the real supply-chain gate, and tier is informational for surfacing (the card shows hosts/slots, which are exact).
> 3. **Search is in-memory over `store.list()`, not a SQL `LIKE`** → the catalog is admin-scale (~tens of skills; see the store's own concurrency comment), and filtering in JS means the untrusted `intent` text **never reaches SQL** — closing the injection surface by construction rather than by escaping.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skills/src/catalog-tier.ts` | **new** — pure tier classifier (`classifyTier`) + `SkillTier` type | **create** |
| `packages/skills/src/types.ts` | public hook I/O shapes + `returns` schemas | **add** `skills:search-catalog` types + `SkillsSearchCatalogOutputSchema` |
| `packages/skills/src/plugin.ts` | hook handlers + manifest | **register** `skills:search-catalog`; add it to `registers` |
| `packages/skills/src/__tests__/catalog-tier.test.ts` | **new** classifier unit tests | **create** |
| `packages/skills/src/__tests__/plugin.test.ts` | plugin hooks + manifest | **extend** (manifest equality, search-catalog handler cases) |
| `packages/skills/src/__tests__/return-schemas.test.ts` | `returns`-schema drift guard | **extend** (add the new hook's schema) |
| `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts` | end-to-end canary | **extend** (boot broker + dispatcher; exercise both tools) |
| `packages/skill-broker/package.json` | **new** package manifest | **create** |
| `packages/skill-broker/tsconfig.json` | **new** package tsconfig | **create** |
| `packages/skill-broker/src/index.ts` | **new** package entry | **create** |
| `packages/skill-broker/src/plugin.ts` | **new** — `createSkillBrokerPlugin` + manifest + init | **create** |
| `packages/skill-broker/src/tools/search-catalog.ts` | **new** — `search_catalog` descriptor + execute hook | **create** |
| `packages/skill-broker/src/tools/request-capability.ts` | **new** — `request_capability` descriptor + execute hook | **create** |
| `packages/skill-broker/src/__tests__/plugin.test.ts` | **new** broker unit tests | **create** |
| `tsconfig.json` (repo root) | tsc project refs | **add** `{ "path": "packages/skill-broker" }` |
| `presets/k8s/src/index.ts` | k8s plugin assembly | **add** import + `plugins.push(createSkillBrokerPlugin())` |
| `presets/k8s/package.json` | preset deps | **add** `@ax/skill-broker` |
| `packages/skills/package.json` | skills devDeps (canary only) | **add** `@ax/skill-broker` + `@ax/mcp-client` devDeps |

---

## Shared rule: tier classification (referenced by Tasks 1, 2, 7)

A skill's **tier** is derived from its `SkillCapabilities` (`{ allowedHosts, credentials, mcpServers, packages }`), per design §3:

- **`registry`** — `packages.npm.length > 0 || packages.pypi.length > 0` (declares an unreviewed registry download via `npx`/`uvx`/`pip`). The §3 fault line; checked **first** (registry beats everything).
- **`bounded`** — not registry, but reaches the network through fixed/reviewed means: `mcpServers.length > 0` (http MCP) OR `allowedHosts.length > 0` OR `credentials.length > 0`.
- **`inert`** — none of the above (instruction-only, no egress/credentials/registry).

This rule lives in exactly one place, `packages/skills/src/catalog-tier.ts`, and is exposed only through `skills:search-catalog`.

---

### Task 1: Pure tier classifier in `@ax/skills`

**Files:**
- Create: `packages/skills/src/catalog-tier.ts`
- Test: `packages/skills/src/__tests__/catalog-tier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/skills/src/__tests__/catalog-tier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { SkillCapabilities } from '@ax/skills-parser';
import { classifyTier } from '../catalog-tier.js';

const base: SkillCapabilities = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

describe('classifyTier', () => {
  it('inert when no egress, credentials, or packages', () => {
    expect(classifyTier(base)).toBe('inert');
  });

  it('bounded for an allowlisted host (CLI hitting a SaaS API)', () => {
    expect(classifyTier({ ...base, allowedHosts: ['api.linear.app'] })).toBe('bounded');
  });

  it('bounded for an http MCP server', () => {
    expect(
      classifyTier({
        ...base,
        mcpServers: [
          { name: 'x', transport: 'http', url: 'https://h/mcp', allowedHosts: ['h'], credentials: [] },
        ],
      }),
    ).toBe('bounded');
  });

  it('bounded for a credential slot with no declared packages', () => {
    expect(classifyTier({ ...base, credentials: [{ slot: 'api_key', kind: 'api-key' }] })).toBe('bounded');
  });

  it('registry when npm packages are declared', () => {
    expect(classifyTier({ ...base, packages: { npm: ['some-pkg'], pypi: [] } })).toBe('registry');
  });

  it('registry when pypi packages are declared', () => {
    expect(classifyTier({ ...base, packages: { npm: [], pypi: ['some-pkg'] } })).toBe('registry');
  });

  it('registry wins even when hosts are also declared', () => {
    expect(
      classifyTier({ ...base, allowedHosts: ['h'], packages: { npm: ['p'], pypi: [] } }),
    ).toBe('registry');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-tier.test.ts`
Expected: FAIL — cannot find module `../catalog-tier.js`.

- [ ] **Step 3: Implement the classifier**

Create `packages/skills/src/catalog-tier.ts`:

```typescript
import type { SkillCapabilities } from '@ax/skills-parser';

/**
 * Supply-chain risk tier for a catalog skill (design §3). Derived from a
 * skill's declared capabilities — NOT a stored column — so there is one
 * source of truth and no migration. The fault line is provenance: does the
 * skill download unreviewed code from a public registry?
 *
 *  - 'registry' — declares npm/pypi packages (npx/uvx/pip download at runtime)
 *  - 'bounded'  — fixed/reviewed egress: http MCP, an allowlisted host, or a key
 *  - 'inert'    — instruction-only
 */
export type SkillTier = 'inert' | 'bounded' | 'registry';

export function classifyTier(capabilities: SkillCapabilities): SkillTier {
  const { allowedHosts, credentials, mcpServers, packages } = capabilities;
  if (packages.npm.length > 0 || packages.pypi.length > 0) return 'registry';
  if (mcpServers.length > 0 || allowedHosts.length > 0 || credentials.length > 0) return 'bounded';
  return 'inert';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/skills test -- src/__tests__/catalog-tier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/catalog-tier.ts packages/skills/src/__tests__/catalog-tier.test.ts
git commit -m "feat(skills): derive supply-chain tier from skill capabilities"
```

---

### Task 2: Register the `skills:search-catalog` hook

**Files:**
- Modify: `packages/skills/src/types.ts`, `packages/skills/src/plugin.ts`
- Test: `packages/skills/src/__tests__/plugin.test.ts`, `packages/skills/src/__tests__/return-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/skills/src/__tests__/plugin.test.ts` (mirrors the file's existing `makeHarness()` + `h.bus.call(...)` + `h.ctx()` pattern; the harness boots the real skills plugin against a Postgres testcontainer):

```typescript
it('skills:search-catalog matches intent, derives tier, and returns hosts/slots', async () => {
  const h = await makeHarness();
  // A bounded Linear skill (host + key) and an inert note-taking skill.
  await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: LINEAR_MANIFEST, bodyMd: 'b' });
  await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: INERT_MANIFEST, bodyMd: 'b' });

  const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
    'skills:search-catalog',
    h.ctx(),
    { intent: 'check my linear issues' },
  );

  const linear = out.skills.find((s) => s.id === 'linear');
  expect(linear).toMatchObject({
    id: 'linear',
    tier: 'bounded',
    hosts: ['api.linear.app'],
    slots: ['api_key'],
  });
  // The inert note skill does not match "linear".
  expect(out.skills.some((s) => s.id === 'notes')).toBe(false);
});

it('skills:search-catalog returns [] for blank intent and never errors', async () => {
  const h = await makeHarness();
  const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
    'skills:search-catalog',
    h.ctx(),
    { intent: '   ' },
  );
  expect(out.skills).toEqual([]);
});

it('skills:search-catalog caps results at the requested limit', async () => {
  const h = await makeHarness();
  await h.bus.call('skills:upsert', h.ctx(), { manifestYaml: LINEAR_MANIFEST, bodyMd: 'b' });
  const out = await h.bus.call<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
    'skills:search-catalog',
    h.ctx(),
    { intent: 'linear', limit: 0 },
  );
  // limit clamps to >= 1, so a single match still returns.
  expect(out.skills.length).toBeLessThanOrEqual(1);
});
```

Add these fixtures near the file's existing `SAMPLE_MANIFEST` (the YAML body that `parseSkillManifest` accepts — mirror the existing fixture's shape; `id`, `description`, `version`, and a `capabilities` block):

```typescript
const LINEAR_MANIFEST = [
  'id: linear',
  'description: Read and update your Linear issues',
  'version: 1',
  'capabilities:',
  '  allowedHosts: [api.linear.app]',
  '  credentials:',
  '    - slot: api_key',
  '      kind: api-key',
].join('\n');

const INERT_MANIFEST = [
  'id: notes',
  'description: Help structure meeting notes',
  'version: 1',
].join('\n');
```

Also import the new types at the top of the test file:

```typescript
import type { SkillsSearchCatalogInput, SkillsSearchCatalogOutput } from '../types.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skills test -- src/__tests__/plugin.test.ts`
Expected: FAIL — `no service registered for 'skills:search-catalog'`.

- [ ] **Step 3: Add the hook's I/O types + `returns` schema**

In `packages/skills/src/types.ts`, import the tier type at the top:

```typescript
import type { SkillTier } from './catalog-tier.js';
export type { SkillTier } from './catalog-tier.js';
```

Add the I/O interfaces (next to the other `Skills*Input`/`Output` interfaces):

```typescript
export interface SkillsSearchCatalogInput {
  /** Free-text intent/keywords from the model. UNTRUSTED — never reaches SQL. */
  intent: string;
  /** Max candidates to return. Clamped to [1, 50]; defaults to 10. */
  limit?: number;
}
export interface CatalogCandidate {
  id: string;
  description: string;
  tier: SkillTier;
  /** Hostnames the skill is allowed to reach (already public in the manifest). */
  hosts: string[];
  /** Credential slot names the skill declares. */
  slots: string[];
}
export interface SkillsSearchCatalogOutput {
  skills: CatalogCandidate[];
}
```

Add the `returns` schema (next to the other `*OutputSchema` consts, following the existing `as unknown as ZodType<...>` pattern):

```typescript
const CatalogCandidateSchema = z.object({
  id: z.string(),
  description: z.string(),
  tier: z.union([z.literal('inert'), z.literal('bounded'), z.literal('registry')]),
  hosts: z.array(z.string()),
  slots: z.array(z.string()),
});

export const SkillsSearchCatalogOutputSchema = z.object({
  skills: z.array(CatalogCandidateSchema),
}) as unknown as ZodType<SkillsSearchCatalogOutput>;
```

- [ ] **Step 4: Register the handler + add to the manifest**

In `packages/skills/src/plugin.ts`, add `'skills:search-catalog'` to the `registers` array, import the new symbols, and register the handler inside `init()` (after the other `bus.registerService(...)` calls). It lists the **global** catalog and filters/scores in memory — the untrusted `intent` never touches SQL:

```typescript
import { classifyTier } from './catalog-tier.js';
import {
  // ...existing imports...
  type SkillsSearchCatalogInput,
  type SkillsSearchCatalogOutput,
  SkillsSearchCatalogOutputSchema,
} from './types.js';

// add to manifest.registers (after 'skills:check-for-updates'):
//   'skills:search-catalog',

bus.registerService<SkillsSearchCatalogInput, SkillsSearchCatalogOutput>(
  'skills:search-catalog',
  PLUGIN_NAME,
  async (_ctx, input) => {
    const intent = typeof input.intent === 'string' ? input.intent.trim().toLowerCase() : '';
    const rawLimit = typeof input.limit === 'number' ? Math.floor(input.limit) : 10;
    const limit = Math.max(1, Math.min(50, rawLimit));
    if (intent.length === 0) return { skills: [] };

    const tokens = intent.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return { skills: [] };

    const catalog = await store.list(); // global catalog: SkillSummary[]
    const scored = catalog
      .map((s) => {
        const hay = `${s.id} ${s.description}`.toLowerCase();
        const score = tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
        return { s, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.id.localeCompare(b.s.id))
      .slice(0, limit);

    return {
      skills: scored.map(({ s }) => ({
        id: s.id,
        description: s.description,
        tier: classifyTier(s.capabilities),
        hosts: s.capabilities.allowedHosts,
        slots: s.capabilities.credentials.map((c) => c.slot),
      })),
    };
  },
  { returns: SkillsSearchCatalogOutputSchema },
);
```

- [ ] **Step 5: Extend the `returns`-schema drift guard**

In `packages/skills/src/__tests__/return-schemas.test.ts`, add `SkillsSearchCatalogOutputSchema` to the set the test checks (mirror how the file already asserts each `*OutputSchema` parses a representative value and matches its interface):

```typescript
it('SkillsSearchCatalogOutputSchema accepts a well-formed candidate list', () => {
  const ok = SkillsSearchCatalogOutputSchema.safeParse({
    skills: [{ id: 'linear', description: 'd', tier: 'bounded', hosts: ['api.linear.app'], slots: ['api_key'] }],
  });
  expect(ok.success).toBe(true);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @ax/skills test`
Expected: PASS (whole package green, including the manifest-equality test in `plugin.test.ts` — update its expected `registers` array to include `'skills:search-catalog'` if that test asserts the exact list).

- [ ] **Step 7: Commit**

```bash
git add packages/skills/src/types.ts packages/skills/src/plugin.ts \
  packages/skills/src/__tests__/plugin.test.ts packages/skills/src/__tests__/return-schemas.test.ts
git commit -m "feat(skills): add read-only skills:search-catalog hook (intent -> catalog candidates)"
```

---

### Task 3: Scaffold `@ax/skill-broker` + the `search_catalog` tool

**Files:**
- Create: `packages/skill-broker/package.json`, `packages/skill-broker/tsconfig.json`, `packages/skill-broker/src/index.ts`, `packages/skill-broker/src/plugin.ts`, `packages/skill-broker/src/tools/search-catalog.ts`
- Modify: `tsconfig.json` (repo root)
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/skill-broker/src/__tests__/plugin.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HookBus, makeAgentContext } from '@ax/core';
import { createSkillBrokerPlugin } from '../plugin.js';

const ctx = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });

function busWithStubs() {
  const bus = new HookBus();
  const registered: string[] = [];
  bus.registerService('tool:register', 'disp', async (_c, d: unknown) => {
    registered.push((d as { name: string }).name);
    return { ok: true };
  });
  bus.registerService('skills:search-catalog', 'skills', async (_c, input: unknown) => {
    const intent = ((input as { intent?: string }).intent ?? '').trim();
    return {
      skills: intent
        ? [{ id: 'linear', description: 'Linear', tier: 'bounded', hosts: ['api.linear.app'], slots: ['api_key'] }]
        : [],
    };
  });
  return { bus, registered };
}

describe('createSkillBrokerPlugin — search_catalog', () => {
  it('manifest declares the execute hook + its calls', () => {
    const p = createSkillBrokerPlugin();
    expect(p.manifest.name).toBe('@ax/skill-broker');
    expect(p.manifest.registers).toContain('tool:execute:search_catalog');
    expect(p.manifest.calls).toEqual(
      expect.arrayContaining(['tool:register', 'skills:search-catalog', 'skills:get']),
    );
  });

  it('registers the search_catalog descriptor on init', async () => {
    const { bus, registered } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    expect(registered).toContain('search_catalog');
  });

  it('search_catalog forwards intent to skills:search-catalog and returns candidates', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:search_catalog', ctx, {
      name: 'search_catalog',
      input: { intent: 'linear issues' },
    });
    expect((out as { skills: Array<{ id: string }> }).skills[0]?.id).toBe('linear');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — package/module not found (it doesn't exist yet).

- [ ] **Step 3: Create the package manifest + tsconfig**

Create `packages/skill-broker/package.json` (mirrors `@ax/web-tools`, minus the Anthropic dep — the broker has no third-party deps):

```json
{
  "name": "@ax/skill-broker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

Create `packages/skill-broker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**", "dist", "node_modules"],
  "references": [
    { "path": "../core" }
  ]
}
```

Add the package to the repo-root `tsconfig.json` `references` array (keep it alphabetically near the others):

```json
    { "path": "packages/skill-broker" },
```

- [ ] **Step 4: Create the `search_catalog` tool**

Create `packages/skill-broker/src/tools/search-catalog.ts`. It mirrors `@ax/web-tools`'s `registerWebSearch` exactly (register the descriptor, then a `tool:execute:${name}` service hook). It mirrors the candidate shape **locally** — no `@ax/skills` import (invariant I2):

```typescript
import { makeAgentContext, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';

export const SEARCH_CATALOG_DESCRIPTOR: ToolDescriptor = {
  name: 'search_catalog',
  description:
    'Search the capability catalog for skills that match what you are trying to do ' +
    '(e.g. "read my Linear issues"). Returns candidate skills, the hosts each reaches, ' +
    'and any credential slots it needs. Call this before request_capability.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'What you are trying to accomplish, in plain language.',
      },
    },
    required: ['intent'],
  },
};

// Mirrors @ax/skills' CatalogCandidate shape locally — the broker forwards the
// hook's result verbatim and must not import across the plugin boundary (I2).
interface CatalogCandidate {
  id: string;
  description: string;
  tier: string;
  hosts: string[];
  slots: string[];
}
interface SearchCatalogResult {
  skills: CatalogCandidate[];
}

export async function registerSearchCatalog(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, SEARCH_CATALOG_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, SearchCatalogResult>(
    'tool:execute:search_catalog',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { intent?: unknown };
      const intent = typeof input.intent === 'string' ? input.intent : '';
      // The catalog owner does the matching + tier derivation (one source of truth).
      return bus.call<{ intent: string }, SearchCatalogResult>(
        'skills:search-catalog',
        toolCtx,
        { intent },
      );
    },
    { timeoutMs: 30_000 },
  );
}
```

- [ ] **Step 5: Create the plugin + entry point**

Create `packages/skill-broker/src/plugin.ts`:

```typescript
import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';

const PLUGIN_NAME = '@ax/skill-broker';
const PLUGIN_VERSION = '0.0.0';

/**
 * @ax/skill-broker — the model-brokered surfacing spine (JIT, design §6A,
 * §11 component #1). Registers always-on host tools the agent calls to match
 * intent against the capability catalog. Built on the generic host-tool
 * surface (tool:register + tool:execute:${name}), like @ax/web-tools — NOT an
 * MCP server.
 */
export function createSkillBrokerPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['tool:execute:search_catalog', 'tool:execute:request_capability'],
      // Hard deps → init-ordering edges: the dispatcher (tool:register) and the
      // catalog owner (skills:search-catalog / skills:get) must init first.
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      const { registerRequestCapability } = await import('./tools/request-capability.js');
      await registerRequestCapability(bus);
    },
  };
}
```

> Note: the dynamic `import('./tools/request-capability.js')` is only to keep this task self-contained (the module lands in Task 4). When Task 4 is done, convert it to a static top-of-file import: `import { registerRequestCapability } from './tools/request-capability.js';`. **Until Task 4 lands, temporarily stub it** so this task builds and tests green — register a no-op `tool:execute:request_capability` inline, OR (cleaner) drop `'tool:execute:request_capability'` from `registers` and the dynamic import for this commit and re-add both in Task 4. Pick the drop-and-re-add path; the Task 3 test only asserts `registers` *contains* `tool:execute:search_catalog`.

Create `packages/skill-broker/src/index.ts`:

```typescript
export { createSkillBrokerPlugin } from './plugin.js';
export { SEARCH_CATALOG_DESCRIPTOR } from './tools/search-catalog.js';
```

- [ ] **Step 6: Install the new workspace package, then run the test**

Run:
```bash
pnpm install
pnpm -F @ax/skill-broker test
```
Expected: PASS. (`pnpm install` links the new `@ax/skill-broker` workspace package so the `-F` filter resolves it.)

- [ ] **Step 7: Commit**

```bash
git add packages/skill-broker tsconfig.json pnpm-lock.yaml
git commit -m "feat(skill-broker): new plugin + search_catalog host tool over skills:search-catalog"
```

---

### Task 4: Add the `request_capability` tool

**Files:**
- Create: `packages/skill-broker/src/tools/request-capability.ts`
- Modify: `packages/skill-broker/src/plugin.ts`, `packages/skill-broker/src/index.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the `busWithStubs()` helper in `packages/skill-broker/src/__tests__/plugin.test.ts` to also stub `skills:get` (it throws `skill-not-found` for unknown ids, mirroring the real handler):

```typescript
import { PluginError } from '@ax/core';
// inside busWithStubs(), after the skills:search-catalog stub:
bus.registerService('skills:get', 'skills', async (_c, input: unknown) => {
  const skillId = (input as { skillId: string }).skillId;
  if (skillId === 'linear') {
    return { id: 'linear', description: 'Linear', version: 1 } as never;
  }
  throw new PluginError({ code: 'skill-not-found', plugin: 'skills', message: 'nope' });
});
```

Add a new describe block:

```typescript
describe('createSkillBrokerPlugin — request_capability', () => {
  it('registers the request_capability descriptor on init', async () => {
    const { bus, registered } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    expect(registered).toContain('request_capability');
  });

  it('returns { status: "requested" } for a real catalog skill', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'linear' },
    });
    expect(out).toEqual({ status: 'requested', skillId: 'linear' });
  });

  it('returns { status: "not-found" } for an unknown skill', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    const out = await bus.call('tool:execute:request_capability', ctx, {
      name: 'request_capability',
      input: { skillId: 'ghost' },
    });
    expect(out).toEqual({ status: 'not-found', skillId: 'ghost' });
  });

  it('rejects a malformed skillId before touching the catalog', async () => {
    const { bus } = busWithStubs();
    await createSkillBrokerPlugin().init({ bus, config: {} as never });
    await expect(
      bus.call('tool:execute:request_capability', ctx, {
        name: 'request_capability',
        input: { skillId: '../evil' },
      }),
    ).rejects.toThrow(/valid catalog/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — `tool:execute:request_capability` not registered (Task 3 dropped it).

- [ ] **Step 3: Create the `request_capability` tool**

Create `packages/skill-broker/src/tools/request-capability.ts`:

```typescript
import { makeAgentContext, PluginError, type HookBus, type ToolDescriptor } from '@ax/core';

const PLUGIN_NAME = '@ax/skill-broker';
// Re-validated independently at this trust boundary (I2/I5) — the broker never
// trusts the model's skillId shape before handing it to skills:get.
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const REQUEST_CAPABILITY_DESCRIPTOR: ToolDescriptor = {
  name: 'request_capability',
  description:
    'Request that a catalog skill be connected for the user. Pass a skill id from ' +
    'search_catalog results. The user will be asked to approve the hosts it reaches and ' +
    'enter any required keys. Do not narrate this step or restate any keys — the approval ' +
    'surface handles it.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The catalog skill id to request, taken from search_catalog results.',
      },
    },
    required: ['skillId'],
  },
};

interface RequestCapabilityResult {
  status: 'requested' | 'not-found';
  skillId: string;
}

export async function registerRequestCapability(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({ sessionId: 'init', agentId: PLUGIN_NAME, userId: 'system' });
  await bus.call('tool:register', initCtx, REQUEST_CAPABILITY_DESCRIPTOR);

  bus.registerService<{ input?: unknown }, RequestCapabilityResult>(
    'tool:execute:request_capability',
    PLUGIN_NAME,
    async (toolCtx, call) => {
      const input = (call?.input ?? {}) as { skillId?: unknown };
      const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : '';
      if (skillId.length === 0 || !SKILL_ID_RE.test(skillId)) {
        throw new PluginError({
          code: 'invalid-payload',
          plugin: PLUGIN_NAME,
          hookName: 'tool:execute:request_capability',
          message: 'request_capability requires a valid catalog "skillId"',
        });
      }

      // Validate the id resolves in the GLOBAL catalog. skills:get throws
      // skill-not-found when absent — translate to a structured result the
      // model can act on rather than surfacing a tool error.
      try {
        await bus.call('skills:get', toolCtx, { skillId, scope: 'global' });
      } catch (err) {
        if (err instanceof PluginError && err.code === 'skill-not-found') {
          return { status: 'not-found', skillId };
        }
        throw err;
      }

      // HALF-WIRED (TASK-34): the catalog skill exists. Nothing yet consumes
      // this to surface an approval card (TASK-35) or to pause -> re-spawn ->
      // resume and install via the per-user attach layer (TASK-36, using
      // TASK-33's skills:attach-for-user). We return a structured ack only.
      return { status: 'requested', skillId };
    },
    { timeoutMs: 30_000 },
  );
}
```

- [ ] **Step 4: Wire it into the plugin + export the descriptor**

In `packages/skill-broker/src/plugin.ts`: replace the dynamic import with a static one, and ensure `'tool:execute:request_capability'` is in `registers` (re-add if Task 3 dropped it):

```typescript
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';
// ...
    registers: ['tool:execute:search_catalog', 'tool:execute:request_capability'],
// ...
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
    },
```

In `packages/skill-broker/src/index.ts`, add:

```typescript
export { REQUEST_CAPABILITY_DESCRIPTOR } from './tools/request-capability.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: PASS (whole broker package green).

- [ ] **Step 6: Commit**

```bash
git add packages/skill-broker/src
git commit -m "feat(skill-broker): request_capability host tool (validate catalog id, structured ack)"
```

---

### Task 5: Wire the broker into the k8s preset (invariant #3)

**Files:**
- Modify: `presets/k8s/src/index.ts`, `presets/k8s/package.json`
- Test: `presets/k8s/src/__tests__/preset.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `presets/k8s/src/__tests__/preset.test.ts` (it already builds the preset's plugin list — reuse that; the file boots the assembled plugins statically, no `init()`):

```typescript
it('includes @ax/skill-broker and its calls are satisfied', () => {
  const names = plugins.map((p) => p.manifest.name);
  expect(names).toContain('@ax/skill-broker');

  const broker = plugins.find((p) => p.manifest.name === '@ax/skill-broker')!;
  const allRegisters = new Set(plugins.flatMap((p) => p.manifest.registers));
  for (const dep of broker.manifest.calls) {
    expect(allRegisters.has(dep)).toBe(true); // tool:register, skills:search-catalog, skills:get
  }
});
```

(If `plugins` is built inside a `beforeAll`/helper in that file, follow the existing pattern — the other tests in the file already iterate `plugins`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: FAIL — `@ax/skill-broker` not in the plugin list. (Use the preset package's real name from `presets/k8s/package.json` `name` field for the `-F` filter.)

- [ ] **Step 3: Add the dependency + wire the plugin**

In `presets/k8s/package.json`, add to `dependencies` (alphabetical with the other `@ax/*`):

```json
    "@ax/skill-broker": "workspace:*",
```

In `presets/k8s/src/index.ts`, add the import near the other `@ax/*` tool/skill imports:

```typescript
import { createSkillBrokerPlugin } from '@ax/skill-broker';
```

And push it **unconditionally** (it needs no API key — unlike `@ax/web-tools`), right after the skills plugin push (`plugins.push(createSkillsPlugin());`), so it sits alongside its deps:

```typescript
  // @ax/skill-broker — always-on host tools (search_catalog + request_capability)
  // that surface catalog skills to the agent (JIT spine, design §6A/§11 #1).
  // Hard-depends on the tool-dispatcher (tool:register) + @ax/skills
  // (skills:search-catalog / skills:get); both are loaded above. No API key.
  plugins.push(createSkillBrokerPlugin());
```

- [ ] **Step 4: Install + run the preset test**

Run:
```bash
pnpm install
pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts
```
Expected: PASS (the broker is in the list; all three `calls` are satisfied by the dispatcher + skills).

- [ ] **Step 5: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/package.json pnpm-lock.yaml \
  presets/k8s/src/__tests__/preset.test.ts
git commit -m "feat(preset-k8s): wire @ax/skill-broker alongside skills + tool-dispatcher"
```

---

### Task 6: End-to-end reachability in the skills canary

**Files:**
- Modify: `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`, `packages/skills/package.json`
- (Reachable from THE canary acceptance test — closes invariant #3 end-to-end.)

- [ ] **Step 1: Add the broker + dispatcher as canary devDeps**

In `packages/skills/package.json`, add to `devDependencies` (the canary already imports `@ax/agents` + `@ax/chat-orchestrator` the same way — the cross-plugin eslint guard is exempt under `**/__tests__/`):

```json
    "@ax/skill-broker": "workspace:*",
    "@ax/mcp-client": "workspace:*",
```

- [ ] **Step 2: Extend the canary**

In `skill-install.canary.test.ts`, add `createToolDispatcherPlugin` (from `@ax/mcp-client`) and `createSkillBrokerPlugin` (from `@ax/skill-broker`) to the booted plugin set, then add a focused case that walks the **real** model→tool→hook path over the real Postgres-backed `@ax/skills`:

```typescript
import { createToolDispatcherPlugin } from '@ax/mcp-client';
import { createSkillBrokerPlugin } from '@ax/skill-broker';

it('broker search_catalog + request_capability reach the real catalog', async () => {
  // upsert a bounded Linear skill into the global catalog (reuse the file's
  // existing upsert helper / sample-manifest pattern; give it allowedHosts +
  // an api_key credential slot so tier derives to "bounded").
  await upsertGlobalSkill({ id: 'linear', allowedHosts: ['api.linear.app'], slots: ['api_key'] });

  const search = await bus.call('tool:execute:search_catalog', ctx, {
    name: 'search_catalog',
    input: { intent: 'check my linear issues' },
  });
  const hit = (search as { skills: Array<{ id: string; tier: string; hosts: string[] }> }).skills
    .find((s) => s.id === 'linear');
  expect(hit?.tier).toBe('bounded');
  expect(hit?.hosts).toContain('api.linear.app');

  const ok = await bus.call('tool:execute:request_capability', ctx, {
    name: 'request_capability',
    input: { skillId: 'linear' },
  });
  expect(ok).toEqual({ status: 'requested', skillId: 'linear' });

  const miss = await bus.call('tool:execute:request_capability', ctx, {
    name: 'request_capability',
    input: { skillId: 'does-not-exist' },
  });
  expect(miss).toEqual({ status: 'not-found', skillId: 'does-not-exist' });
});
```

Wire `createToolDispatcherPlugin()` + `createSkillBrokerPlugin()` into the same boot list/harness the file already uses for `@ax/skills` (the broker init-orders after both via its `calls`). Use the file's existing `bus` + `ctx` handles. If the file uses an explicit stub set, the dispatcher + broker register their own hooks and need no new stubs — they only `call` `tool:register` (dispatcher), `skills:search-catalog`, and `skills:get` (real skills), all present. (Adapt `upsertGlobalSkill` to the file's existing upsert mechanism — the goal is one global skill with a host + slot.)

- [ ] **Step 3: Run the canary**

Run: `pnpm -F @ax/skills test -- src/__tests__/e2e/skill-install.canary.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/__tests__/e2e/skill-install.canary.test.ts packages/skills/package.json pnpm-lock.yaml
git commit -m "test(skills): canary exercises broker search_catalog + request_capability end-to-end"
```

---

### Task 7: Full verification + security-checklist + PR

**Files:** none (verification + PR prep)

- [ ] **Step 1: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc project refs) is the gate that catches the new package's missing root-tsconfig ref or an undeclared workspace dep that vitest tolerates; lint catches an accidental cross-plugin import in `@ax/skill-broker` (`no-restricted-imports`). Bug-fix-test policy: any bug found here gets a regression test before the fix is considered done.

- [ ] **Step 2: Run the `security-checklist` skill (pre-PR gate)**

Invoke the `security-checklist` skill and answer all three threat models against the [pre-stated model](#security-threat-model-pre-stated) below. Confirm: the in-memory search keeps untrusted `intent` out of SQL; `skillId` is shape-validated before `skills:get` (which binds it as a parameter); `request_capability` returns the minimum and does not echo hosts/keys to the model; no new dependency was added (`@ax/skill-broker` deps only `@ax/core`). Paste the structured note into the PR.

- [ ] **Step 3: Open the PR**

PR description MUST include:

- **Boundary review** (new hook `skills:search-catalog`): *Alternate impl* — keyword today, vector tomorrow (impl-agnostic payload). *Fields* — `{ intent, limit }` / `{ skills: [{ id, description, tier, hosts, slots }] }`, no backend vocabulary, no leak. *Subscriber risk* — none (read-only service hook). *Wire surface* — no new IPC action; the broker reaches the host via the existing `tool.execute-host` action.
- **Half-wired window OPEN** (see below): (a) `request_capability` returns a structured ack — the approval card (TASK-35) and pause→re-spawn→resume+install (TASK-36) that consume it are not built; (b) the broker is registered + reachable (preset + canary + dev-wildcard `allowedTools`), but locking it into every multi-tenant agent's `allowedTools` as a smart default is the smart-defaults layer (design Part II P4). Both windows CLOSE in the named later tasks.
- The `security-checklist` structured note.

- [ ] **Step 4: Commit (if any verification fixes landed)**

```bash
git add -A
git commit -m "chore(skill-broker): verification fixes from build/test/lint + security-checklist"
```

---

## Security threat model (pre-stated)

The `security-checklist` skill is a **pre-PR gate** (Task 7 Step 2). Starting model:

- **Sandbox / capability leakage.** The broker adds **no** filesystem, process-spawn, env, or socket reach. Its two tools are `executesIn: 'host'` and round-trip through the **existing** `tool.execute-host` IPC action (no new wire surface). The only new capability the model gains is a **read** of the catalog (`skills:search-catalog` → `store.list()`; `skills:get`). No caller-provided path, argv, or env name is involved. `skillId` is validated against `SKILL_ID_RE` at the broker boundary before it reaches `skills:get` (defense-in-depth; `skills:get` also binds it as a query parameter).
- **Prompt injection / untrusted content (the flagged threat).** Both tool args originate from the **model** (untrusted). `intent` → `skills:search-catalog`, where it is matched **in memory** over `store.list()` — it **never reaches SQL**, a shell, a path, or another LLM prompt as instruction, so `intent = "'; DROP TABLE skills; --"` is just a no-match string. `skillId` → shape-validated, then bound as a parameter by `skills:get`. The search **results** (`description`/`hosts`/`slots`) come from admin-vetted catalog skills and flow back to the model as tool output (the runner tags tool output downstream); the user is the ultimate backstop at the approval card (TASK-35). `request_capability` deliberately returns the minimum (`status` + `skillId`), not hosts/keys, so the model has nothing sensitive to exfiltrate or be steered into narrating.
- **Supply chain.** `@ax/skill-broker` adds **no** third-party dependency — its only runtime dep is `@ax/core` (workspace), devDeps are the standard `typescript`/`vitest`/`@types/node` already pinned across the monorepo. No `package.json` outside the workspace gains an external entry; no install-time scripts. (Confirm the `pnpm-lock.yaml` diff shows no new registry packages.)

## Half-wired window

Stated explicitly per hard requirement #5:

1. **`request_capability` downstream is open.** This phase: validate the id against the catalog and return `{ status, skillId }`. **No production code yet** (a) surfaces an approval card — **TASK-35** (`chat:permission-request` SSE frame), or (b) pauses the brokering turn → re-spawns → resumes and installs the skill via the per-user attach layer — **TASK-36** (which calls TASK-33's `skills:attach-for-user`). TASK-36 will evolve this handler from synchronous-ack to pending-yield. **CLOSES across TASK-35 + TASK-36.**
2. **Production "always-on" surfacing is partial.** The broker tools are registered in the catalog and **reachable** wherever an agent's `allowedTools` admits them — including the dev/test wildcard (empty `allowedTools` + empty `mcpConfigIds` ⇒ full catalog, per `mcp-client`'s `filterByAgentScope`), the k8s preset, and the canary. Auto-including them in **every multi-tenant agent's** `allowedTools` as locked smart defaults is the **smart-defaults** layer (design Part II P4: "the broker… appears in every agent's skill list marked default and locked"). **CLOSES when smart-defaults lands.**

`search_catalog` itself is **fully wired** end-to-end (model → tool → `skills:search-catalog` → candidates), proven by the canary.

---

## Self-Review

**Spec coverage** (against design §6A, §11 component #1, §11.1 boundary review, decision #4, and the card body):

- "Always-on Inert host tool (like web_search)" → `@ax/skill-broker` built on the same `tool:register`/`tool:execute` host-tool surface as `@ax/web-tools` (Tasks 3–4), wired into the preset (Task 5). The "always-on across multi-tenant agents" remainder is the stated half-wired smart-defaults window. ✓
- "`search_catalog` (intent/keyword → candidate summaries)" → Task 3 tool + Task 2 hook. ✓
- "`request_capability(skillId)` drives the pause→card→approve→install flow" → Task 4 builds the validate+ack shell; the pause/card/install is the stated TASK-35/36 half-wired window (fork resolved with rationale). ✓
- "New hook `skills:search-catalog` — intent → {id, description, tier, hosts, slots}; keyword vs vector impl-agnostic; read-only, no subscriber risk" → Task 2 + the boundary-review note. ✓
- "Security-checklist (always-on host tool consuming untrusted intent)" → pre-PR gate (Task 7) + pre-stated threat model. ✓
- "Depends on TASK-33 (request_capability installs via the per-user attach layer)" → the install itself is deferred to TASK-36 (which uses TASK-33's hook); the dep gate + the as-built re-verification section handle the merge ordering. ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions; every run step shows the exact `pnpm -F` command + expected result. The canary step (Task 6) is prose + key assertions, matching the template's canary task (its harness wiring follows the file's existing pattern). No TBD/TODO in shipped code. ✓

**Type consistency:** the candidate shape is `{ id, description, tier, hosts: string[], slots: string[] }` everywhere — `CatalogCandidate` (skills `types.ts`), `CatalogCandidateSchema` (zod), the broker's local mirror (`search-catalog.ts`), and the canary assertions. `tier`/`SkillTier` = `'inert' | 'bounded' | 'registry'` in `catalog-tier.ts`, re-exported from `types.ts`, and matched by the zod union. `request_capability` returns `{ status: 'requested' | 'not-found'; skillId }` in both the tool and its tests. Tool names `search_catalog` / `request_capability` match `agents`' `TOOL_NAME_RE` (`/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/`). `tool:execute:${name}` handlers return the result object directly (the `tool.execute-host` IPC handler wraps it as `{ output }`), matching `@ax/web-tools`.

**Known residual / forks (resolved):** (1) tier is derived, not stored — re-verified against TASK-32 at execution (delete `classifyTier` if TASK-32 added a stored field); (2) a bundled script that shells to `pip`/`npx` without declaring `packages` reads as `bounded` — acceptable, the admit-time bundle review is the supply-chain gate; (3) in-memory search (no SQL `LIKE`) is correct at admin scale and removes the injection surface — revisit if the catalog grows to where a vector/index impl is warranted (the hook's alternate-impl door is open by design).
