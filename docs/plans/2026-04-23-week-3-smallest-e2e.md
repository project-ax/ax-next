# Week 3: Smallest Viable End-to-End Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up four new packages — `@ax/llm-mock`, `@ax/storage-sqlite`, `@ax/audit-log`, `@ax/cli` — such that running the CLI binary sends a user message through the kernel's `chat:run`, receives the mock LLM's `"hello"` back, and logs the outcome to a SQLite file via a real `storage:set` call from a real subscriber plugin. All boot-time wiring flows through the Week 1–2 kernel (no direct plugin-to-plugin imports outside `@ax/cli`).

**Architecture:** Week 3 is the first slice with multiple plugins coexisting. `@ax/llm-mock` registers `llm:call` as a service hook. `@ax/storage-sqlite` registers `storage:get` + `storage:set` as service hooks backed by a single-table key-value schema (Kysely + `better-sqlite3`). `@ax/audit-log` is a pure subscriber plugin — it subscribes to `chat:end` and calls `storage:set`. `@ax/cli` is the composition root: it imports the four plugins directly (allowed only for `packages/cli/**` per `eslint.config.mjs`), bootstraps them via `@ax/core`, invokes `chat:run`, and prints the assistant's content to stdout. The shape is deliberately small and does not introduce IPC primitives, sandbox spawning, or a config-file loader — those land in Week 4+ when motivation is clearer.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, zod, Kysely (^0.27), better-sqlite3 (^11), pnpm workspaces, tsconfig project references, changesets.

---

## Resolved scope decisions (from `docs/plans/2026-04-23-week-3-handoff.md`)

1. **`@ax/sandbox-subprocess` is deferred to Week 4.** The happy-path message → response flow does not exercise tool calls, and shipping `sandbox:spawn` with no caller violates CLAUDE.md invariant 3 (no half-wired plugins). IPC primitives are deferred alongside it.
2. **`@ax/storage-sqlite` ships with a real consumer.** The `@ax/audit-log` plugin subscribes to `chat:end` and writes the chat outcome to storage, giving `storage:set` a live subscriber and avoiding the half-wired trap.
3. **`@ax/cli` is a hardcoded preset.** It directly imports the four Week 3 plugins. No `ax.config.ts` discovery — that lands when there are two presets to pick between.
4. **Known Week 1–2 deferrals already fixed on branch.** `hookName?: string` on `PluginError` (replaces the `classify()` regex), `DEFAULT_MAX_TURNS = 20` guard on the chat loop, and `detectCycles` rename (split into `checkDuplicateRegisters` + `detectCycles` in `bootstrap.ts`) are already in on `feat/kernel-hook-bus`. Nothing to fold in from that list. The `[tool <name>] <JSON>` tool-result placeholder stays as-is per handoff recommendation.
5. **Security checklist fires for `@ax/storage-sqlite` only.** Sandbox-subprocess is deferred, so sandbox escape / IPC transport threat models do not apply to this slice. Storage-sqlite hits the external-system-boundary threat: SQL injection (mitigated by Kysely parameterized queries) and file path handling for the database file (mitigated by treating config as trusted, documenting the boundary).

## Invariants enforced by this slice (per CLAUDE.md)

1. **Hook surface is transport- and storage-agnostic.** `storage:get` / `storage:set` payloads use `key: string` and `value: Uint8Array` — no `table`, `rowid`, `column`, `bucket`, or any SQLite-specific vocabulary. A future `@ax/storage-postgres` or `@ax/storage-memory` can implement the same hooks.
2. **No cross-plugin imports.** Plugins communicate via the hook bus. `@ax/cli` is the one exception allowed by `eslint.config.mjs` (it is the composition root, and its job is to import plugins to wire them up).
3. **No half-wired plugins.** Every plugin added in this slice has a live caller: `llm:call` is invoked by the kernel chat loop; `storage:set` is invoked by `@ax/audit-log`; `chat:end` is fired by the kernel chat loop. `storage:get` is exercised by tests, not by runtime yet — justified as symmetrical surface with `storage:set`, since a read-only consumer lands in Week 4+ (session lookup).
4. **One source of truth per concept.** SQLite chat records live only in the audit plugin's key namespace (`chat:<reqId>`). No other plugin writes chat records in this slice.
5. **Capabilities are explicit and minimized.** `@ax/storage-sqlite` takes exactly one capability from its caller: a filesystem path to the DB file. It does not open the network, spawn processes, or read env. `@ax/llm-mock` has no capabilities (pure function). `@ax/audit-log` takes no config (pure subscriber wiring). `@ax/cli` reads a single env var (`AX_DB`) with a safe default.

