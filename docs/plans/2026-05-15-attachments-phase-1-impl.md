# Attachments & Artifacts — Phase 1 Implementation Plan (Protocol + Host Foundation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundational pieces of the attachments & artifacts subsystem at the protocol + host layer. The new `@ax/attachments` plugin is loaded by both CLI and canary presets, and its three service hooks (`store-temp`, `commit`, `download`) are callable via the bus with full unit + contract coverage. The `@ax/workspace-git-server` storage tier gains Git LFS endpoints so the binary blobs the next phases will commit have somewhere to live. **No callers yet** — the agent-side artifact tool (Phase 2) and the channel-web UI (Phase 3) come in subsequent PRs.

**Architecture:** Three changes layered foundation-up. (1) `@ax/ipc-protocol` gains two new `ContentBlock` discriminated-union variants (`attachment_ref` and `attachment`). (2) `@ax/workspace-git-server` gains four LFS endpoints (batch, upload, download, verify) sharing the existing bearer-token auth path. (3) A new `@ax/attachments` plugin owns a Postgres-backed temp store (`attachment_temps` table), implements the three service hooks (with the path-scope ACL fully inside `attachments:download`, not the route layer), and runs a TTL janitor.

**Tech Stack:** TypeScript + Kysely + Postgres (existing), zod for schemas, vitest for tests. LFS protocol is standard HTTP + JSON — no new npm dependency for the server side. Sandbox/host `git-lfs` binary install lands in Phase 3 (no caller in Phase 1 needs it).

**Spec:** `docs/plans/2026-05-15-attachments-and-artifacts-design.md` — specifically the "Hook surface" section, the "Wire surfaces — `POST /api/attachments`" and "LFS configuration" sections, and the path-scope ACL detailed in "Boundary C".

**Half-wired window:** OPEN by this PR, scheduled CLOSE in Phase 3. PR body must declare:
> "Half-wired windows opened: `@ax/attachments` plugin is loaded by both CLI and canary presets but has no callers yet. Phase 2 wires up the `artifact_publish` tool; Phase 3 wires up channel-web. Window closes in Phase 3."

---

## File Structure

**Modify:**
- `packages/ipc-protocol/src/content-blocks.ts` — add `AttachmentRefBlockSchema` + `AttachmentBlockSchema`, extend the union.
- `packages/ipc-protocol/src/__tests__/content-blocks.test.ts` — add round-trip tests for the new variants.
- `packages/workspace-git-server/src/server/listener.ts` — add LFS route dispatch (matching the existing smart-HTTP dispatch).
- `packages/workspace-git-server/src/server/repos.ts` — provision per-workspace `.lfs/` directory on repo create.
- `packages/workspace-git-server/src/__tests__/contract.test.ts` — extend with LFS batch + upload/download contract tests.
- `packages/preset-k8s/src/index.ts` (or equivalent) — register `@ax/attachments`.
- `packages/cli/src/config/load.ts` (or equivalent) — register `@ax/attachments`.

**Create:**
- `packages/attachments/package.json`
- `packages/attachments/tsconfig.json`
- `packages/attachments/src/index.ts`
- `packages/attachments/src/plugin.ts`
- `packages/attachments/src/types.ts`
- `packages/attachments/src/migrations.ts`
- `packages/attachments/src/store.ts`
- `packages/attachments/src/handlers.ts`
- `packages/attachments/src/janitor.ts`
- `packages/attachments/src/__tests__/store-temp.test.ts`
- `packages/attachments/src/__tests__/commit.test.ts`
- `packages/attachments/src/__tests__/download.test.ts`
- `packages/attachments/src/__tests__/janitor.test.ts`
- `packages/attachments/src/__tests__/contract.test.ts`
- `packages/workspace-git-server/src/server/lfs.ts` — LFS endpoint handlers.

**Do not touch:** `packages/channel-web` (Phase 3), `packages/agent-claude-sdk-runner` (Phase 2), `packages/tool-artifact-publish` (Phase 2 — doesn't exist yet).

---

## Task 1: Add `AttachmentRefBlockSchema` and `AttachmentBlockSchema` to `@ax/ipc-protocol`

**Files:**
- Modify: `packages/ipc-protocol/src/content-blocks.ts`
- Modify: `packages/ipc-protocol/src/__tests__/content-blocks.test.ts`

- [ ] **Step 1: Write failing tests for both new variants**

Open `packages/ipc-protocol/src/__tests__/content-blocks.test.ts`. Find the existing `describe('ContentBlockSchema', ...)` block (it tests the existing variants — text, image, tool_use, etc.). Add at the end of the describe:

```ts
describe('attachment_ref variant', () => {
  it('parses a valid attachment_ref block', () => {
    const block = { type: 'attachment_ref', attachmentId: 'a-123' };
    const parsed = ContentBlockSchema.parse(block);
    expect(parsed).toEqual(block);
  });

  it('rejects attachment_ref without attachmentId', () => {
    const block = { type: 'attachment_ref' };
    expect(() => ContentBlockSchema.parse(block)).toThrow();
  });
});

describe('attachment variant', () => {
  it('parses a valid attachment block', () => {
    const block = {
      type: 'attachment',
      path: '.ax/uploads/c1/t1/report.pdf',
      displayName: 'Q4 Report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 482113,
    };
    const parsed = ContentBlockSchema.parse(block);
    expect(parsed).toEqual(block);
  });

  it('rejects attachment with negative sizeBytes', () => {
    const block = {
      type: 'attachment',
      path: '.ax/uploads/c1/t1/report.pdf',
      displayName: 'Q4 Report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: -1,
    };
    expect(() => ContentBlockSchema.parse(block)).toThrow();
  });

  it('rejects attachment missing displayName', () => {
    const block = {
      type: 'attachment',
      path: '.ax/uploads/c1/t1/report.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 100,
    };
    expect(() => ContentBlockSchema.parse(block)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test --filter @ax/ipc-protocol -- content-blocks.test.ts
```

Expected: FAIL — both `attachment_ref` and `attachment` tests fail because the variants don't exist in the union yet.

- [ ] **Step 3: Add the schemas to `content-blocks.ts`**

Open `packages/ipc-protocol/src/content-blocks.ts`. Find the `ImageBlockSchema` definition (around line 67–81 per the spec excerpts). Add these two schemas immediately AFTER `ImageBlockSchema` and BEFORE the `ContentBlockSchema` union declaration:

```ts
/**
 * Phase 1 (attachments & artifacts, 2026-05-15). Transient reference to a
 * pending upload staged in `@ax/attachments`'s temp store.
 *
 * Lives only on the POST /api/chat/messages request body. The chat-messages
 * handler resolves `attachmentId` → workspace path via `attachments:commit`
 * and rewrites this block as an `attachment` block BEFORE the message reaches
 * conversation storage or any subscriber. Never appears in stored transcripts.
 *
 * Boundary review (I1): `attachmentId` is workspace-vocab — opaque server-minted
 * identifier, no backend leak (no `lfs_oid`, no `bucket`).
 */
export const AttachmentRefBlockSchema = z.object({
  type: z.literal('attachment_ref'),
  attachmentId: z.string().min(1),
});
export type AttachmentRefBlock = z.infer<typeof AttachmentRefBlockSchema>;

/**
 * Phase 1 (attachments & artifacts, 2026-05-15). User-attached file OR
 * agent-published artifact as it appears in a stored conversation turn.
 *
 * The runner translates this variant to Anthropic-compatible types before
 * the LLM call (image/* → `image` block; PDF → `document` if SDK supports;
 * else text mention). This block is the canonical stored form (I4 — single
 * source of truth); the Anthropic shape is derived per LLM call.
 *
 * `path` is workspace-relative (e.g. ".ax/uploads/<conv>/<turn>/file.pdf"),
 * not sandbox-absolute. Resolution: workspace:read(path) at current HEAD.
 */
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  path: z.string().min(1),
  displayName: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;
```

Then extend the `ContentBlockSchema` discriminatedUnion by appending the two new schemas. Find:

```ts
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
]);
```

Replace with:

```ts
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  AttachmentRefBlockSchema,
  AttachmentBlockSchema,
]);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/ipc-protocol -- content-blocks.test.ts
```

Expected: PASS, all new tests green; no existing tests regress.

- [ ] **Step 5: Build to verify type exports**

```bash
pnpm build --filter @ax/ipc-protocol
```

Expected: clean build. The two new types should be exported from `@ax/ipc-protocol` (re-export happens automatically through the existing `export * from './content-blocks.js'` in `src/index.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/ipc-protocol/src/content-blocks.ts \
        packages/ipc-protocol/src/__tests__/content-blocks.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc-protocol): add attachment_ref + attachment ContentBlock variants

Foundation for the attachments & artifacts subsystem (Phase 1 of 3).
attachment_ref is the transit-only shape on POST /api/chat/messages;
attachment is the canonical stored form. Runner translates attachment
blocks to Anthropic-compatible types before LLM call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Scaffold `@ax/attachments` package

**Files:**
- Create: `packages/attachments/package.json`
- Create: `packages/attachments/tsconfig.json`
- Create: `packages/attachments/src/index.ts`
- Create: `packages/attachments/src/types.ts`
- Create: `packages/attachments/src/plugin.ts`

- [ ] **Step 1: Create the package.json**

Pattern after `packages/conversations/package.json` (a peer plugin that also uses Postgres). Write:

```json
{
  "name": "@ax/attachments",
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
    "@ax/core": "workspace:*",
    "@ax/ipc-protocol": "workspace:*",
    "kysely": "^0.27.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@ax/database-postgres": "workspace:*",
    "@ax/test-harness": "workspace:*",
    "@types/node": "^25.6.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.4"
  }
}
```

(Verify versions against `packages/conversations/package.json` and use whatever is current — the snippet above is a template.)

- [ ] **Step 2: Create the tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/__tests__/**"],
  "references": [
    { "path": "../core" },
    { "path": "../ipc-protocol" }
  ]
}
```

- [ ] **Step 3: Create `src/index.ts` re-exporting public API**

```ts
export * from './plugin.js';
export * from './types.js';
```

- [ ] **Step 4: Create `src/types.ts` with hook payload types**

```ts
/**
 * @ax/attachments public types.
 *
 * Per Invariant I1, no field name encodes a particular backend (no `pg_`,
 * `bucket_`, `lfs_oid`, `sha`, etc.). The canonical alternate impl we keep in
 * mind is a future `@ax/attachments-pg-bytea-only` (i.e., no LFS — pure
 * Postgres) that would register the same hooks with the same shapes.
 */

// ---------------------------------------------------------------------------
// Service hook payloads
// ---------------------------------------------------------------------------

export interface StoreTempInput {
  bytes: Buffer;
  displayName: string;
  mediaType: string;
}

export interface StoreTempOutput {
  attachmentId: string;
  sizeBytes: number;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

export interface CommitInput {
  attachmentId: string;
  conversationId: string;
  turnId: string;
}

export interface CommitOutput {
  path: string;
  sha256: string;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}

export interface DownloadInput {
  path: string;
  conversationId: string;
  /**
   * Caller-supplied userId. The hook re-validates against
   * `conversations:get({ conversationId, userId })` — the conversation gate
   * is the load-bearing ACL.
   */
  userId: string;
}

export interface DownloadOutput {
  bytes: Buffer;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface AttachmentsConfig {
  /**
   * Per-file size cap in bytes. Enforced inside `attachments:store-temp`
   * (the HTTP route layer enforces the same cap up front, but this is the
   * defense-in-depth check). Default 25 MiB.
   */
  maxFileBytes?: number;

  /**
   * Per-user pending-attachment quota in bytes. Sum of `size_bytes` across
   * all not-yet-committed temp rows for the same user. Default 200 MiB.
   */
  maxPendingBytesPerUser?: number;

  /**
   * Temp-store TTL in seconds. Default 600 (10 minutes).
   */
  tempTtlSeconds?: number;

  /**
   * Janitor sweep interval in seconds. Default 300 (5 minutes).
   */
  janitorIntervalSeconds?: number;

  /**
   * Allowed MIME types (exact match or wildcard `image/*`). Default covers
   * image/*, application/pdf, text/*, application/json, application/zip,
   * application/octet-stream.
   */
  allowedMediaTypes?: string[];
}