## Branch policy

This plan branches off `feat/kernel-hook-bus` (Week 1–2, unmerged), **not** `main`. The executor creates `feat/week-3-smallest-e2e` from `feat/kernel-hook-bus` before Task 1.

```bash
git checkout feat/kernel-hook-bus
git checkout -b feat/week-3-smallest-e2e
```

Week 1–2 and Week 3 will merge together as a stack.

---

## Layout after this plan

```
ax-next/
├── packages/
│   ├── core/                             (unchanged — Week 1–2)
│   ├── test-harness/                     (unchanged — Week 1–2)
│   ├── llm-mock/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── plugin.ts
│   │       └── __tests__/
│   │           └── plugin.test.ts
│   ├── storage-sqlite/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── SECURITY.md                   — security-checklist output
│   │   └── src/
│   │       ├── index.ts
│   │       ├── plugin.ts
│   │       ├── schema.ts                 — Kysely schema type + migration
│   │       └── __tests__/
│   │           └── plugin.test.ts
│   ├── audit-log/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── plugin.ts
│   │       └── __tests__/
│   │           └── plugin.test.ts
│   └── cli/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── index.ts
│           ├── main.ts
│           └── __tests__/
│               └── e2e.test.ts
├── tsconfig.json                          — reference list extended
└── .changeset/week-3-e2e.md
```

---

## Task 1: Feature branch

**Files:** none (branch only).

**Step 1: Verify you are on `feat/kernel-hook-bus` and it is clean**

```bash
git status
git branch --show-current
```

Expected: `feat/kernel-hook-bus`, clean working tree. If not, stop and sync with the user.

**Step 2: Create the Week 3 branch**

```bash
git checkout -b feat/week-3-smallest-e2e
```

**Step 3: Confirm Week 1–2 baseline still green**

```bash
pnpm build
pnpm -r run test
pnpm lint
```

Expected: `@ax/core` 40/40, `@ax/test-harness` 5/5, lint clean.

No commit — branch creation alone is not a commit.

---

## Task 2: `@ax/llm-mock` package scaffold

**Files:**
- Create: `packages/llm-mock/package.json`
- Create: `packages/llm-mock/tsconfig.json`
- Create: `packages/llm-mock/vitest.config.ts`
- Create: `packages/llm-mock/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Write `packages/llm-mock/package.json`**

```json
{
  "name": "@ax/llm-mock",
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
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 2: Write `packages/llm-mock/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

**Step 3: Write `packages/llm-mock/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

**Step 4: Stub `packages/llm-mock/src/index.ts`**

```ts
export {};
```

**Step 5: Add reference in root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/test-harness" },
    { "path": "packages/llm-mock" }
  ]
}
```

**Step 6: Install + build + verify**

```bash
pnpm install
pnpm --filter @ax/llm-mock build
```

Expected: builds without error; `packages/llm-mock/dist/index.js` exists.

**Step 7: Commit**

```bash
git add packages/llm-mock tsconfig.json pnpm-lock.yaml
git commit -m "feat(llm-mock): scaffold @ax/llm-mock package"
```

---

## Task 3: `@ax/llm-mock` plugin implementation

**Files:**
- Create: `packages/llm-mock/src/plugin.ts`
- Create: `packages/llm-mock/src/__tests__/plugin.test.ts`
- Modify: `packages/llm-mock/src/index.ts`

**Step 1: Write the failing test** (`packages/llm-mock/src/__tests__/plugin.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import type { LlmRequest, LlmResponse } from '@ax/core';
import { llmMockPlugin } from '../plugin.js';

describe('@ax/llm-mock', () => {
  it('registers llm:call and returns the canned response', async () => {
    const h = await createTestHarness({ plugins: [llmMockPlugin()] });
    expect(h.bus.hasService('llm:call')).toBe(true);

    const res = await h.bus.call<LlmRequest, LlmResponse>(
      'llm:call',
      h.ctx(),
      { messages: [{ role: 'user', content: 'ignored' }] },
    );
    expect(res.assistantMessage).toEqual({ role: 'assistant', content: 'hello' });
    expect(res.toolCalls).toEqual([]);
  });

  it('manifest names @ax/llm-mock as the registering plugin', () => {
    const p = llmMockPlugin();
    expect(p.manifest.name).toBe('@ax/llm-mock');
    expect(p.manifest.registers).toContain('llm:call');
    expect(p.manifest.calls).toEqual([]);
    expect(p.manifest.subscribes).toEqual([]);
  });

  it('end-to-end: chat:run with llm-mock loaded completes with "hello"', async () => {
    const h = await createTestHarness({ plugins: [llmMockPlugin()] });
    const outcome = await h.bus.call('chat:run', h.ctx(), {
      message: { role: 'user', content: 'anything' },
    });
    expect(outcome).toMatchObject({ kind: 'complete' });
    if (outcome.kind === 'complete') {
      const last = outcome.messages[outcome.messages.length - 1];
      expect(last).toEqual({ role: 'assistant', content: 'hello' });
    }
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @ax/llm-mock test
```

Expected: FAIL (`../plugin.js` not found).

**Step 3: Implement `packages/llm-mock/src/plugin.ts`**

```ts
import type { LlmRequest, LlmResponse, Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/llm-mock';

export function llmMockPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['llm:call'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      bus.registerService<LlmRequest, LlmResponse>(
        'llm:call',
        PLUGIN_NAME,
        async () => ({
          assistantMessage: { role: 'assistant', content: 'hello' },
          toolCalls: [],
        }),
      );
    },
  };
}
```

**Step 4: Update `packages/llm-mock/src/index.ts`**

```ts
export * from './plugin.js';
```

**Step 5: Run the test to verify it passes**

```bash
pnpm --filter @ax/llm-mock test
```

Expected: PASS (3 tests).

**Step 6: Commit**

```bash
git add packages/llm-mock
git commit -m "feat(llm-mock): register llm:call returning canned 'hello' response"
```

---

## Task 4: `@ax/storage-sqlite` security checklist

**Files:**
- Create: `packages/storage-sqlite/SECURITY.md`

This task runs *before* writing any storage code, per CLAUDE.md: "When touching sandbox boundaries, IPC transport, plugin loading, or any code path that handles untrusted content, invoke the `security-checklist` skill."

**Step 1: Invoke the `security-checklist` skill**

Invoke `Skill` with `security-checklist`. Walk the three threat models (sandbox escape, prompt injection, supply chain) against the `@ax/storage-sqlite` design:

- SQL injection → mitigated by Kysely parameterized queries; no raw-string interpolation anywhere in the plugin.
- File path handling → `databasePath` config is treated as trusted (operator-supplied via the composing CLI / preset). The plugin does not normalize or validate it further.
- Supply chain → adds two runtime deps (`kysely`, `better-sqlite3`) and one dev dep (`@types/better-sqlite3`). Both are widely used, have recent releases, and are pinned via caret ranges.
- Untrusted content → the plugin treats `value: Uint8Array` as opaque bytes. It does not interpret, parse, or execute stored content. Callers that put untrusted content in must treat it as untrusted on read.
- IPC / sandbox boundaries → not applicable (no IPC, no sandbox in this slice).

**Step 2: Save the skill output as `packages/storage-sqlite/SECURITY.md`**

Use the structured PR security note format the skill produces. Include a concluding line: "Storage path is operator-trusted; the plugin does not treat caller-supplied paths as untrusted input. Callers that accept path from untrusted input must validate before passing."

**Step 3: Commit**

```bash
git add packages/storage-sqlite/SECURITY.md
git commit -m "docs(storage-sqlite): security checklist note"
```

---

## Task 5: `@ax/storage-sqlite` package scaffold

**Files:**
- Create: `packages/storage-sqlite/package.json`
- Create: `packages/storage-sqlite/tsconfig.json`
- Create: `packages/storage-sqlite/vitest.config.ts`
- Create: `packages/storage-sqlite/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Write `packages/storage-sqlite/package.json`**

```json
{
  "name": "@ax/storage-sqlite",
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
  "files": ["dist", "SECURITY.md"],
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ax/core": "workspace:*",
    "better-sqlite3": "^11.3.0",
    "kysely": "^0.27.4"
  },
  "devDependencies": {
    "@ax/test-harness": "workspace:*",
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 2: Write `packages/storage-sqlite/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

**Step 3: Write `packages/storage-sqlite/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

**Step 4: Stub `packages/storage-sqlite/src/index.ts`**

```ts
export {};
```

**Step 5: Update root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/test-harness" },
    { "path": "packages/llm-mock" },
    { "path": "packages/storage-sqlite" }
  ]
}
```

**Step 6: Install + build + verify**

```bash
pnpm install
pnpm --filter @ax/storage-sqlite build
```

Expected: builds without error. `better-sqlite3` may compile a native binary on first install — that is normal.

**Step 7: Commit**

```bash
git add packages/storage-sqlite tsconfig.json pnpm-lock.yaml
git commit -m "feat(storage-sqlite): scaffold @ax/storage-sqlite package"
```

---

## Task 6: `@ax/storage-sqlite` plugin implementation

**Files:**
- Create: `packages/storage-sqlite/src/schema.ts`
- Create: `packages/storage-sqlite/src/plugin.ts`
- Create: `packages/storage-sqlite/src/__tests__/plugin.test.ts`
- Modify: `packages/storage-sqlite/src/index.ts`

**Step 1: Write the failing test** (`packages/storage-sqlite/src/__tests__/plugin.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@ax/test-harness';
import { createStorageSqlitePlugin } from '../plugin.js';

describe('@ax/storage-sqlite', () => {
  it('registers storage:get and storage:set', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    expect(h.bus.hasService('storage:get')).toBe(true);
    expect(h.bus.hasService('storage:set')).toBe(true);
  });

  it('set then get round-trips a byte value', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    const value = new TextEncoder().encode('hello world');
    await h.bus.call('storage:set', ctx, { key: 'k1', value });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k1' },
    );
    expect(got.value).toBeDefined();
    expect(new TextDecoder().decode(got.value!)).toBe('hello world');
  });

  it('get of missing key returns { value: undefined }', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      h.ctx(),
      { key: 'nope' },
    );
    expect(got.value).toBeUndefined();
  });

  it('set overwrites existing value at same key', async () => {
    const h = await createTestHarness({
      plugins: [createStorageSqlitePlugin({ databasePath: ':memory:' })],
    });
    const ctx = h.ctx();
    await h.bus.call('storage:set', ctx, { key: 'k', value: new Uint8Array([1, 2, 3]) });
    await h.bus.call('storage:set', ctx, { key: 'k', value: new Uint8Array([9, 9]) });
    const got = await h.bus.call<{ key: string }, { value: Uint8Array | undefined }>(
      'storage:get',
      ctx,
      { key: 'k' },
    );
    expect(Array.from(got.value!)).toEqual([9, 9]);
  });

  it('manifest advertises the storage hooks', () => {
    const p = createStorageSqlitePlugin({ databasePath: ':memory:' });
    expect(p.manifest.name).toBe('@ax/storage-sqlite');
    expect(p.manifest.registers).toContain('storage:get');
    expect(p.manifest.registers).toContain('storage:set');
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @ax/storage-sqlite test
```

Expected: FAIL.

**Step 3: Write `packages/storage-sqlite/src/schema.ts`**

```ts
import { Kysely, SqliteDialect, type Generated } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';

export interface KvRow {
  key: string;
  value: Buffer;
  updated_at: Generated<string>;
}

export interface Database {
  kv: KvRow;
}

export function openDatabase(databasePath: string): Kysely<Database> {
  const driver = new BetterSqlite3(databasePath);
  driver.pragma('journal_mode = WAL');
  driver.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: driver }),
  });
}
```

**Step 4: Write `packages/storage-sqlite/src/plugin.ts`**

```ts
import type { Plugin } from '@ax/core';
import { openDatabase, type Database } from './schema.js';
import type { Kysely } from 'kysely';

const PLUGIN_NAME = '@ax/storage-sqlite';

export interface StorageSqliteConfig {
  databasePath: string;
}

export function createStorageSqlitePlugin(config: StorageSqliteConfig): Plugin {
  let db: Kysely<Database> | undefined;

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['storage:get', 'storage:set'],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      db = openDatabase(config.databasePath);

      bus.registerService<{ key: string }, { value: Uint8Array | undefined }>(
        'storage:get',
        PLUGIN_NAME,
        async (_ctx, { key }) => {
          const row = await db!.selectFrom('kv').select('value').where('key', '=', key).executeTakeFirst();
          if (row === undefined) return { value: undefined };
          return { value: new Uint8Array(row.value) };
        },
      );

      bus.registerService<{ key: string; value: Uint8Array }, void>(
        'storage:set',
        PLUGIN_NAME,
        async (_ctx, { key, value }) => {
          await db!
            .insertInto('kv')
            .values({ key, value: Buffer.from(value) })
            .onConflict((oc) =>
              oc.column('key').doUpdateSet({
                value: Buffer.from(value),
                updated_at: new Date().toISOString(),
              }),
            )
            .execute();
        },
      );
    },
  };
}
```

**Step 5: Update `packages/storage-sqlite/src/index.ts`**

```ts
export * from './plugin.js';
```

**Step 6: Run the test to verify it passes**

```bash
pnpm --filter @ax/storage-sqlite test
```

Expected: PASS (5 tests).

**Step 7: Commit**

```bash
git add packages/storage-sqlite
git commit -m "feat(storage-sqlite): Kysely-backed KV store for storage:get/set"
```

---

## Task 7: `@ax/audit-log` package scaffold

**Files:**
- Create: `packages/audit-log/package.json`
- Create: `packages/audit-log/tsconfig.json`
- Create: `packages/audit-log/vitest.config.ts`
- Create: `packages/audit-log/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Write `packages/audit-log/package.json`**

```json
{
  "name": "@ax/audit-log",
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
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

**Step 2: Write `packages/audit-log/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [{ "path": "../core" }]
}
```

**Step 3: Write `packages/audit-log/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

**Step 4: Stub `packages/audit-log/src/index.ts`**

```ts
export {};
```

**Step 5: Update root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/test-harness" },
    { "path": "packages/llm-mock" },
    { "path": "packages/storage-sqlite" },
    { "path": "packages/audit-log" }
  ]
}
```

**Step 6: Install + build + verify**

```bash
pnpm install
pnpm --filter @ax/audit-log build
```

Expected: builds without error.

**Step 7: Commit**

```bash
git add packages/audit-log tsconfig.json pnpm-lock.yaml
git commit -m "feat(audit-log): scaffold @ax/audit-log package"
```

---

## Task 8: `@ax/audit-log` plugin implementation

**Files:**
- Create: `packages/audit-log/src/plugin.ts`
- Create: `packages/audit-log/src/__tests__/plugin.test.ts`
- Modify: `packages/audit-log/src/index.ts`

**Step 1: Write the failing test** (`packages/audit-log/src/__tests__/plugin.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createTestHarness, MockServices } from '@ax/test-harness';
import type { ChatOutcome } from '@ax/core';
import { auditLogPlugin } from '../plugin.js';

describe('@ax/audit-log', () => {
  it('subscribes to chat:end and writes the outcome to storage:set', async () => {
    const writes: Array<{ key: string; value: Uint8Array }> = [];
    const h = await createTestHarness({
      services: {
        ...MockServices.basics(),
        'storage:set': async (_ctx, input) => {
          writes.push(input as { key: string; value: Uint8Array });
        },
      },
      plugins: [auditLogPlugin()],
    });

    const ctx = h.ctx({ reqId: 'req-abc' });
    const outcome: ChatOutcome = {
      kind: 'complete',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    await h.bus.fire('chat:end', ctx, { outcome });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toBe('chat:req-abc');
    const decoded = JSON.parse(new TextDecoder().decode(writes[0]!.value));
    expect(decoded).toMatchObject({
      reqId: 'req-abc',
      sessionId: 'test-session',
      outcome: {
        kind: 'complete',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
    });
    expect(typeof decoded.timestamp).toBe('string');
  });

  it('returns pass-through (undefined) — does not transform chat:end payload', async () => {
    const h = await createTestHarness({
      services: { ...MockServices.basics(), 'storage:set': async () => undefined },
      plugins: [auditLogPlugin()],
    });
    const ctx = h.ctx();
    const result = await h.bus.fire<{ outcome: ChatOutcome }>('chat:end', ctx, {
      outcome: { kind: 'complete', messages: [] },
    });
    expect(result).toMatchObject({
      rejected: false,
      payload: { outcome: { kind: 'complete', messages: [] } },
    });
  });

  it('declares the right manifest', () => {
    const p = auditLogPlugin();
    expect(p.manifest.name).toBe('@ax/audit-log');
    expect(p.manifest.registers).toEqual([]);
    expect(p.manifest.calls).toContain('storage:set');
    expect(p.manifest.subscribes).toContain('chat:end');
  });

  it('bootstrap fails with missing-service if storage:set is not registered', async () => {
    await expect(
      createTestHarness({ plugins: [auditLogPlugin()] }),
    ).rejects.toMatchObject({ name: 'PluginError', code: 'missing-service' });
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
pnpm --filter @ax/audit-log test
```

Expected: FAIL.

**Step 3: Implement `packages/audit-log/src/plugin.ts`**

```ts
import type { ChatContext, ChatOutcome, Plugin } from '@ax/core';

const PLUGIN_NAME = '@ax/audit-log';

export function auditLogPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: [],
      calls: ['storage:set'],
      subscribes: ['chat:end'],
    },
    init({ bus }) {
      bus.subscribe<{ outcome: ChatOutcome }>(
        'chat:end',
        PLUGIN_NAME,
        async (ctx: ChatContext, payload) => {
          const record = {
            reqId: ctx.reqId,
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            userId: ctx.userId,
            outcome: payload.outcome,
            timestamp: new Date().toISOString(),
          };
          const value = new TextEncoder().encode(JSON.stringify(record));
          await bus.call('storage:set', ctx, { key: `chat:${ctx.reqId}`, value });
          return undefined;
        },
      );
    },
  };
}
```

**Step 4: Update `packages/audit-log/src/index.ts`**

```ts
export * from './plugin.js';
```

**Step 5: Run the test to verify it passes**

```bash
pnpm --filter @ax/audit-log test
```

Expected: PASS (4 tests).

**Step 6: Commit**

```bash
git add packages/audit-log
git commit -m "feat(audit-log): subscribe chat:end and persist outcomes via storage:set"
```

---

## Task 9: `@ax/cli` package scaffold

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/index.ts` (empty placeholder)
- Modify: `tsconfig.json` (add reference)

**Step 1: Write `packages/cli/package.json`**

```json
{
  "name": "@ax/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "ax-next": "./dist/main.js"
  },
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
    "@ax/core": "workspace:*",
    "@ax/llm-mock": "workspace:*",
    "@ax/storage-sqlite": "workspace:*",
    "@ax/audit-log": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "better-sqlite3": "^11.3.0",
    "@types/better-sqlite3": "^7.6.12",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

Note: `better-sqlite3` is a dev dep here so the e2e test (Task 11) can open and inspect the SQLite file the CLI wrote. The CLI runtime itself does not use it directly.

**Step 2: Write `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**", "dist", "node_modules"],
  "references": [
    { "path": "../core" },
    { "path": "../llm-mock" },
    { "path": "../storage-sqlite" },
    { "path": "../audit-log" }
  ]
}
```

**Step 3: Write `packages/cli/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

**Step 4: Stub `packages/cli/src/index.ts`**

```ts
export {};
```

**Step 5: Update root `tsconfig.json`**

```json
{
  "extends": "./tsconfig.base.json",
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/test-harness" },
    { "path": "packages/llm-mock" },
    { "path": "packages/storage-sqlite" },
    { "path": "packages/audit-log" },
    { "path": "packages/cli" }
  ]
}
```

**Step 6: Install + build + verify**

```bash
pnpm install
pnpm --filter @ax/cli build
```

Expected: builds without error.

**Step 7: Commit**

```bash
git add packages/cli tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): scaffold @ax/cli package"
```

---

## Task 10: `@ax/cli` main runner

**Files:**
- Create: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`

**Step 1: Write `packages/cli/src/main.ts`**

```ts
#!/usr/bin/env node
import {
  HookBus,
  bootstrap,
  makeChatContext,
  registerChatLoop,
  type ChatOutcome,
} from '@ax/core';
import { llmMockPlugin } from '@ax/llm-mock';
import { createStorageSqlitePlugin } from '@ax/storage-sqlite';
import { auditLogPlugin } from '@ax/audit-log';

export interface MainOptions {
  databasePath: string;
  message: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(opts: MainOptions): Promise<number> {
  const out = opts.stdout ?? ((line) => process.stdout.write(line + '\n'));
  const err = opts.stderr ?? ((line) => process.stderr.write(line + '\n'));

  const bus = new HookBus();
  registerChatLoop(bus);

  await bootstrap({
    bus,
    plugins: [
      llmMockPlugin(),
      createStorageSqlitePlugin({ databasePath: opts.databasePath }),
      auditLogPlugin(),
    ],
    config: {},
  });

  const ctx = makeChatContext({
    sessionId: 'cli-session',
    agentId: 'cli-agent',
    userId: 'cli-user',
  });

  const outcome: ChatOutcome = await bus.call('chat:run', ctx, {
    message: { role: 'user', content: opts.message },
  });

  if (outcome.kind === 'complete') {
    const last = outcome.messages[outcome.messages.length - 1];
    out(last?.content ?? '');
    return 0;
  }
  err(`chat terminated: ${outcome.reason}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databasePath = process.env.AX_DB ?? './ax-next-chat.sqlite';
  const message = process.argv.slice(2).join(' ') || 'hi';
  main({ databasePath, message })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    });
}
```

**Step 2: Update `packages/cli/src/index.ts`**

```ts
export { main, type MainOptions } from './main.js';
```

**Step 3: Build + verify**

```bash
pnpm --filter @ax/cli build
```

Expected: `packages/cli/dist/main.js` exists.

Run `head -1 packages/cli/dist/main.js` and confirm the shebang (`#!/usr/bin/env node`) is present. TypeScript's `tsc` preserves shebangs on the first line of a source file, but only if the compiler targets ESM and the shebang is the first character. If missing, prepend it in a `build` post-step or document that the CLI is invoked via `node dist/main.js` (which is what the e2e test in Task 11 does — the shebang is cosmetic for this slice).

**Step 4: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): main runner wires mock LLM + sqlite storage + audit"
```

---

## Task 11: End-to-end acceptance test

**Files:**
- Create: `packages/cli/src/__tests__/e2e.test.ts`

**Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const cliEntry = join(__dirname, '..', '..', 'dist', 'main.js');

describe('@ax/cli end-to-end', () => {
  let workDir: string;

  beforeAll(() => {
    // Ensure the CLI and its workspace deps are built. spawnSync with an
    // argv array avoids shell quoting / injection — there is no user input
    // here, but keeping shell: false is the repo's safer-by-default pattern.
    const built = spawnSync(
      'pnpm',
      ['--filter', '@ax/cli...', 'build'],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' },
    );
    if (built.status !== 0) {
      throw new Error(`workspace build failed (exit ${built.status})`);
    }
    if (!existsSync(cliEntry)) {
      throw new Error(`CLI entry not found at ${cliEntry}; build must have failed`);
    }
  });

  afterEach(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('runs a full chat and persists the outcome to SQLite', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
    const dbPath = join(workDir, 'e2e.sqlite');

    const result = spawnSync('node', [cliEntry, 'hi'], {
      env: { ...process.env, AX_DB: dbPath },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');

    expect(existsSync(dbPath)).toBe(true);
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT key, value FROM kv')
        .all() as Array<{ key: string; value: Buffer }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const chatRow = rows.find((r) => r.key.startsWith('chat:'));
      expect(chatRow).toBeDefined();
      const decoded = JSON.parse(chatRow!.value.toString('utf8'));
      expect(decoded.outcome).toMatchObject({ kind: 'complete' });
      expect(decoded.sessionId).toBe('cli-session');
    } finally {
      db.close();
    }
  });

  it('non-zero exit when a plugin init fails', () => {
    workDir = mkdtempSync(join(tmpdir(), 'ax-next-e2e-'));
    // Pointing AX_DB at a directory (not a file) forces SQLite open to fail
    // at init, which bubbles up as `init-failed` → non-zero CLI exit.
    const result = spawnSync('node', [cliEntry, 'hi'], {
      env: { ...process.env, AX_DB: workDir },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
  });
});
```