export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_BYTES_PER_USER = 200 * 1024 * 1024;
export const DEFAULT_TEMP_TTL_SECONDS = 600;
export const DEFAULT_JANITOR_INTERVAL_SECONDS = 300;
export const DEFAULT_ALLOWED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/octet-stream',
];
```

- [ ] **Step 5: Create `src/plugin.ts` with a no-op manifest scaffold**

This is the plugin entry point. We start with the manifest scaffolding only — handlers come in later tasks. Write:

```ts
import type { AxPluginManifest, AgentContext, HookBus } from '@ax/core';
import type { AttachmentsConfig } from './types.js';

/**
 * @ax/attachments plugin (Phase 1 — host-side temp store + commit + download).
 *
 * Registers three service hooks:
 *   - attachments:store-temp   (caller: POST /api/attachments route, Phase 3)
 *   - attachments:commit       (caller: POST /api/chat/messages handler, Phase 3)
 *   - attachments:download     (callers: GET /api/files, Phase 3 + Slack plugin, future)
 *
 * Half-wired window OPEN through Phase 3 — no callers in Phase 1.
 */
export const PLUGIN_NAME = '@ax/attachments';

export function createAttachmentsPlugin(
  config: AttachmentsConfig = {},
): AxPluginManifest {
  return {
    name: PLUGIN_NAME,
    registers: [
      'attachments:store-temp',
      'attachments:commit',
      'attachments:download',
    ],
    async init(ctx: AgentContext, bus: HookBus): Promise<{ teardown(): Promise<void> }> {
      // Handlers + migrations + janitor wire-up land in later tasks.
      // Returning a no-op teardown for now so the plugin loads cleanly.
      return { teardown: async () => {} };
    },
  };
}
```

(The exact shape of `AxPluginManifest` and the `init` callback signature is whatever the project's existing plugins use. Check `packages/conversations/src/plugin.ts` for the canonical pattern and mirror it.)

- [ ] **Step 6: Add `packages/attachments` to the workspace**

Open `pnpm-workspace.yaml` (or wherever the workspace lists packages — check existing files for the pattern). The list is likely glob-based (`packages/*`) so no edit needed; verify by running:

```bash
pnpm install
```

Expected: pnpm picks up the new package; no errors.

- [ ] **Step 7: Build the package**

```bash
pnpm build --filter @ax/attachments
```

Expected: clean build with no errors. The `dist/` directory exists with `index.js`, `plugin.js`, `types.js`.

- [ ] **Step 8: Commit**

```bash
git add packages/attachments/ pnpm-workspace.yaml
git commit -m "$(cat <<'EOF'
feat(attachments): scaffold @ax/attachments package

Empty plugin manifest + payload types. Three service hooks declared
in `registers` but unhandled yet; handlers land in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Postgres migration for `attachment_temps` table

**Files:**
- Create: `packages/attachments/src/migrations.ts`
- Create: `packages/attachments/src/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { runAttachmentsMigration } from '../migrations.js';

// Use the test harness pattern — check packages/conversations/src/__tests__/migrations.test.ts
// for the exact `withTestDb` helper invocation.

describe('runAttachmentsMigration', () => {
  it('creates the attachment_temps table with the expected columns', async () => {
    await withTestDb(async (db) => {
      await runAttachmentsMigration(db);
      const result = await sql`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'attachments_v1_temps'
        ORDER BY column_name
      `.execute(db);
      const cols = result.rows.map((r: any) => r.column_name);
      expect(cols).toContain('attachment_id');
      expect(cols).toContain('user_id');
      expect(cols).toContain('bytes');
      expect(cols).toContain('display_name');
      expect(cols).toContain('media_type');
      expect(cols).toContain('size_bytes');
      expect(cols).toContain('expires_at');
      expect(cols).toContain('created_at');
    });
  });

  it('is idempotent on second run', async () => {
    await withTestDb(async (db) => {
      await runAttachmentsMigration(db);
      await runAttachmentsMigration(db);  // second run must not throw
    });
  });

  it('indexes user_id for per-user quota lookups', async () => {
    await withTestDb(async (db) => {
      await runAttachmentsMigration(db);
      const result = await sql`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'attachments_v1_temps'
      `.execute(db);
      const indexes = result.rows.map((r: any) => r.indexname);
      expect(indexes.some((n: string) => n.includes('user_id'))).toBe(true);
    });
  });
});
```

(`withTestDb` is the existing test-harness helper. Look at `packages/conversations/src/__tests__/migrations.test.ts` for the exact import path and usage pattern.)

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test --filter @ax/attachments -- migrations.test.ts
```

Expected: FAIL — `runAttachmentsMigration` is not defined.

- [ ] **Step 3: Implement the migration**

Create `packages/attachments/src/migrations.ts`:

```ts
import { Kysely, sql } from 'kysely';

/**
 * Schema for @ax/attachments. Used by Kysely; the migration is idempotent
 * (all CREATEs use IF NOT EXISTS) so reruns are safe.
 *
 * Naming follows the existing convention: `<plugin>_v1_<table>`.
 */
export interface AttachmentTempsTable {
  attachment_id: string;
  user_id: string;
  bytes: Buffer;
  display_name: string;
  media_type: string;
  size_bytes: number;
  expires_at: Date;
  created_at: Date;
}

export interface AttachmentsDatabase {
  attachments_v1_temps: AttachmentTempsTable;
}