**Step 2: Run the test**

```bash
pnpm --filter @ax/cli test
```

Expected: PASS (2 tests). The `beforeAll` builds the workspace; if a dep has drifted, expect that to surface here.

**Step 3: Commit**

```bash
git add packages/cli
git commit -m "test(cli): end-to-end acceptance — CLI → chat:run → SQLite"
```

---

## Task 12: Changeset + full workspace build + test + lint

**Files:**
- Create: `.changeset/week-3-e2e.md`

**Step 1: Write the changeset**

```markdown
---
'@ax/llm-mock': minor
'@ax/storage-sqlite': minor
'@ax/audit-log': minor
'@ax/cli': minor
---

Smallest viable end-to-end: four plugins (`@ax/llm-mock`, `@ax/storage-sqlite`, `@ax/audit-log`, `@ax/cli`) that compose into a running CLI. Sending a message through `@ax/cli` invokes the kernel's `chat:run`, gets back a canned `"hello"` from the mock LLM, and the audit plugin persists the outcome to SQLite via `storage:set`. This is the first slice with multiple plugins wired through the hook bus; `@ax/sandbox-subprocess`, IPC primitives, and `ax.config.ts` discovery are deferred to Week 4+.
```

**Step 2: Run the full matrix**

```bash
pnpm build
pnpm -r run test
pnpm lint
```

Expected: clean build, all tests pass, lint clean. Counts: `@ax/core` 40+/40+, `@ax/test-harness` 5/5, `@ax/llm-mock` 3/3, `@ax/storage-sqlite` 5/5, `@ax/audit-log` 4/4, `@ax/cli` 2/2.

**Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: changeset for Week 3 smallest-e2e slice"
```

---

## Definition of done for this plan

- [ ] Feature branch `feat/week-3-smallest-e2e` created off `feat/kernel-hook-bus`, not merged.
- [ ] `pnpm build` clean across the workspace.
- [ ] `pnpm -r run test` passes with at least 14 new tests across the four new packages.
- [ ] `pnpm lint` passes. Only `@ax/cli` imports sibling `@ax/*` plugins; all other plugins import `@ax/core` (and `@ax/test-harness` in test files) only.
- [ ] End-to-end test spawns the compiled CLI, confirms stdout is `hello`, and confirms the SQLite file contains a `chat:*` record with the complete outcome.
- [ ] `packages/storage-sqlite/SECURITY.md` exists with the structured security-checklist output.
- [ ] Changeset entry documenting the minor bump of all four new packages is present.
- [ ] One commit per task (plus Task 1 which is branch-only, no commit).

## Boundary review note for the PR description

Per CLAUDE.md: this slice introduces two new service-hook signatures (`storage:get`, `storage:set`). Answering the review checklist:

- **Alternate impl this hook could have:** `@ax/storage-postgres` (Week 7+) or `@ax/storage-memory` (tests-only, trivial) — same `{ key, value }` shape, same `Uint8Array` bytes contract.
- **Payload field names that might leak:** none. `key: string` and `value: Uint8Array` are SQLite- and Postgres- neutral. No `table`, `column`, `rowid`, `bucket`, or schema name.
- **Subscriber risk:** none in this slice; `storage:*` are service hooks with no subscriber surface.
- **Wire surface (if this is also an IPC action):** not applicable — no IPC in Week 3.

The `chat:end` subscriber contract (`{ outcome: ChatOutcome }`) was defined by Week 1–2 and is unchanged. `@ax/audit-log` is the first subscriber.

## Deferred to later slices (not in this plan)

- `@ax/sandbox-subprocess` + IPC primitives (length-prefixed framing, Zod wire validation, sandbox-side client) — Week 4 when the first real tool lands.
- `ax.config.ts` discovery + dynamic plugin import — when there are 2+ presets to pick between.
- `database:get-instance` / `database:transaction` abstraction (Section 6) — when `@ax/storage-postgres` lands alongside SQLite.
- Real `llm:call` plugins (`@ax/llm-anthropic`, `@ax/llm-router`) — Week 4-6.
- Timeout enforcement on service-hook calls (architecture doc Section 10) — deferred until we have a real `llm:call` with measurable tail latency.
- Zod return-shape validation on service hooks (architecture doc Section 10) — same gate.