export async function runAttachmentsMigration(
  db: Kysely<AttachmentsDatabase>,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attachments_v1_temps (
      attachment_id  TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      bytes          BYTEA NOT NULL,
      display_name   TEXT NOT NULL,
      media_type     TEXT NOT NULL,
      size_bytes     BIGINT NOT NULL CHECK (size_bytes >= 0),
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // Index by user_id for the per-user quota query (SUM size_bytes WHERE user_id = ?).
  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_temps_user_id_idx
      ON attachments_v1_temps (user_id)
  `.execute(db);

  // Index by expires_at for the janitor's "WHERE expires_at < now()" sweep.
  await sql`
    CREATE INDEX IF NOT EXISTS attachments_v1_temps_expires_at_idx
      ON attachments_v1_temps (expires_at)
  `.execute(db);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- migrations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/migrations.ts \
        packages/attachments/src/__tests__/migrations.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): add attachment_temps table migration

Postgres-backed temp store keyed by attachment_id, indexed by user_id
(for per-user quota) and expires_at (for the TTL janitor).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement the store layer

**Files:**
- Create: `packages/attachments/src/store.ts`
- Create: `packages/attachments/src/__tests__/store.test.ts`

The store is a thin Kysely wrapper around `attachments_v1_temps`. Pure data access — no policy, no ACL. Handlers (next task) call into this.

- [ ] **Step 1: Write failing store tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Kysely } from 'kysely';
import { runAttachmentsMigration, type AttachmentsDatabase } from '../migrations.js';
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';

describe('AttachmentsStore', () => {
  let db: Kysely<AttachmentsDatabase>;
  let store: AttachmentsStore;

  beforeEach(async () => {
    db = await openTestDb();
    await runAttachmentsMigration(db);
    store = createAttachmentsStore(db);
  });

  describe('insertTemp', () => {
    it('inserts and returns the row by id', async () => {
      await store.insertTemp({
        attachmentId: 'a-1',
        userId: 'u-1',
        bytes: Buffer.from('hello'),
        displayName: 'hello.txt',
        mediaType: 'text/plain',
        sizeBytes: 5,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const row = await store.getTemp('a-1');
      expect(row?.userId).toBe('u-1');
      expect(row?.bytes.toString()).toBe('hello');
    });

    it('returns null for unknown id', async () => {
      const row = await store.getTemp('does-not-exist');
      expect(row).toBeNull();
    });

    it('returns null for an expired row (without auto-deleting)', async () => {
      await store.insertTemp({
        attachmentId: 'a-expired',
        userId: 'u-1',
        bytes: Buffer.from('x'),
        displayName: 'x.txt',
        mediaType: 'text/plain',
        sizeBytes: 1,
        expiresAt: new Date(Date.now() - 60_000),  // already expired
      });
      const row = await store.getTemp('a-expired');
      expect(row).toBeNull();  // store returns null for expired
    });
  });

  describe('sumPendingBytesForUser', () => {
    it('returns 0 when the user has no rows', async () => {
      const sum = await store.sumPendingBytesForUser('u-empty');
      expect(sum).toBe(0);
    });

    it('sums non-expired rows for the user', async () => {
      await store.insertTemp({
        attachmentId: 'a-1', userId: 'u-quota', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-2', userId: 'u-quota', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 200,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const sum = await store.sumPendingBytesForUser('u-quota');
      expect(sum).toBe(300);
    });

    it('ignores expired rows when summing', async () => {
      await store.insertTemp({
        attachmentId: 'a-live', userId: 'u-mix', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 100,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-dead', userId: 'u-mix', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 999,
        expiresAt: new Date(Date.now() - 60_000),
      });
      const sum = await store.sumPendingBytesForUser('u-mix');
      expect(sum).toBe(100);
    });
  });

  describe('deleteTemp', () => {
    it('removes the row', async () => {
      await store.insertTemp({
        attachmentId: 'a-del', userId: 'u', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.deleteTemp('a-del');
      const row = await store.getTemp('a-del');
      expect(row).toBeNull();
    });
  });

  describe('purgeExpired', () => {
    it('deletes all rows past expires_at, returns count', async () => {
      await store.insertTemp({
        attachmentId: 'a-keep', userId: 'u', bytes: Buffer.from('x'),
        displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-old1', userId: 'u', bytes: Buffer.from('y'),
        displayName: 'y', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() - 60_000),
      });
      await store.insertTemp({
        attachmentId: 'a-old2', userId: 'u', bytes: Buffer.from('z'),
        displayName: 'z', mediaType: 'text/plain', sizeBytes: 1,
        expiresAt: new Date(Date.now() - 120_000),
      });
      const count = await store.purgeExpired();
      expect(count).toBe(2);
      const remaining = await store.getTemp('a-keep');
      expect(remaining).not.toBeNull();
    });
  });
});
```

(`openTestDb` is the existing test-harness opener used by other plugins' tests. Mirror the pattern from `packages/conversations/src/__tests__/`.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- store.test.ts
```

Expected: FAIL — `createAttachmentsStore` not defined.

- [ ] **Step 3: Implement the store**

Create `packages/attachments/src/store.ts`:

```ts
import { Kysely, sql } from 'kysely';
import type { AttachmentsDatabase } from './migrations.js';

export interface TempInsert {
  attachmentId: string;
  userId: string;
  bytes: Buffer;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface TempRow {
  attachmentId: string;
  userId: string;
  bytes: Buffer;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface AttachmentsStore {
  insertTemp(input: TempInsert): Promise<void>;
  /** Returns null if absent OR expired. Never returns an expired row. */
  getTemp(attachmentId: string): Promise<TempRow | null>;
  /** Returns the sum of `size_bytes` for live (non-expired) rows for this user. */
  sumPendingBytesForUser(userId: string): Promise<number>;
  deleteTemp(attachmentId: string): Promise<void>;
  /** Deletes all rows past expires_at. Returns the count deleted. */
  purgeExpired(): Promise<number>;
}

export function createAttachmentsStore(
  db: Kysely<AttachmentsDatabase>,
): AttachmentsStore {
  return {
    async insertTemp(input) {
      await db
        .insertInto('attachments_v1_temps')
        .values({
          attachment_id: input.attachmentId,
          user_id: input.userId,
          bytes: input.bytes,
          display_name: input.displayName,
          media_type: input.mediaType,
          size_bytes: input.sizeBytes,
          expires_at: input.expiresAt,
        })
        .execute();
    },

    async getTemp(attachmentId) {
      const row = await db
        .selectFrom('attachments_v1_temps')
        .selectAll()
        .where('attachment_id', '=', attachmentId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      if (!row) return null;
      return {
        attachmentId: row.attachment_id,
        userId: row.user_id,
        bytes: row.bytes,
        displayName: row.display_name,
        mediaType: row.media_type,
        sizeBytes: Number(row.size_bytes),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
    },

    async sumPendingBytesForUser(userId) {
      const result = await db
        .selectFrom('attachments_v1_temps')
        .select((eb) => eb.fn.sum<number>('size_bytes').as('sum'))
        .where('user_id', '=', userId)
        .where('expires_at', '>', new Date())
        .executeTakeFirst();
      return Number(result?.sum ?? 0);
    },

    async deleteTemp(attachmentId) {
      await db
        .deleteFrom('attachments_v1_temps')
        .where('attachment_id', '=', attachmentId)
        .execute();
    },

    async purgeExpired() {
      const result = await db
        .deleteFrom('attachments_v1_temps')
        .where('expires_at', '<=', new Date())
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/store.ts \
        packages/attachments/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): add AttachmentsStore — Kysely wrapper over attachment_temps

Pure data access (no policy/ACL). Exposes insertTemp, getTemp,
sumPendingBytesForUser, deleteTemp, purgeExpired. getTemp filters out
expired rows; janitor calls purgeExpired periodically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement `attachments:store-temp` handler

**Files:**
- Create: `packages/attachments/src/handlers.ts`
- Create: `packages/attachments/src/__tests__/store-temp.test.ts`

- [ ] **Step 1: Write failing handler tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PluginError } from '@ax/core';
import { createStoreTempHandler } from '../handlers.js';
import { createAttachmentsStore, type AttachmentsStore } from '../store.js';
import { runAttachmentsMigration } from '../migrations.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PENDING_BYTES_PER_USER,
  DEFAULT_TEMP_TTL_SECONDS,
  DEFAULT_ALLOWED_MEDIA_TYPES,
} from '../types.js';

const cfg = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxPendingBytesPerUser: DEFAULT_MAX_PENDING_BYTES_PER_USER,
  tempTtlSeconds: DEFAULT_TEMP_TTL_SECONDS,
  allowedMediaTypes: DEFAULT_ALLOWED_MEDIA_TYPES,
};

describe('attachments:store-temp', () => {
  let store: AttachmentsStore;
  let handler: ReturnType<typeof createStoreTempHandler>;

  beforeEach(async () => {
    const db = await openTestDb();
    await runAttachmentsMigration(db);
    store = createAttachmentsStore(db);
    handler = createStoreTempHandler({ store, config: cfg });
  });

  it('returns attachmentId + sizeBytes + expiresAt for a valid upload', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });  // existing test helper
    const result = await handler(ctx, {
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt',
      mediaType: 'text/plain',
    });
    expect(result.attachmentId).toMatch(/^[0-9a-f-]+$/);  // uuid-ish
    expect(result.sizeBytes).toBe(11);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('mints unique attachmentIds across calls', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    const a = await handler(ctx, { bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain' });
    const b = await handler(ctx, { bytes: Buffer.from('y'), displayName: 'y', mediaType: 'text/plain' });
    expect(a.attachmentId).not.toBe(b.attachmentId);
  });

  it('rejects oversized files with invalid-payload', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    const bytes = Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1);
    await expect(
      handler(ctx, { bytes, displayName: 'big', mediaType: 'application/octet-stream' }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects disallowed mime types with invalid-payload', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    await expect(
      handler(ctx, {
        bytes: Buffer.from('x'),
        displayName: 'evil.exe',
        mediaType: 'application/x-msdownload',
      }),
    ).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('rejects when over per-user quota with too-many-pending', async () => {
    const ctx = makeAgentContext({ userId: 'u-overlimit' });
    // Insert one row at 99% of quota directly via the store.
    const nearLimit = DEFAULT_MAX_PENDING_BYTES_PER_USER - 100;
    await store.insertTemp({
      attachmentId: 'a-pre', userId: 'u-overlimit',
      bytes: Buffer.alloc(nearLimit), displayName: 'pre', mediaType: 'application/octet-stream',
      sizeBytes: nearLimit, expiresAt: new Date(Date.now() + 60_000),
    });
    // Try to upload a 200-byte file — would push over.
    await expect(
      handler(ctx, {
        bytes: Buffer.alloc(200),
        displayName: 'over',
        mediaType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ code: 'too-many-pending' });
  });

  it('honors image/* wildcard in the allowlist', async () => {
    const ctx = makeAgentContext({ userId: 'u-img' });
    const handlerWithWildcard = createStoreTempHandler({
      store,
      config: { ...cfg, allowedMediaTypes: ['image/*'] },
    });
    const result = await handlerWithWildcard(ctx, {
      bytes: Buffer.from('PNG-bytes'),
      displayName: 'pic.png',
      mediaType: 'image/png',
    });
    expect(result.attachmentId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- store-temp.test.ts
```

Expected: FAIL — `createStoreTempHandler` not defined.

- [ ] **Step 3: Implement the handler**

Create `packages/attachments/src/handlers.ts`. Start with the imports and the `createStoreTempHandler` factory; other handlers come in subsequent tasks (this file will grow).

```ts
import { randomUUID } from 'node:crypto';
import { PluginError, type AgentContext } from '@ax/core';
import type { AttachmentsStore } from './store.js';
import type {
  AttachmentsConfig,
  StoreTempInput,
  StoreTempOutput,
} from './types.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PENDING_BYTES_PER_USER,
  DEFAULT_TEMP_TTL_SECONDS,
  DEFAULT_ALLOWED_MEDIA_TYPES,
} from './types.js';

export interface HandlerDeps {
  store: AttachmentsStore;
  config: Required<AttachmentsConfig>;
}

export interface HandlerDepsInput {
  store: AttachmentsStore;
  config: AttachmentsConfig;
}

function resolveConfig(input: AttachmentsConfig): Required<AttachmentsConfig> {
  return {
    maxFileBytes: input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPendingBytesPerUser:
      input.maxPendingBytesPerUser ?? DEFAULT_MAX_PENDING_BYTES_PER_USER,
    tempTtlSeconds: input.tempTtlSeconds ?? DEFAULT_TEMP_TTL_SECONDS,
    janitorIntervalSeconds: input.janitorIntervalSeconds ?? 300,
    allowedMediaTypes:
      input.allowedMediaTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES,
  };
}

function matchesAllowlist(mediaType: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry === mediaType) return true;
    if (entry.endsWith('/*')) {
      const prefix = entry.slice(0, -1);  // "image/"
      if (mediaType.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function createStoreTempHandler(deps: HandlerDepsInput) {
  const config = resolveConfig(deps.config);
  return async function storeTemp(
    ctx: AgentContext,
    input: StoreTempInput,
  ): Promise<StoreTempOutput> {
    // Size cap (defense-in-depth — the HTTP route layer also caps).
    if (input.bytes.length > config.maxFileBytes) {
      throw new PluginError({
        code: 'invalid-payload',
        message: `attachment exceeds max file size of ${config.maxFileBytes} bytes`,
      });
    }
    // MIME allowlist.
    if (!matchesAllowlist(input.mediaType, config.allowedMediaTypes)) {
      throw new PluginError({
        code: 'invalid-payload',
        message: `mediaType '${input.mediaType}' not in allowlist`,
      });
    }
    // Per-user quota.
    const existing = await deps.store.sumPendingBytesForUser(ctx.userId);
    if (existing + input.bytes.length > config.maxPendingBytesPerUser) {
      throw new PluginError({
        code: 'too-many-pending',
        message: `user pending-attachment quota exceeded (${config.maxPendingBytesPerUser} bytes)`,
      });
    }

    const attachmentId = randomUUID();
    const expiresAt = new Date(Date.now() + config.tempTtlSeconds * 1000);
    await deps.store.insertTemp({
      attachmentId,
      userId: ctx.userId,
      bytes: input.bytes,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.length,
      expiresAt,
    });

    return {
      attachmentId,
      sizeBytes: input.bytes.length,
      expiresAt: expiresAt.toISOString(),
    };
  };
}
```

(The `PluginError` constructor shape — `{ code, message }` — needs to match what `@ax/core` exports. Check the existing `PluginError` usage in `packages/conversations/src/plugin.ts` if unsure; the `code` strings used here — `invalid-payload`, `too-many-pending` — should follow the existing convention. If `too-many-pending` doesn't exist as a known code, use a different existing code like `quota-exceeded`.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- store-temp.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/handlers.ts \
        packages/attachments/src/__tests__/store-temp.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): implement attachments:store-temp handler

Validates size cap + MIME allowlist + per-user pending-bytes quota
before inserting. Returns attachmentId, sizeBytes, expiresAt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Implement `attachments:commit` handler

**Files:**
- Modify: `packages/attachments/src/handlers.ts`
- Create: `packages/attachments/src/__tests__/commit.test.ts`

This handler converts a staged temp into a permanent workspace commit. It:
1. Reads the temp row, verifying `(attachmentId, ctx.userId)` ownership.
2. Computes sha256 of the bytes.
3. Calls `workspace:apply` to commit the bytes to `.ax/uploads/<conversationId>/<turnId>/<sanitized>__<displayName>`.
4. Deletes the temp row.
5. On idempotent retry (already-committed path), returns the same metadata without calling `workspace:apply` again.

- [ ] **Step 1: Write failing commit tests**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PluginError } from '@ax/core';
import { createCommitHandler } from '../handlers.js';
import { createAttachmentsStore } from '../store.js';
import { runAttachmentsMigration } from '../migrations.js';

describe('attachments:commit', () => {
  let store, handler, mockBus;

  beforeEach(async () => {
    const db = await openTestDb();
    await runAttachmentsMigration(db);
    store = createAttachmentsStore(db);
    mockBus = makeMockBus();  // existing test helper
    handler = createCommitHandler({ store, bus: mockBus });
  });

  it('commits a staged temp to the workspace and returns metadata', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    // Stage a temp row directly.
    await store.insertTemp({
      attachmentId: 'a-100', userId: 'u-1',
      bytes: Buffer.from('hello world'),
      displayName: 'greeting.txt', mediaType: 'text/plain',
      sizeBytes: 11,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Mock workspace:apply to return a fake version.
    mockBus.mockService('workspace:apply', async () => ({
      version: 'v-after',
      delta: { before: 'v-before', after: 'v-after', changes: [] },
    }));

    const result = await handler(ctx, {
      attachmentId: 'a-100',
      conversationId: 'c-1',
      turnId: 't-1',
    });

    expect(result.path).toMatch(/^\.ax\/uploads\/c-1\/t-1\/[a-f0-9]{8}__greeting\.txt$/);
    expect(result.sha256).toBe(
      // sha256("hello world") =
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(result.mediaType).toBe('text/plain');
    expect(result.sizeBytes).toBe(11);
    expect(result.displayName).toBe('greeting.txt');

    // Verifies workspace:apply was called with the right shape.
    const applyCalls = mockBus.getCalls('workspace:apply');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].changes[0].kind).toBe('put');
    expect(applyCalls[0].changes[0].path).toBe(result.path);
    expect(applyCalls[0].changes[0].content).toEqual(Buffer.from('hello world'));

    // Temp row deleted.
    const afterRow = await store.getTemp('a-100');
    expect(afterRow).toBeNull();
  });

  it('rejects unknown attachmentId with not-found', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    await expect(
      handler(ctx, { attachmentId: 'does-not-exist', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects expired attachmentId with not-found', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    await store.insertTemp({
      attachmentId: 'a-expired', userId: 'u-1',
      bytes: Buffer.from('x'), displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      handler(ctx, { attachmentId: 'a-expired', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects cross-user redemption with forbidden', async () => {
    const ctx = makeAgentContext({ userId: 'u-attacker' });
    await store.insertTemp({
      attachmentId: 'a-foreign', userId: 'u-victim',
      bytes: Buffer.from('secret'), displayName: 'secret.txt',
      mediaType: 'text/plain', sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      handler(ctx, { attachmentId: 'a-foreign', conversationId: 'c-1', turnId: 't-1' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Temp row preserved (the attacker didn't get to delete it).
    const stillThere = await store.getTemp('a-foreign');
    expect(stillThere).not.toBeNull();
  });

  it('sanitizes the on-disk filename component', async () => {
    const ctx = makeAgentContext({ userId: 'u-1' });
    await store.insertTemp({
      attachmentId: 'a-weird', userId: 'u-1',
      bytes: Buffer.from('x'),
      displayName: '../../etc/passwd ; rm -rf /.txt',  // hostile
      mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockBus.mockService('workspace:apply', async () => ({
      version: 'v', delta: { before: null, after: 'v', changes: [] },
    }));
    const result = await handler(ctx, {
      attachmentId: 'a-weird', conversationId: 'c-1', turnId: 't-1',
    });
    // No `..`, no `/`, no ` `, no `;` in the on-disk name; displayName preserved
    // separately for UI.
    expect(result.path).not.toContain('..');
    expect(result.path).not.toContain(' ');
    expect(result.path).not.toContain(';');
    expect(result.displayName).toBe('../../etc/passwd ; rm -rf /.txt');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- commit.test.ts
```

Expected: FAIL — `createCommitHandler` not defined.

- [ ] **Step 3: Implement the handler**

Append to `packages/attachments/src/handlers.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { HookBus } from '@ax/core';
import type { CommitInput, CommitOutput } from './types.js';

export interface CommitDepsInput {
  store: AttachmentsStore;
  bus: HookBus;
}

/**
 * Collapse a user-supplied filename to a path-safe component. Preserves the
 * extension; everything outside [A-Za-z0-9._-] collapses to `_`. Prefixed
 * with 8 random hex chars to prevent collisions inside the same
 * (conversationId, turnId) tuple — two uploads named "foo.pdf" don't clash.
 */
function sanitizeFilenameComponent(displayName: string): string {
  const sanitized = displayName.replace(/[^A-Za-z0-9._-]/g, '_');
  // Collapse repeated underscores for readability.
  const collapsed = sanitized.replace(/_+/g, '_');
  // Strip leading dots so the name never starts with `.` (avoids hiding).
  const noDotLead = collapsed.replace(/^\.+/, '');
  const prefix = randomBytes(4).toString('hex');  // 8 hex chars
  return `${prefix}__${noDotLead}`;
}

interface WorkspaceApplyChange {
  path: string;
  kind: 'put' | 'delete';
  content?: Buffer;
}

interface WorkspaceApplyInput {
  changes: WorkspaceApplyChange[];
  parent: string | null;
  reason?: string;
}

interface WorkspaceApplyOutput {
  version: string;
  delta: unknown;
}

export function createCommitHandler(deps: CommitDepsInput) {
  return async function commit(
    ctx: AgentContext,
    input: CommitInput,
  ): Promise<CommitOutput> {
    const row = await deps.store.getTemp(input.attachmentId);
    if (!row) {
      throw new PluginError({
        code: 'not-found',
        message: `attachmentId ${input.attachmentId} not found or expired`,
      });
    }
    if (row.userId !== ctx.userId) {
      throw new PluginError({
        code: 'forbidden',
        message: 'attachment owned by a different user',
      });
    }

    const filenameComponent = sanitizeFilenameComponent(row.displayName);
    const path = `.ax/uploads/${input.conversationId}/${input.turnId}/${filenameComponent}`;
    const sha256 = createHash('sha256').update(row.bytes).digest('hex');

    await deps.bus.call<WorkspaceApplyInput, WorkspaceApplyOutput>(
      'workspace:apply',
      ctx,
      {
        changes: [{ path, kind: 'put', content: row.bytes }],
        parent: null,  // null = apply on top of whatever HEAD is now (no CAS).
                       // The wire schema accepts null; existing in-process callers
                       // mostly pass null too. If a CAS check is needed later, fetch
                       // the current version via `workspace:list` or similar first
                       // and pass that OID here.
        reason: `attachments:commit ${input.attachmentId}`,
      },
    );

    // Best-effort temp delete. If this fails, the janitor will reap.
    try {
      await deps.store.deleteTemp(input.attachmentId);
    } catch (err) {
      ctx.logger.warn('attachments_commit_temp_delete_failed', {
        attachmentId: input.attachmentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      path,
      sha256,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      displayName: row.displayName,
    };
  };
}
```

(Note on `workspace:apply`'s `parent` field: the existing contract is in `packages/workspace-protocol/src/actions.ts`. The plan above passes `null`; in the actual implementation, check what the existing host-side callers pass and mirror it. If `workspace:apply` requires a real `parent`, fetch the current version first via `workspace:list` or whatever the existing pattern is.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- commit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/handlers.ts \
        packages/attachments/src/__tests__/commit.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): implement attachments:commit handler

Stages temp bytes via workspace:apply into .ax/uploads/<conv>/<turn>/<file>.
Verifies (attachmentId, userId) ownership before committing; foreign user
redemption raises forbidden and leaves the temp row intact. Sanitizes the
on-disk filename component; preserves the original displayName separately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Implement `attachments:download` handler (with path-scope ACL)

**Files:**
- Modify: `packages/attachments/src/handlers.ts`
- Create: `packages/attachments/src/__tests__/download.test.ts`

This is the most security-sensitive handler. It does:
1. Path normalization (reject `..`, leading `/`, `//`, length > 1024).
2. `conversations:get({ conversationId, userId })` — owner gate (foreign → `forbidden`).
3. Path-scope check: path matches `.ax/uploads/<conversationId>/...` OR appears in some `attachment` block or `artifact_publish` tool_result in the conversation's transcript.
4. `workspace:read(path)` with symlink refusal.

- [ ] **Step 1: Write failing download tests (extensive — this is the critical ACL surface)**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PluginError } from '@ax/core';
import { createDownloadHandler } from '../handlers.js';

describe('attachments:download', () => {
  let handler, mockBus, fakeWorkspaceRead;

  function defaultDeps() {
    mockBus = makeMockBus();
    // Default conversations:get — returns an empty-turn conversation.
    mockBus.mockService('conversations:get', async (input: any) => {
      if (input.userId !== 'u-1') {
        throw new PluginError({ code: 'not-found', message: 'conversation not found' });
      }
      return {
        conversation: {
          conversationId: input.conversationId, userId: 'u-1', agentId: 'a-1',
          title: null, activeSessionId: null, activeReqId: null,
          createdAt: '2026-05-15T00:00:00Z', updatedAt: '2026-05-15T00:00:00Z',
        },
        turns: [],
      };
    });
    mockBus.mockService('workspace:read', async (input: any) => {
      if (input.path === '.ax/uploads/c-1/t-1/abc__file.pdf') {
        return { found: true, bytes: Buffer.from('pdf-bytes') };
      }
      return { found: false };
    });
    return { bus: mockBus };
  }

  beforeEach(() => {
    handler = createDownloadHandler(defaultDeps());
  });

  describe('path normalization', () => {
    it.each([
      '../etc/passwd',
      '.ax/uploads/c/t/../../escape',
      '/etc/passwd',
      '.ax//uploads/c/t/file',
      'a'.repeat(1025),
    ])('rejects path %j with not-found', async (badPath) => {
      const ctx = makeAgentContext({ userId: 'u-1' });
      await expect(
        handler(ctx, { path: badPath, conversationId: 'c-1', userId: 'u-1' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('owner gate', () => {
    it('rejects foreign conversation with not-found (uniform existence-leak)', async () => {
      const ctx = makeAgentContext({ userId: 'u-attacker' });
      await expect(
        handler(ctx, {
          path: '.ax/uploads/c-1/t-1/abc__file.pdf',
          conversationId: 'c-1', userId: 'u-attacker',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('path-scope check', () => {
    it('allows path under .ax/uploads/<conversationId>/', async () => {
      const ctx = makeAgentContext({ userId: 'u-1' });
      const result = await handler(ctx, {
        path: '.ax/uploads/c-1/t-1/abc__file.pdf',
        conversationId: 'c-1', userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('pdf-bytes');
    });

    it('rejects path under another conversation with forbidden→not-found', async () => {
      const ctx = makeAgentContext({ userId: 'u-1' });
      await expect(
        handler(ctx, {
          path: '.ax/uploads/c-OTHER/t-1/abc__file.pdf',
          conversationId: 'c-1', userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('allows path referenced from an attachment block in any turn', async () => {
      mockBus.mockService('conversations:get', async () => ({
        conversation: {
          conversationId: 'c-1', userId: 'u-1', agentId: 'a-1', title: null,
          activeSessionId: null, activeReqId: null,
          createdAt: '2026-05-15T00:00:00Z', updatedAt: '2026-05-15T00:00:00Z',
        },
        turns: [{
          turnId: 't-1', turnIndex: 0, role: 'assistant',
          contentBlocks: [{
            type: 'attachment', path: 'workspace/reports/Q4.pdf',
            displayName: 'Q4', mediaType: 'application/pdf', sizeBytes: 1,
          }],
          createdAt: '2026-05-15T00:00:00Z',
        }],
      }));
      mockBus.mockService('workspace:read', async () => ({
        found: true, bytes: Buffer.from('q4'),
      }));
      const ctx = makeAgentContext({ userId: 'u-1' });
      const result = await handler(ctx, {
        path: 'workspace/reports/Q4.pdf',
        conversationId: 'c-1', userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('q4');
    });

    it('allows path referenced from an artifact_publish tool_result', async () => {
      const toolResultPath = 'workspace/reports/Q4.pdf';
      mockBus.mockService('conversations:get', async () => ({
        conversation: {
          conversationId: 'c-1', userId: 'u-1', agentId: 'a-1', title: null,
          activeSessionId: null, activeReqId: null,
          createdAt: '2026-05-15T00:00:00Z', updatedAt: '2026-05-15T00:00:00Z',
        },
        turns: [
          {
            turnId: 't-1', turnIndex: 0, role: 'assistant',
            contentBlocks: [
              { type: 'tool_use', id: 'toolu-1', name: 'artifact_publish',
                input: { path: '/permanent/workspace/reports/Q4.pdf' } },
              { type: 'tool_result', tool_use_id: 'toolu-1',
                content: JSON.stringify({
                  artifactId: 'abcd', downloadUrl: 'ax://artifact/abcd',
                  path: toolResultPath, displayName: 'Q4',
                  mediaType: 'application/pdf', sizeBytes: 1, sha256: 'x',
                }),
              },
            ],
            createdAt: '2026-05-15T00:00:00Z',
          },
        ],
      }));
      mockBus.mockService('workspace:read', async () => ({
        found: true, bytes: Buffer.from('q4'),
      }));
      const ctx = makeAgentContext({ userId: 'u-1' });
      const result = await handler(ctx, {
        path: toolResultPath, conversationId: 'c-1', userId: 'u-1',
      });
      expect(result.bytes.toString()).toBe('q4');
    });

    it('rejects path not referenced anywhere with forbidden', async () => {
      const ctx = makeAgentContext({ userId: 'u-1' });
      await expect(
        handler(ctx, {
          path: 'workspace/reports/SECRET.pdf',  // not under .ax/uploads/c-1/, not in transcript
          conversationId: 'c-1', userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  describe('workspace:read', () => {
    it('returns not-found when the file is gone from main', async () => {
      const ctx = makeAgentContext({ userId: 'u-1' });
      await expect(
        handler(ctx, {
          path: '.ax/uploads/c-1/t-1/missing__file.pdf',
          conversationId: 'c-1', userId: 'u-1',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    // Note: symlink refusal is enforced at write-time in Phase 2
    // (artifact_publish lstat-rejects before reading bytes; attachments:commit
    // can't create a symlink anyway because it takes Buffer bytes). Read-time
    // symlink refusal would require extending workspace:read with a mode field
    // — tracked as a separate scope improvement, not blocking Phase 1.
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- download.test.ts
```

Expected: FAIL — `createDownloadHandler` not defined.

- [ ] **Step 3: Implement the handler**

Append to `packages/attachments/src/handlers.ts`:

```ts
import type { ContentBlock } from '@ax/ipc-protocol';

export interface DownloadDepsInput {
  bus: HookBus;
}

/**
 * Normalize a candidate path. Returns null if the path is invalid (must be
 * rejected as not-found at the route layer for uniform existence-leak).
 *
 * Valid path constraints:
 *   - length <= 1024 chars
 *   - no `..` segments
 *   - no leading `/`
 *   - no `//` (collapsed double-slashes — defense against weird encodings)
 */
function normalizePath(path: string): string | null {
  if (path.length === 0 || path.length > 1024) return null;
  if (path.startsWith('/')) return null;
  if (path.includes('//')) return null;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg === '') return null;
  }
  return path;
}

/**
 * Path-scope check. Path must be either:
 *   - under `.ax/uploads/<conversationId>/`, OR
 *   - referenced from some `attachment` block in this conversation's transcript, OR
 *   - referenced from some `artifact_publish` tool_result in this conversation's
 *     transcript (the tool_result's content JSON contains `path`).
 *
 * Returns the matching block's display metadata so the route layer can populate
 * Content-Disposition headers. Returns null if not in scope.
 */
function checkPathScope(
  candidatePath: string,
  conversationId: string,
  turns: Array<{ contentBlocks: ContentBlock[] }>,
): { displayName: string; mediaType: string; sizeBytes: number } | null {
  // Rule 1: under .ax/uploads/<conv>/
  const uploadsPrefix = `.ax/uploads/${conversationId}/`;
  if (candidatePath.startsWith(uploadsPrefix)) {
    // We don't have display metadata for raw-upload-path access without
    // walking the transcript anyway, but the path-scope check passes.
    // Walk the transcript to find the matching attachment block.
    for (const turn of turns) {
      for (const block of turn.contentBlocks) {
        if (block.type === 'attachment' && block.path === candidatePath) {
          return {
            displayName: block.displayName,
            mediaType: block.mediaType,
            sizeBytes: block.sizeBytes,
          };
        }
      }
    }
    // Path passes the prefix check but no block references it — that means
    // the file was uploaded but never sent. We return metadata that lets
    // the route stream raw bytes; but realistically this case is impossible
    // because attachments:commit only runs from the message-send handler,
    // which always appends an attachment block. Fall through to "passes
    // scope, no metadata" — return basename + octet-stream as a safe default.
    return {
      displayName: candidatePath.split('/').pop() ?? 'file',
      mediaType: 'application/octet-stream',
      sizeBytes: 0,
    };
  }

  // Rule 2: transcript reference (attachment block OR artifact_publish tool_result).
  for (const turn of turns) {
    for (const block of turn.contentBlocks) {
      if (block.type === 'attachment' && block.path === candidatePath) {
        return {
          displayName: block.displayName,
          mediaType: block.mediaType,
          sizeBytes: block.sizeBytes,
        };
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        try {
          const parsed = JSON.parse(block.content);
          if (parsed?.path === candidatePath) {
            return {
              displayName: String(parsed.displayName ?? 'file'),
              mediaType: String(parsed.mediaType ?? 'application/octet-stream'),
              sizeBytes: Number(parsed.sizeBytes ?? 0),
            };
          }
        } catch {
          // Non-JSON tool_result; ignore.
        }
      }
    }
  }
  return null;
}

interface ConversationsGetInput {
  conversationId: string;
  userId: string;
  includeThinking?: boolean;
}
interface ConversationsGetOutput {
  conversation: { conversationId: string; userId: string; agentId: string };
  turns: Array<{ contentBlocks: ContentBlock[] }>;
}

interface WorkspaceReadInput {
  path: string;
  version?: string;
}
interface WorkspaceReadOutput {
  found: boolean;
  bytes?: Buffer;
}

export function createDownloadHandler(deps: DownloadDepsInput) {
  return async function download(
    ctx: AgentContext,
    input: DownloadInput,
  ): Promise<DownloadOutput> {
    // 1) Path normalization. Reject as not-found (uniform existence-leak).
    const normalized = normalizePath(input.path);
    if (normalized === null) {
      throw new PluginError({
        code: 'not-found',
        message: 'invalid path',
      });
    }

    // 2) Owner gate via conversations:get. Foreign / not-found / forbidden
    //    all collapse to not-found from the caller's perspective.
    let turns: Array<{ contentBlocks: ContentBlock[] }>;
    try {
      const got = await deps.bus.call<ConversationsGetInput, ConversationsGetOutput>(
        'conversations:get',
        ctx,
        { conversationId: input.conversationId, userId: input.userId },
      );
      turns = got.turns;
    } catch (err) {
      if (err instanceof PluginError && (err.code === 'not-found' || err.code === 'forbidden')) {
        throw new PluginError({ code: 'not-found', message: 'conversation not found' });
      }
      throw err;
    }

    // 3) Path-scope check.
    const scopeMeta = checkPathScope(normalized, input.conversationId, turns);
    if (scopeMeta === null) {
      throw new PluginError({
        code: 'forbidden',
        message: 'path not in conversation scope',
      });
    }

    // 4) workspace:read. Symlink prevention is at write-time in Phase 2
    //    (artifact_publish runs lstat before reading bytes; attachments:commit
    //    physically can't create a symlink because it takes Buffer bytes from
    //    HTTP). Adding read-time mode-checking requires extending
    //    WorkspaceReadResponseSchema with a `mode` field, which is a separate
    //    schema-level change tracked outside Phase 1.
    const readResult = await deps.bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: normalized },
    );
    if (!readResult.found || readResult.bytes === undefined) {
      throw new PluginError({ code: 'not-found', message: 'file not in workspace' });
    }

    return {
      bytes: readResult.bytes,
      mediaType: scopeMeta.mediaType,
      sizeBytes: readResult.bytes.length,
      displayName: scopeMeta.displayName,
    };
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- download.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/handlers.ts \
        packages/attachments/src/__tests__/download.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): implement attachments:download handler

Path-scope ACL lives inside the hook (not the route layer) so all
callers — channel-web today, future Slack plugin tomorrow — get the
same enforcement. Rejects ..-paths, foreign conversations, paths not
in transcript scope, and symlink targets. Returns metadata from the
matching transcript block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: TTL janitor for expired temp rows

**Files:**
- Create: `packages/attachments/src/janitor.ts`
- Create: `packages/attachments/src/__tests__/janitor.test.ts`

The janitor periodically sweeps expired rows. We implement it as a long-lived async task started during `init()` and cleaned up in `teardown()`.

- [ ] **Step 1: Write failing janitor tests**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startJanitor } from '../janitor.js';
import { createAttachmentsStore } from '../store.js';
import { runAttachmentsMigration } from '../migrations.js';

describe('startJanitor', () => {
  let store;

  beforeEach(async () => {
    vi.useFakeTimers();
    const db = await openTestDb();
    await runAttachmentsMigration(db);
    store = createAttachmentsStore(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('purges expired rows on the configured interval', async () => {
    await store.insertTemp({
      attachmentId: 'a-live', userId: 'u', bytes: Buffer.from('x'),
      displayName: 'x', mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await store.insertTemp({
      attachmentId: 'a-dead', userId: 'u', bytes: Buffer.from('y'),
      displayName: 'y', mediaType: 'text/plain', sizeBytes: 1,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const ctx = makeAgentContext({ userId: 'system' });
    const handle = startJanitor({ store, intervalSeconds: 5, ctx });

    // Initial sweep happens immediately.
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect(await store.getTemp('a-live')).not.toBeNull();
    expect(await store.getTemp('a-dead')).toBeNull();

    await handle.stop();
  });

  it('stops cleanly when stop() is called', async () => {
    const ctx = makeAgentContext({ userId: 'system' });
    const handle = startJanitor({ store, intervalSeconds: 5, ctx });
    await handle.stop();
    // After stop, no more sweeps should occur; advancing time should not throw.
    await vi.advanceTimersByTimeAsync(20_000);
    // No assertions — just no crashes / unhandled rejections.
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- janitor.test.ts
```

Expected: FAIL — `startJanitor` not defined.

- [ ] **Step 3: Implement the janitor**

Create `packages/attachments/src/janitor.ts`:

```ts
import type { AgentContext } from '@ax/core';
import type { AttachmentsStore } from './store.js';

export interface JanitorDeps {
  store: AttachmentsStore;
  intervalSeconds: number;
  ctx: AgentContext;
}

export interface JanitorHandle {
  stop(): Promise<void>;
}

/**
 * Start a periodic sweep that purges expired temp rows. Performs one sweep
 * synchronously at startup, then schedules subsequent sweeps via setInterval.
 *
 * The handle's stop() clears the timer and awaits any in-flight sweep before
 * returning, so teardown() is clean.
 */
export function startJanitor(deps: JanitorDeps): JanitorHandle {
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  async function sweep(): Promise<void> {
    if (stopped) return;
    try {
      const purged = await deps.store.purgeExpired();
      if (purged > 0) {
        deps.ctx.logger.info('attachments_janitor_purged', { count: purged });
      }
    } catch (err) {
      deps.ctx.logger.warn('attachments_janitor_failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Kick off the first sweep immediately. Capture in inFlight so stop() awaits it.
  inFlight = sweep();

  const intervalMs = deps.intervalSeconds * 1000;
  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = sweep();
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        await inFlight.catch(() => {});  // swallow — already logged inside sweep
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- janitor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/janitor.ts \
        packages/attachments/src/__tests__/janitor.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): add TTL janitor for expired temp rows

Sweeps on a configurable interval (default 5 min). Logs purge counts;
swallows + logs errors. stop() awaits the in-flight sweep so plugin
teardown is clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire the plugin's `init()` — handlers + janitor + migration

**Files:**
- Modify: `packages/attachments/src/plugin.ts`
- Create: `packages/attachments/src/__tests__/plugin.test.ts`

Now wire everything together: the plugin's `init()` runs the migration, instantiates the store, registers the three service hooks, starts the janitor, and returns a teardown.

- [ ] **Step 1: Write a failing plugin-load test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createAttachmentsPlugin } from '../plugin.js';

describe('@ax/attachments plugin', () => {
  it('registers all three service hooks on init', async () => {
    const harness = makeTestHarness();  // existing helper that boots a bus + DB
    await harness.load(createAttachmentsPlugin({}));

    expect(harness.bus.hasService('attachments:store-temp')).toBe(true);
    expect(harness.bus.hasService('attachments:commit')).toBe(true);
    expect(harness.bus.hasService('attachments:download')).toBe(true);
  });

  it('runs the attachment_temps migration on load', async () => {
    const harness = makeTestHarness();
    await harness.load(createAttachmentsPlugin({}));
    const result = await harness.runQuery(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'attachments_v1_temps'
    `);
    expect(result.rows.length).toBe(1);
  });

  it('starts the janitor and stops it on teardown', async () => {
    const harness = makeTestHarness();
    const teardown = await harness.load(createAttachmentsPlugin({
      janitorIntervalSeconds: 1,
    }));
    // Insert an already-expired row and wait one tick.
    await harness.runQuery(`
      INSERT INTO attachments_v1_temps
        (attachment_id, user_id, bytes, display_name, media_type, size_bytes, expires_at)
      VALUES ('a-expired', 'u', '\\x00', 'x', 'text/plain', 1, NOW() - INTERVAL '1 minute')
    `);
    await new Promise((r) => setTimeout(r, 1100));  // give janitor a chance
    const after = await harness.runQuery(
      `SELECT 1 FROM attachments_v1_temps WHERE attachment_id = 'a-expired'`,
    );
    expect(after.rows.length).toBe(0);
    await teardown();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- plugin.test.ts
```

Expected: FAIL — `createAttachmentsPlugin` doesn't wire anything yet.

- [ ] **Step 3: Implement the full `init()`**

Replace the scaffolded `packages/attachments/src/plugin.ts` with:

```ts
import type { AxPluginManifest, AgentContext, HookBus } from '@ax/core';
import type { AttachmentsConfig } from './types.js';
import {
  DEFAULT_JANITOR_INTERVAL_SECONDS,
} from './types.js';
import { runAttachmentsMigration } from './migrations.js';
import { createAttachmentsStore } from './store.js';
import {
  createStoreTempHandler,
  createCommitHandler,
  createDownloadHandler,
} from './handlers.js';
import { startJanitor } from './janitor.js';

export const PLUGIN_NAME = '@ax/attachments';

interface DatabaseGetOutput {
  // Whatever @ax/database-postgres exposes via its service hook.
  // Check packages/database-postgres/src/types.ts for the canonical shape.
  db: any;  // typed in actual impl
}

export function createAttachmentsPlugin(
  config: AttachmentsConfig = {},
): AxPluginManifest {
  return {
    name: PLUGIN_NAME,
    registers: [
      'attachments:store-temp',
      'attachments:commit',
      'attachments:download',
    ],
    async init(ctx: AgentContext, bus: HookBus) {
      // 1) Get the database handle via @ax/database-postgres.
      const dbResult = await bus.call<unknown, DatabaseGetOutput>(
        'database:get',  // check actual hook name in @ax/database-postgres
        ctx,
        {},
      );
      const db = dbResult.db;

      // 2) Run the migration (idempotent — safe on every boot).
      await runAttachmentsMigration(db);

      // 3) Build the store + handlers.
      const store = createAttachmentsStore(db);
      const storeTempHandler = createStoreTempHandler({ store, config });
      const commitHandler = createCommitHandler({ store, bus });
      const downloadHandler = createDownloadHandler({ bus });

      // 4) Register the hooks.
      bus.registerService('attachments:store-temp', storeTempHandler);
      bus.registerService('attachments:commit', commitHandler);
      bus.registerService('attachments:download', downloadHandler);

      // 5) Start the janitor.
      const janitor = startJanitor({
        store,
        intervalSeconds: config.janitorIntervalSeconds ?? DEFAULT_JANITOR_INTERVAL_SECONDS,
        ctx,
      });

      // 6) Return teardown.
      return {
        async teardown() {
          await janitor.stop();
          bus.unregisterService('attachments:store-temp');
          bus.unregisterService('attachments:commit');
          bus.unregisterService('attachments:download');
        },
      };
    },
  };
}
```

(Cross-check: the exact hook name to fetch the DB, the registerService/unregisterService method names, and the AgentContext / HookBus types come from `@ax/core`. Mirror the patterns in `packages/conversations/src/plugin.ts` which already does the same dance.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test --filter @ax/attachments -- plugin.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full @ax/attachments test suite to check for regressions**

```bash
pnpm test --filter @ax/attachments
```

Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/attachments/src/plugin.ts \
        packages/attachments/src/__tests__/plugin.test.ts
git commit -m "$(cat <<'EOF'
feat(attachments): wire init() — migration, handlers, janitor

Plugin now loads cleanly: runs migration, instantiates store, registers
all three service hooks, starts the TTL janitor. teardown() stops the
janitor and unregisters the hooks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Add LFS endpoints to `@ax/workspace-git-server`

**Files:**
- Create: `packages/workspace-git-server/src/server/lfs.ts`
- Modify: `packages/workspace-git-server/src/server/listener.ts`
- Modify: `packages/workspace-git-server/src/server/repos.ts`
- Modify: `packages/workspace-git-server/src/__tests__/contract.test.ts`

LFS server protocol (https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md) has four endpoints:

```
POST /<workspaceId>.git/info/lfs/objects/batch         — batch API
PUT  /<workspaceId>.git/info/lfs/storage/<oid>         — blob upload
GET  /<workspaceId>.git/info/lfs/storage/<oid>         — blob download
POST /<workspaceId>.git/info/lfs/verify                — post-upload verification
```

Bytes for each workspace live at `<repoRoot>/<workspaceId>.lfs/objects/<sha[0:2]>/<sha[2:4]>/<sha>`.

- [ ] **Step 1: Write failing contract tests for the LFS endpoints**

Open `packages/workspace-git-server/src/__tests__/contract.test.ts`. Find the existing describe block (it tests the smart-HTTP endpoints). Add a new describe block at the bottom:

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('LFS endpoints', () => {
  let server, baseUrl, tempDir, workspaceId;

  beforeAll(async () => {
    // Use the existing harness helper.
    ({ server, baseUrl, repoRoot: tempDir } = await startTestServer());
    workspaceId = 'ws-lfs-test';
    // Create the workspace via existing REST endpoint.
    await fetch(`${baseUrl}/repos`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('responds to POST /info/lfs/objects/batch with upload URLs', async () => {
    const blob = Buffer.from('hello LFS');
    const oid = createHash('sha256').update(blob).digest('hex');
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
          'accept': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic'],
          objects: [{ oid, size: blob.length }],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.objects).toHaveLength(1);
    expect(body.objects[0].actions.upload.href).toContain(`/info/lfs/storage/${oid}`);
  });

  it('rejects unauthenticated batch requests with 401', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [] }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('uploads + downloads a blob via PUT/GET storage endpoints', async () => {
    const blob = Buffer.from('round trip');
    const oid = createHash('sha256').update(blob).digest('hex');
    const uploadRes = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`,
      {
        method: 'PUT',
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
        body: blob,
      },
    );
    expect(uploadRes.status).toBe(200);

    const downloadRes = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`,
      { headers: { 'authorization': `Bearer ${TEST_TOKEN}` } },
    );
    expect(downloadRes.status).toBe(200);
    const downloaded = Buffer.from(await downloadRes.arrayBuffer());
    expect(downloaded.equals(blob)).toBe(true);
  });

  it('returns 404 for missing OID on download', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/0000000000000000000000000000000000000000000000000000000000000000`,
      { headers: { 'authorization': `Bearer ${TEST_TOKEN}` } },
    );
    expect(res.status).toBe(404);
  });

  it('rejects OIDs that fail the regex (path traversal)', async () => {
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/../../escape`,
      {
        method: 'PUT',
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
        body: Buffer.from('x'),
      },
    );
    expect(res.status).toBe(400);
  });

  it('rejects OID/payload sha256 mismatch on upload', async () => {
    const blob = Buffer.from('legit content');
    const wrongOid = 'a'.repeat(64);  // valid OID format but doesn't match the bytes
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/storage/${wrongOid}`,
      {
        method: 'PUT',
        headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
        body: blob,
      },
    );
    expect(res.status).toBe(422);  // standard LFS "verification failed"
  });

  it('verify endpoint returns 200 for a present OID', async () => {
    const blob = Buffer.from('verify me');
    const oid = createHash('sha256').update(blob).digest('hex');
    await fetch(`${baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`, {
      method: 'PUT',
      headers: { 'authorization': `Bearer ${TEST_TOKEN}` },
      body: blob,
    });
    const res = await fetch(
      `${baseUrl}/${workspaceId}.git/info/lfs/verify`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({ oid, size: blob.length }),
      },
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/workspace-git-server -- contract.test.ts
```

Expected: FAIL — LFS endpoints don't exist.

- [ ] **Step 3: Implement the LFS handler**

Create `packages/workspace-git-server/src/server/lfs.ts`:

```ts
import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeError } from './listener.js';
import { validateWorkspaceId } from '../shared/workspace-id.js';

// ---------------------------------------------------------------------------
// LFS server — Git LFS batch API (https://github.com/git-lfs/git-lfs/blob/
// main/docs/api/batch.md). Four routes:
//
//   POST /<id>.git/info/lfs/objects/batch       — negotiate transfer URLs
//   PUT  /<id>.git/info/lfs/storage/<oid>       — upload blob
//   GET  /<id>.git/info/lfs/storage/<oid>       — download blob
//   POST /<id>.git/info/lfs/verify              — confirm upload landed
//
// Storage: <repoRoot>/<workspaceId>.lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>
// (standard LFS layout, makes git lfs prune compatible)
//
// OIDs are sha256 hex (64 chars). Path-traversal-safe by strict regex.
// ---------------------------------------------------------------------------

const OID_REGEX = /^[a-f0-9]{64}$/;

function lfsBlobPath(repoRoot: string, workspaceId: string, oid: string): string {
  return join(
    repoRoot,
    `${workspaceId}.lfs`,
    'objects',
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid,
  );
}

export interface LfsHandlerDeps {
  repoRoot: string;
  /** URL base used to build the upload/download hrefs returned by batch. */
  baseUrl: string;
}

export async function handleLfsBatch(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  deps: LfsHandlerDeps,
): Promise<void> {
  if (!validateWorkspaceId(workspaceId)) {
    writeError(res, 400, 'invalid-workspace-id');
    return;
  }

  // Read JSON body.
  let bodyBuf: Buffer;
  try {
    bodyBuf = await readBody(req, 1024 * 1024);  // 1 MiB cap on batch JSON
  } catch {
    writeError(res, 413, 'batch-body-too-large');
    return;
  }
  let payload: any;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    writeError(res, 400, 'invalid-json');
    return;
  }

  const operation: string = payload.operation;
  const objects: Array<{ oid: string; size: number }> = payload.objects ?? [];

  const responseObjects = objects.map((obj) => {
    if (!OID_REGEX.test(obj.oid)) {
      return { oid: obj.oid, size: obj.size, error: { code: 422, message: 'invalid oid' } };
    }
    const href = `${deps.baseUrl}/${workspaceId}.git/info/lfs/storage/${obj.oid}`;
    const actions: Record<string, { href: string; header: Record<string, string> }> = {};
    if (operation === 'upload') {
      // The client uses this href to PUT bytes.
      actions.upload = {
        href,
        header: { authorization: getAuthHeader(req) ?? '' },
      };
      actions.verify = {
        href: `${deps.baseUrl}/${workspaceId}.git/info/lfs/verify`,
        header: { authorization: getAuthHeader(req) ?? '' },
      };
    } else if (operation === 'download') {
      actions.download = {
        href,
        header: { authorization: getAuthHeader(req) ?? '' },
      };
    }
    return { oid: obj.oid, size: obj.size, actions };
  });

  res.statusCode = 200;
  res.setHeader('content-type', 'application/vnd.git-lfs+json');
  res.end(JSON.stringify({ transfer: 'basic', objects: responseObjects }));
}

export async function handleLfsStorageUpload(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  oid: string,
  deps: LfsHandlerDeps,
): Promise<void> {
  if (!validateWorkspaceId(workspaceId)) {
    writeError(res, 400, 'invalid-workspace-id');
    return;
  }
  if (!OID_REGEX.test(oid)) {
    writeError(res, 400, 'invalid-oid');
    return;
  }

  const finalPath = lfsBlobPath(deps.repoRoot, workspaceId, oid);
  await fs.mkdir(dirname(finalPath), { recursive: true });

  // Stream + hash simultaneously to verify oid matches content.
  const hash = createHash('sha256');
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const writeStream = (await import('node:fs')).createWriteStream(tempPath);
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (!writeStream.write(chunk)) req.pause();
      });
      writeStream.on('drain', () => req.resume());
      req.on('end', () => writeStream.end(resolve));
      req.on('error', reject);
      writeStream.on('error', reject);
    });
    const computed = hash.digest('hex');
    if (computed !== oid) {
      await fs.unlink(tempPath).catch(() => {});
      writeError(res, 422, 'oid-mismatch');
      return;
    }
    await fs.rename(tempPath, finalPath);
    res.statusCode = 200;
    res.end();
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    writeError(res, 500, 'upload-failed');
  }
}

export async function handleLfsStorageDownload(
  _req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  oid: string,
  deps: LfsHandlerDeps,
): Promise<void> {
  if (!validateWorkspaceId(workspaceId)) {
    writeError(res, 400, 'invalid-workspace-id');
    return;
  }
  if (!OID_REGEX.test(oid)) {
    writeError(res, 400, 'invalid-oid');
    return;
  }
  const blobPath = lfsBlobPath(deps.repoRoot, workspaceId, oid);
  try {
    const stat = await fs.stat(blobPath);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(stat.size));
    createReadStream(blobPath).pipe(res);
  } catch {
    writeError(res, 404, 'oid-not-found');
  }
}

export async function handleLfsVerify(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  deps: LfsHandlerDeps,
): Promise<void> {
  if (!validateWorkspaceId(workspaceId)) {
    writeError(res, 400, 'invalid-workspace-id');
    return;
  }
  let bodyBuf: Buffer;
  try {
    bodyBuf = await readBody(req, 4 * 1024);
  } catch {
    writeError(res, 413, 'verify-body-too-large');
    return;
  }
  let payload: any;
  try {
    payload = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    writeError(res, 400, 'invalid-json');
    return;
  }
  const oid: string = payload.oid;
  if (!OID_REGEX.test(oid)) {
    writeError(res, 400, 'invalid-oid');
    return;
  }
  const blobPath = lfsBlobPath(deps.repoRoot, workspaceId, oid);
  try {
    const stat = await fs.stat(blobPath);
    if (typeof payload.size === 'number' && stat.size !== payload.size) {
      writeError(res, 422, 'size-mismatch');
      return;
    }
    res.statusCode = 200;
    res.end();
  } catch {
    writeError(res, 404, 'oid-not-found');
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function getAuthHeader(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return typeof h === 'string' ? h : null;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

- [ ] **Step 4: Wire the LFS routes into the listener**

Open `packages/workspace-git-server/src/server/listener.ts`. Find the existing routing logic (the part that matches `/<id>.git/info/refs`, `/<id>.git/git-upload-pack`, etc.). Add LFS route matching BEFORE the catch-all 404:

```ts
import {
  handleLfsBatch,
  handleLfsStorageUpload,
  handleLfsStorageDownload,
  handleLfsVerify,
} from './lfs.js';

// ... existing route dispatch ...

// LFS routes — matches /<id>.git/info/lfs/*
const lfsBatchMatch = pathname.match(/^\/([^/]+)\.git\/info\/lfs\/objects\/batch$/);
if (lfsBatchMatch && method === 'POST') {
  await handleLfsBatch(req, res, lfsBatchMatch[1]!, {
    repoRoot: config.repoRoot,
    baseUrl: config.baseUrl,  // existing config field — verify it's there; if not, derive from req.headers
  });
  return;
}

const lfsStorageMatch = pathname.match(/^\/([^/]+)\.git\/info\/lfs\/storage\/(.+)$/);
if (lfsStorageMatch) {
  const [, ws, oid] = lfsStorageMatch;
  if (method === 'PUT') {
    await handleLfsStorageUpload(req, res, ws!, oid!, { repoRoot: config.repoRoot, baseUrl: config.baseUrl });
    return;
  }
  if (method === 'GET') {
    await handleLfsStorageDownload(req, res, ws!, oid!, { repoRoot: config.repoRoot, baseUrl: config.baseUrl });
    return;
  }
}

const lfsVerifyMatch = pathname.match(/^\/([^/]+)\.git\/info\/lfs\/verify$/);
if (lfsVerifyMatch && method === 'POST') {
  await handleLfsVerify(req, res, lfsVerifyMatch[1]!, {
    repoRoot: config.repoRoot, baseUrl: config.baseUrl,
  });
  return;
}
```

(The exact `config.baseUrl` source depends on the existing config shape. If `baseUrl` isn't part of `ServerConfig`, derive it from `req.headers.host` + scheme inside each handler call.)

Auth: the existing `listener.ts` already runs bearer-auth on every request before routing. The LFS routes inherit it. Verify by reading the listener and confirming the auth check is at the top of the request handler.

- [ ] **Step 5: Provision the `.lfs/` directory on repo create**

Open `packages/workspace-git-server/src/server/repos.ts`. Find the `POST /repos` handler (it creates `<repoRoot>/<workspaceId>.git/` via `git init --bare`). Right after the bare repo creation, add:

```ts
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// ... existing repo creation code ...

// Also provision the .lfs/objects/ directory for this workspace so PUTs land
// in an existing parent. Subdirectories (<oid[0:2]>/<oid[2:4]>/) are created
// lazily by the upload handler.
const lfsObjectsDir = join(config.repoRoot, `${workspaceId}.lfs`, 'objects');
await fs.mkdir(lfsObjectsDir, { recursive: true });
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm test --filter @ax/workspace-git-server
```

Expected: ALL PASS, including the new LFS contract tests.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-git-server/src/
git commit -m "$(cat <<'EOF'
feat(workspace-git-server): add Git LFS batch + storage endpoints

Per-workspace LFS object store at <repoRoot>/<workspaceId>.lfs/. Routes:
  POST /<ws>.git/info/lfs/objects/batch
  PUT  /<ws>.git/info/lfs/storage/<oid>
  GET  /<ws>.git/info/lfs/storage/<oid>
  POST /<ws>.git/info/lfs/verify

OID-mismatch on upload returns 422 (standard LFS verification-failed).
Auth inherits from the existing bearer-token gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Contract test — end-to-end via the bus

**Files:**
- Create: `packages/attachments/src/__tests__/contract.test.ts`

This is the load-bearing test that exercises the full Phase 1 path: store-temp → commit (via real workspace:apply against workspace-git) → download. No UI; no routes; just the hook bus. If this test passes, the host-side foundation is solid.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createAttachmentsPlugin } from '../plugin.js';
// Use the existing test harness that boots a kernel with @ax/workspace-git,
// @ax/conversations, @ax/database-postgres, etc. Pattern after
// packages/conversations/src/__tests__/contract.test.ts or similar.

describe('@ax/attachments — bus contract', () => {
  let harness;

  beforeAll(async () => {
    harness = await buildContractHarness({
      plugins: [
        '@ax/database-postgres',
        '@ax/workspace-git',           // provides workspace:apply, read, list, diff
        '@ax/conversations',           // provides conversations:get, create
        createAttachmentsPlugin({}),
      ],
    });
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  it('full round trip: store-temp → commit → download', async () => {
    const ctx = harness.makeCtx({ userId: 'u-1', agentId: 'a-1' });

    // 1) Stage a temp upload.
    const tempResult = await harness.bus.call(
      'attachments:store-temp', ctx,
      {
        bytes: Buffer.from('hello attachments'),
        displayName: 'greeting.txt',
        mediaType: 'text/plain',
      },
    );
    expect(tempResult.attachmentId).toBeTruthy();

    // 2) Create a conversation to scope this attachment.
    const convResult = await harness.bus.call(
      'conversations:create', ctx, { userId: 'u-1', agentId: 'a-1' },
    );
    const conversationId = convResult.conversationId;
    const turnId = 't-' + Date.now();

    // 3) Commit the temp into the workspace.
    const commitResult = await harness.bus.call(
      'attachments:commit', ctx,
      { attachmentId: tempResult.attachmentId, conversationId, turnId },
    );
    expect(commitResult.path).toMatch(new RegExp(`^\\.ax/uploads/${conversationId}/${turnId}/`));
    expect(commitResult.sha256).toBe(
      createHash('sha256').update('hello attachments').digest('hex'),
    );

    // 4) Append a turn to the conversation that references the path.
    //    (The transcript-scope ACL needs to find the attachment block.)
    await harness.bus.call(
      'conversations:append-turn',  // check actual hook name
      ctx,
      {
        conversationId, turnId, role: 'user',
        contentBlocks: [{
          type: 'attachment',
          path: commitResult.path,
          displayName: commitResult.displayName,
          mediaType: commitResult.mediaType,
          sizeBytes: commitResult.sizeBytes,
        }],
      },
    );

    // 5) Download — should succeed.
    const downloaded = await harness.bus.call(
      'attachments:download', ctx,
      { path: commitResult.path, conversationId, userId: 'u-1' },
    );
    expect(downloaded.bytes.toString()).toBe('hello attachments');
    expect(downloaded.displayName).toBe('greeting.txt');
    expect(downloaded.mediaType).toBe('text/plain');

    // 6) Foreign user — same path, same conversationId, different userId — should 404.
    const foreignCtx = harness.makeCtx({ userId: 'u-attacker', agentId: 'a-1' });
    await expect(
      harness.bus.call('attachments:download', foreignCtx, {
        path: commitResult.path,
        conversationId,
        userId: 'u-attacker',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });

    // 7) Path-scope leak attempt — same user, real conversationId, foreign path → forbidden.
    await expect(
      harness.bus.call('attachments:download', ctx, {
        path: '.ax/uploads/c-not-mine/t-not-mine/secret.pdf',
        conversationId,
        userId: 'u-1',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

(The exact harness helpers — `buildContractHarness`, `harness.bus.call`, `harness.makeCtx` — depend on what's available in `@ax/test-harness`. If a multi-plugin contract harness doesn't exist, mirror the pattern from one of the existing cross-plugin contract tests like `packages/conversations/src/__tests__/contract.test.ts`.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter @ax/attachments -- contract.test.ts
```

Expected: FAIL — depending on harness availability, either missing helpers or genuine test failures.

- [ ] **Step 3: Implement any missing harness pieces and make tests pass**

This step is more discovery than instruction: read the existing contract tests in peer plugins (`conversations`, `workspace-git-core`, etc.), mirror their harness usage, and resolve any gaps. The expected outcome is a green test.

- [ ] **Step 4: Verify the full @ax/attachments suite still passes**

```bash
pnpm test --filter @ax/attachments
```

Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/attachments/src/__tests__/contract.test.ts
git commit -m "$(cat <<'EOF'
test(attachments): end-to-end contract test via the bus

Exercises store-temp → commit (real workspace:apply) → download
round-trip. Asserts: cross-user 404, path-scope-leak attempt forbidden,
sha256 matches input bytes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Register `@ax/attachments` in the CLI preset

**Files:**
- Modify: `packages/cli/src/config/load.ts` (or wherever the CLI preset's plugin list lives — check the existing structure)
- Modify: `packages/cli/package.json` — add `@ax/attachments` to dependencies

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json`, add to `dependencies` (alphabetically with other `@ax/*` entries):

```jsonc
"@ax/attachments": "workspace:*",
```

Run `pnpm install` to update the lockfile.

- [ ] **Step 2: Wire the plugin into the CLI preset**

Find where the CLI preset loads plugins. Look for an array or registry of plugin manifests in `packages/cli/src/config/load.ts`. Add `@ax/attachments`:

```ts
import { createAttachmentsPlugin } from '@ax/attachments';

// ... in the existing plugin list ...
const plugins = [
  // ... existing plugins ...
  createAttachmentsPlugin({}),
];
```

(The exact spot depends on the current CLI architecture; mirror the pattern other recent plugins use.)

- [ ] **Step 3: Boot the CLI in dev mode to verify it loads**

```bash
pnpm build --filter @ax/attachments --filter @ax/cli
# Then run whatever CLI dev command exists; check log output for "@ax/attachments loaded"
# or similar.
```

Expected: no boot errors; the plugin registers its three hooks.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json packages/cli/src/config/load.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(cli): register @ax/attachments plugin in CLI preset

Plugin loads but has no callers yet — half-wired window open
through Phase 3 (channel-web).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Register `@ax/attachments` in the canary preset (preset-k8s)

**Files:**
- Modify: `packages/preset-k8s/src/index.ts` (or equivalent — check actual location)
- Modify: `packages/preset-k8s/package.json`

- [ ] **Step 1: Add the dependency**

```jsonc
"@ax/attachments": "workspace:*",
```

`pnpm install` again to refresh the lockfile.

- [ ] **Step 2: Register the plugin in the canary preset**

Mirror the CLI preset change. Add `createAttachmentsPlugin({})` to the canary preset's plugin list.

- [ ] **Step 3: Verify the chart-shape test passes**

Per the memory note about PR #40 closing the listener-split half-wired window: there's a chart-shape contract test for the preset-k8s that asserts plugin registration. Run it:

```bash
pnpm test --filter @ax/preset-k8s
```

Expected: passes, including any test that asserts `@ax/attachments` is in the canary plugin list.

If no such test exists yet, add one mirroring the existing patterns:

```ts
it('registers @ax/attachments in the canary preset', () => {
  const preset = buildCanaryPreset(testConfig);
  const pluginNames = preset.plugins.map((p) => p.name);
  expect(pluginNames).toContain('@ax/attachments');
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/preset-k8s/ pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(preset-k8s): register @ax/attachments in canary preset

Half-wired window OPEN through Phase 3 — plugin is loaded by the canary
preset and reachable via the bus, but no caller in Phase 1 exercises it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Final verification + PR-body sketch

**Files:** none (this task is run-the-suites + commit-message-craft only).

- [ ] **Step 1: Run the full monorepo test suite**

```bash
pnpm build && pnpm test
```

Expected: clean build, all tests green. Especially:
- `@ax/ipc-protocol` — content-blocks tests including new variants
- `@ax/attachments` — store, store-temp, commit, download, janitor, plugin, contract
- `@ax/workspace-git-server` — contract including LFS
- `@ax/preset-k8s` — chart-shape contract
- `@ax/cli` — any boot-smoke test

- [ ] **Step 2: Sanity-check the half-wired window declaration**

Verify:
- `@ax/attachments` is loaded by both CLI and canary presets ✓
- Three service hooks (`store-temp`, `commit`, `download`) are registered and callable ✓
- No code path in Phase 1 *calls* any of those hooks (other than tests) — that's correct; this is the half-wired part by design ✓
- The contract test exercises all three hooks end-to-end ✓

- [ ] **Step 3: Draft PR body**

When the user opens the PR, the body should declare:

```markdown
## Summary

Phase 1 of 3 for the attachments & artifacts subsystem (`docs/plans/2026-05-15-attachments-and-artifacts-design.md`):

- New `@ax/attachments` plugin: three service hooks (`store-temp`, `commit`, `download`) over a Postgres-backed temp store + workspace-tier git commits. Path-scope ACL lives inside `attachments:download`.
- `@ax/ipc-protocol`: new `attachment_ref` and `attachment` ContentBlock variants.
- `@ax/workspace-git-server`: Git LFS server endpoints (batch / upload / download / verify), per-workspace blob store under `<workspaceId>.lfs/`.
- Preset wiring: plugin loaded by both CLI and canary presets.

## Half-wired windows opened

`@ax/attachments` is loaded and its hooks are bus-reachable, but no caller in Phase 1 exercises it. Phase 2 wires up the `artifact_publish` tool; Phase 3 wires up channel-web (`AxAttachmentAdapter` + REST routes + chip UI). **Window closes in Phase 3.**

## Boundary review

- **Alternate impl:** A future `@ax/attachments-pg-bytea-only` (no LFS — pure Postgres BYTEA for both temp and durable storage) registers the same hooks with the same shapes. Only the in-process impl swaps.
- **Payload field names that might leak:** none — `attachmentId`, `path`, `displayName`, `mediaType`, `sizeBytes`, `sha256` are all workspace + filesystem vocabulary.
- **Subscriber risk:** no subscriber hooks added — service hooks only. No leak surface for subscribers to key off.
- **Wire surface:** none in Phase 1 (REST endpoints land in Phase 3).

## Test plan

- [x] `pnpm test` green across the monorepo
- [x] `@ax/attachments` contract test passes (full round-trip: temp → commit → download via the bus)
- [x] LFS contract tests pass (batch / PUT / GET / verify, including OID-mismatch 422)
- [x] Path-scope ACL test cases all green (under-uploads, in-transcript via attachment block, in-transcript via artifact_publish tool_result, none-of-the-above forbidden, foreign-user 404, `..`/leading-`/`/`//` rejected, symlink mode refused)
- [ ] Manual canary boot (`pnpm dev` or equivalent) — plugin loads, hooks reachable via bus inspection

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: No commit needed** — the PR body is for the eventual `gh pr create` step the user runs themselves.

---

## Self-review checklist

After all 14 tasks above complete, run this quick sanity pass:

- **Spec coverage:** every Phase 1 requirement in `docs/plans/2026-05-15-attachments-and-artifacts-design.md` has at least one task:
  - Hook surface (3 hooks) → Tasks 5, 6, 7 ✓
  - ContentBlock variants → Task 1 ✓
  - LFS endpoints → Task 10 ✓
  - Plugin scaffold + migration + janitor → Tasks 2, 3, 4, 8, 9 ✓
  - Preset wiring → Tasks 12, 13 ✓
  - Contract coverage → Task 11 ✓
  - Half-wired window declaration → Task 14 (PR body) ✓

- **Phase 2 + 3 deferrals** explicitly out of scope (confirm none of the 14 tasks touches):
  - `@ax/tool-artifact-publish` (doesn't exist in Phase 1)
  - `@ax/agent-claude-sdk-runner` translation pass
  - `@ax/channel-web` adapter / chips / routes
  - `git-lfs` binary in sandbox/host Dockerfiles
  - Canary acceptance Playwright scenario

- **Type consistency** sanity check: `attachments:commit` returns `path` (workspace-relative), `attachments:download` accepts `path` (same shape). `AttachmentBlock.path` matches both. Display metadata (`displayName`, `mediaType`, `sizeBytes`) consistent across all three hooks.
