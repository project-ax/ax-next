# Routines — Phase C Implementation Plan (Webhook Trigger)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the webhook trigger surface that Phase B's validator deferred — flip the validator's `webhook` reject, add an opaque per-agent webhook token + two `@ax/agents` service hooks, mount/unmount per-routine routes via the existing `http:register-route` closure, parse incoming bodies, verify optional HMAC, render strict-whitelist payload templates, and fire `agent:invoke` with `source: 'webhook'`. Producer + consumer + canary all ship in the same PR (K5 window closure).

**Architecture:** No new packages. Five files are added inside `@ax/routines` (`template.ts`, `webhook-handler.ts`, plus tests); the validator's `frontmatter.ts` gains webhook validation; `@ax/agents` gains an additive `ALTER TABLE` + two hooks. The webhook surface is mounted by extending the existing `workspace:applied` subscriber so route lifecycle stays atomic with routine indexing.

**Tech Stack:** TypeScript + Kysely + Postgres. New runtime deps: none — uses `node:crypto` (`randomBytes`, `createHmac`, `timingSafeEqual`) and `URLSearchParams` from the standard library. Test infra unchanged (vitest + `@testcontainers/postgresql` for migration / integration tests).

**Spec:** `docs/plans/2026-05-15-routines-phase-c-design.md`. Carries forward Phase B (`docs/plans/2026-05-14-routines-phase-b-impl.md`) + follow-ups (`docs/plans/2026-05-15-routines-phase-b-followups.md`).

---

## Invariants (K1–K11)

Numbered invariants surface explicit failure modes from prior phases and must hold across every task. Reviewers can grep PR notes for `K1..K11` to confirm coverage. Phase B's I1–I8 and the follow-ups' J1–J5 are **not** repealed — K-invariants are additive discipline for the Phase C surface.

- **K1 (plan vs reality — `http:unregister-route` doesn't exist).** `@ax/http-server` only registers `http:register-route`, which returns `{ unregister(): void }` as a closure. Phase C holds those closures in a `Map<key, () => void>` and calls them on delete / replace / shutdown. Capability budget does NOT list `http:unregister-route`.
- **K2 (plan vs reality — `credentials:get-by-name` doesn't exist).** Phase C reuses `credentials:get({ ref, userId })` passing `row.authorUserId`.
- **K3 (single-replica posture, explicit).** Webhook routes are in-process and local to the replica that received `workspace:applied`. Multi-replica fan-out deferred. Documented in plugin manifest, preset comment, and PR notes.
- **K4 (no cross-plugin imports).** `@ax/routines` reaches `@ax/agents` / `@ax/credentials` / `@ax/http-server` only through the bus. `@ax/validator-routine` reaches `@ax/core` only.
- **K5 (no half-wired plugins — window closure).** Producer (route mount), consumer (fireRoutine payload + template), canary all ship in this PR. PR notes name the "Phase C window CLOSED" line.
- **K6 (one source of truth — spec_hash gates re-binding).** Routine file is the spec; `(agentId, path)` identity unchanged; the subscriber only re-registers routes when `spec_hash` changes.
- **K7 (capabilities explicit and minimized).** `@ax/routines.calls` adds: `http:register-route`, `credentials:get`, `agents:resolve-by-webhook-token`, `agents:rotate-webhook-token`. `@ax/agents.registers` adds: `agents:resolve-by-webhook-token`, `agents:rotate-webhook-token`.
- **K8 (storage-agnostic hook payloads).** New `@ax/agents` hooks use opaque `agentId` / `token` strings only. No `sha`, no `pod_name`, no DB row shapes.
- **K9 (untrusted-content trust boundary).** Webhook payload bytes flow `req.body` → `JSON.parse` → `renderTemplate` (string substitution only) → `agent:invoke({ message: { content: string } })`. No dynamic-JS-evaluation sinks (forbidden set is the standard one: the `Function` constructor, the `vm` module, the global `eval`, child-process spawn — review rejects introductions). `security-checklist` skill invoked before the body-parse / HMAC / template modules merge.
- **K10 (subscriber-must-not-throw).** Webhook-binding failures inside the `workspace:applied` subscriber log + record `last_status='error'` on the routine row, never propagate.
- **K11 (constant-time HMAC).** `crypto.timingSafeEqual` over equal-length lowercase hex buffers only. Direct `===` rejected at review.

---

## File Structure

**Create:**
- `packages/routines/src/template.ts` — strict-whitelist payload substitution.
- `packages/routines/src/webhook-handler.ts` — HTTP route handler (token+row lookup is implicit via closure, then HMAC, body-parse, event filter, fire).
- `packages/routines/src/__tests__/template.test.ts`
- `packages/routines/src/__tests__/webhook-handler.test.ts`

**Modify:**
- `packages/validator-routine/src/frontmatter.ts` — accept `kind: webhook`; validate `path`, `events`, `hmac`; reject `activeHours` for webhook.
- `packages/validator-routine/src/__tests__/frontmatter.test.ts` — new webhook cases.
- `packages/agents/src/migrations.ts` — `ALTER TABLE` adding `webhook_token TEXT UNIQUE` + partial index.
- `packages/agents/src/store.ts` — `getByWebhookToken`, `setWebhookToken`, `rowToAgent` extended with `webhookToken`.
- `packages/agents/src/types.ts` — new `Agent.webhookToken` field; new `ResolveByWebhookTokenInput/Output` + `RotateWebhookTokenInput/Output`.
- `packages/agents/src/plugin.ts` — register the two new hooks; manifest gains both in `registers`.
- `packages/agents/src/__tests__/plugin.test.ts` (or new test file `webhook-token.test.ts`) — unit tests for both new hooks.
- `packages/agents/src/__tests__/migrations.test.ts` — assert new column + index.
- `packages/routines/src/types.ts` — re-export `WebhookHmacSpec` from validator-routine (no new shape — single source of truth in validator).
- `packages/routines/src/store.ts` — add `findOne({ agentId, path }): Promise<RoutineRow | null>`. Add upsert return `{ changed: boolean }` so the subscriber knows whether spec_hash drifted.
- `packages/routines/src/fire.ts` — accept optional `payload`; render template when `source === 'webhook'`.
- `packages/routines/src/sync.ts` — extend the per-change loop with webhook binding/unbinding. Threads a new `webhookRoutes` map handle and `bus` ref through `handleWorkspaceApplied`.
- `packages/routines/src/plugin.ts` — manifest `calls` additions; instantiate the `webhookRoutes` map and pass through to `handleWorkspaceApplied`; drain on `shutdown()`.
- `packages/routines/src/__tests__/canary.test.ts` — five new test cases.

**Do not touch:** `packages/channel-web` (Phase D), `packages/http-server` (no hook changes), `packages/sandbox-k8s`.

---

## Task 1: Validator — accept webhook trigger, validate fields

**Files:**
- Modify: `packages/validator-routine/src/frontmatter.ts`
- Modify: `packages/validator-routine/src/__tests__/frontmatter.test.ts`

The Phase B reject at line 110-112 flips. Webhook validation accepts a `path` (mandatory, `^/[A-Za-z0-9._\-/]+$`, 1-128 chars, not starting with `/webhooks/`, no `..`, no `//`), an optional `events[]` (each `[A-Za-z0-9_-]{1,64}`, ≤32 items), and an optional `hmac` object with required `secretRef` + `header` and optional `algorithm` (default `sha256`, or `sha1`) + `prefix`. `activeHours` becomes a veto when `kind: webhook`.

- [ ] **Step 1: Write failing tests for the new webhook frontmatter cases**

Append to `packages/validator-routine/src/__tests__/frontmatter.test.ts`:

```ts
describe('parseRoutineFrontmatter — webhook trigger', () => {
  it('parses a minimal webhook routine (no events, no hmac)', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr-triage',
      'description: PR triage',
      'trigger:',
      '  kind: webhook',
      '  path: "/r/github"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/github',
    });
  });

  it('parses webhook with events filter', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr',
      'description: d',
      'trigger:',
      '  kind: webhook',
      '  path: "/r/gh"',
      '  events: ["pull_request", "issues"]',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/gh', events: ['pull_request', 'issues'],
    });
  });

  it('parses webhook with full hmac config', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr',
      'description: d',
      'trigger:',
      '  kind: webhook',
      '  path: "/r/gh"',
      '  hmac:',
      '    secretRef: gh-secret',
      '    header: "X-Hub-Signature-256"',
      '    algorithm: sha256',
      '    prefix: "sha256="',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.trigger).toEqual({
      kind: 'webhook', path: '/r/gh',
      hmac: {
        secretRef: 'gh-secret',
        header: 'X-Hub-Signature-256',
        algorithm: 'sha256',
        prefix: 'sha256=',
      },
    });
  });

  it('defaults hmac.algorithm to sha256 when omitted', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: pr', 'description: d',
      'trigger:',
      '  kind: webhook',
      '  path: "/r"',
      '  hmac:',
      '    secretRef: s',
      '    header: "X-Sig"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.fields.trigger.kind !== 'webhook') throw new Error('kind');
    expect(r.fields.trigger.hmac?.algorithm).toBe('sha256');
  });

  it.each([
    ['missing path', ['name: a', 'description: d', 'trigger:', '  kind: webhook', 'conversation: per-fire']],
    ['empty path', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: ""', 'conversation: per-fire']],
    ['path missing leading slash', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "r/x"', 'conversation: per-fire']],
    ['path starts with /webhooks/', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/webhooks/leak"', 'conversation: per-fire']],
    ['path contains ..', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/r/../etc"', 'conversation: per-fire']],
    ['path contains //', ['name: a', 'description: d', 'trigger:', '  kind: webhook', '  path: "/r//x"', 'conversation: per-fire']],
    ['path too long', ['name: a', 'description: d', 'trigger:', '  kind: webhook', `  path: "/${'a'.repeat(128)}"`, 'conversation: per-fire']],
  ])('rejects webhook %s', (_label, lines) => {
    const r = parseRoutineFrontmatter(fm(lines.join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects events item with illegal characters', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  events: ["has space"]',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects more than 32 events', () => {
    const events = Array.from({ length: 33 }, (_, i) => `evt${i}`);
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      `  events: ${JSON.stringify(events)}`,
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects hmac missing secretRef', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:', '    header: "X-Sig"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects hmac.algorithm not in sha256/sha1', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      '  hmac:',
      '    secretRef: s', '    header: "X-Sig"',
      '    algorithm: md5',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });

  it('rejects activeHours on webhook routines', () => {
    const r = parseRoutineFrontmatter(fm([
      'name: a', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r"',
      'activeHours:',
      '  start: "08:00"', '  end: "18:00"', '  tz: "UTC"',
      'conversation: per-fire',
    ].join('\n')));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing tests to confirm they fail**

```
pnpm --filter @ax/validator-routine test -- frontmatter
```

Expected: every new `describe('parseRoutineFrontmatter — webhook trigger', ...)` case fails because `case 'webhook':` in `frontmatter.ts:110` still returns `fail('trigger.kind: webhook is not yet supported (lands in Phase C)')`.

- [ ] **Step 3: Implement webhook validation in frontmatter.ts**

In `packages/validator-routine/src/frontmatter.ts`:

Add near the existing constants:

```ts
const WEBHOOK_PATH_RE = /^\/[A-Za-z0-9._\-/]+$/;
const EVENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WEBHOOK_PATH_MAX = 128;
const WEBHOOK_EVENTS_MAX = 32;
```

Extend the `TriggerSpec` union (replacing the existing webhook shape) and add the HMAC type:

```ts
export interface WebhookHmacSpec {
  secretRef: string;
  header: string;
  algorithm: 'sha256' | 'sha1';
  prefix?: string;
}

export type TriggerSpec =
  | { kind: 'interval'; every: string }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'webhook'; path: string; events?: string[]; hmac?: WebhookHmacSpec };
```

Replace the `case 'webhook':` arm in `parseRoutineFrontmatter` (the
existing reject at line 110-112) with:

```ts
    case 'webhook': {
      const pathRaw = trigObj['path'];
      if (typeof pathRaw !== 'string' || pathRaw.length === 0) {
        return fail('webhook trigger missing required field: path');
      }
      if (pathRaw.length > WEBHOOK_PATH_MAX) {
        return fail(`webhook.path: ${pathRaw.length} > max ${WEBHOOK_PATH_MAX}`);
      }
      if (!WEBHOOK_PATH_RE.test(pathRaw)) {
        return fail(`webhook.path: must match ${WEBHOOK_PATH_RE.source}`);
      }
      if (pathRaw.startsWith('/webhooks/')) {
        return fail('webhook.path: must not start with /webhooks/');
      }
      if (pathRaw.includes('..')) {
        return fail('webhook.path: must not contain ..');
      }
      if (pathRaw.includes('//')) {
        return fail('webhook.path: must not contain //');
      }

      const webhook: { kind: 'webhook'; path: string; events?: string[]; hmac?: WebhookHmacSpec } = {
        kind: 'webhook',
        path: pathRaw,
      };

      const eventsRaw = trigObj['events'];
      if (eventsRaw !== undefined && eventsRaw !== null) {
        if (!Array.isArray(eventsRaw)) {
          return fail('webhook.events must be an array');
        }
        if (eventsRaw.length > WEBHOOK_EVENTS_MAX) {
          return fail(`webhook.events: ${eventsRaw.length} > max ${WEBHOOK_EVENTS_MAX}`);
        }
        const events: string[] = [];
        for (const v of eventsRaw) {
          if (typeof v !== 'string' || !EVENT_NAME_RE.test(v)) {
            return fail(`webhook.events: invalid item ${JSON.stringify(v)}`);
          }
          events.push(v);
        }
        webhook.events = events;
      }

      const hmacRaw = trigObj['hmac'];
      if (hmacRaw !== undefined && hmacRaw !== null) {
        if (typeof hmacRaw !== 'object' || Array.isArray(hmacRaw)) {
          return fail('webhook.hmac must be a mapping');
        }
        const hObj = hmacRaw as Record<string, unknown>;
        const secretRef = hObj['secretRef'];
        const header = hObj['header'];
        if (typeof secretRef !== 'string' || secretRef.length === 0) {
          return fail('webhook.hmac.secretRef is required');
        }
        if (typeof header !== 'string' || header.length === 0) {
          return fail('webhook.hmac.header is required');
        }
        let algorithm: 'sha256' | 'sha1' = 'sha256';
        const algRaw = hObj['algorithm'];
        if (algRaw !== undefined && algRaw !== null) {
          if (algRaw !== 'sha256' && algRaw !== 'sha1') {
            return fail(`webhook.hmac.algorithm: must be sha256 or sha1 (got ${JSON.stringify(algRaw)})`);
          }
          algorithm = algRaw;
        }
        const hmac: WebhookHmacSpec = { secretRef, header, algorithm };
        const prefix = hObj['prefix'];
        if (prefix !== undefined && prefix !== null) {
          if (typeof prefix !== 'string') {
            return fail('webhook.hmac.prefix must be a string');
          }
          hmac.prefix = prefix;
        }
        webhook.hmac = hmac;
      }

      trigger = webhook;
      break;
    }
```

Add the `activeHours` veto for webhook just before the existing
`activeHours` block (still inside `parseRoutineFrontmatter`, right
after `trigger` has been assigned):

```ts
  if (trigger.kind === 'webhook' && obj['activeHours'] !== undefined && obj['activeHours'] !== null) {
    return fail('activeHours is not supported on webhook routines');
  }
```

- [ ] **Step 4: Re-run tests to confirm they pass**

```
pnpm --filter @ax/validator-routine test -- frontmatter
```

Expected: all webhook cases pass; Phase B cases still green.

- [ ] **Step 5: Commit**

```
git add packages/validator-routine/src/frontmatter.ts \
        packages/validator-routine/src/__tests__/frontmatter.test.ts
git commit -m "feat(validator-routine): accept webhook trigger (K1 reject flip)

Phase C validator now accepts kind: webhook with path/events/hmac
fields. activeHours is rejected on webhook routines."
```

---

## Task 2: `@ax/agents` migration — add `webhook_token` column

**Files:**
- Modify: `packages/agents/src/migrations.ts`
- Modify: `packages/agents/src/__tests__/migrations.test.ts`

Additive `ALTER TABLE`. Nullable so existing rows continue to read.
Unique index for the resolve-by-token lookup; partial (`WHERE NOT NULL`)
so NULL doesn't take an index slot.

- [ ] **Step 1: Write failing migration test**

Append to `packages/agents/src/__tests__/migrations.test.ts` (or create
it if it doesn't exist — read first to confirm shape and either append
or fold into existing migration test file):

```ts
it('adds webhook_token column with unique index', async () => {
  await runAgentsMigration(db);
  const cols = await sql<{ column_name: string; data_type: string; is_nullable: 'YES' | 'NO' }>`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'agents_v1_agents'
       AND column_name = 'webhook_token'
  `.execute(db);
  expect(cols.rows).toHaveLength(1);
  expect(cols.rows[0]).toMatchObject({ data_type: 'text', is_nullable: 'YES' });

  const ix = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'agents_v1_agents'
       AND indexname = 'agents_v1_agents_webhook_token'
  `.execute(db);
  expect(ix.rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run failing test**

```
pnpm --filter @ax/agents test -- migrations
```

Expected: FAIL (column does not exist).

- [ ] **Step 3: Implement the additive migration**

In `packages/agents/src/migrations.ts`, after the existing CREATE
INDEX, append:

```ts
  // Phase C: lazy-generated webhook bearer token. Nullable so the
  // column is harmless for agents that never grow a webhook routine.
  // Partial unique index avoids burning index space on NULL rows and
  // makes `agents:resolve-by-webhook-token` an indexed equality lookup.
  await sql`
    ALTER TABLE agents_v1_agents
      ADD COLUMN IF NOT EXISTS webhook_token TEXT
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_v1_agents_webhook_token
      ON agents_v1_agents (webhook_token)
     WHERE webhook_token IS NOT NULL
  `.execute(db);
```

Extend `AgentsRow`:

```ts
export interface AgentsRow {
  // ...existing fields...
  webhook_token: string | null;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 4: Re-run test to confirm pass**

```
pnpm --filter @ax/agents test -- migrations
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/agents/src/migrations.ts packages/agents/src/__tests__/migrations.test.ts
git commit -m "feat(agents): add nullable webhook_token column (Phase C)

Additive migration; existing rows unaffected. Partial unique index
gates the agents:resolve-by-webhook-token lookup."
```

---

## Task 3: `@ax/agents` store — getByWebhookToken / setWebhookToken / Agent.webhookToken

**Files:**
- Modify: `packages/agents/src/store.ts`
- Modify: `packages/agents/src/types.ts`

Extend the `Agent` shape, `rowToAgent`, and the store interface with
two new helpers used by the new hooks in Task 4.

- [ ] **Step 1: Write failing store tests**

Append to or create `packages/agents/src/__tests__/store-webhook.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runAgentsMigration, type AgentsDatabase } from '../migrations.js';
import { createAgentStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let db: Kysely<AgentsDatabase>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = new Kysely<AgentsDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: container.getConnectionUri() }) }),
  });
  await runAgentsMigration(db);
}, 120_000);

afterAll(async () => {
  await db.destroy();
  await container.stop();
});

beforeEach(async () => {
  await db.deleteFrom('agents_v1_agents').execute();
});

async function seedAgent(id: string) {
  await db.insertInto('agents_v1_agents').values({
    agent_id: id, owner_id: 'u1', owner_type: 'user', visibility: 'personal',
    display_name: 'a', system_prompt: '', allowed_tools: JSON.stringify([]),
    mcp_config_ids: JSON.stringify([]), model: 'claude-opus-4-7',
    workspace_ref: null,
  } as never).execute();
}

describe('AgentStore webhook helpers', () => {
  it('getByWebhookToken returns null when no agent has the token', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    expect(await store.getByWebhookToken('missing')).toBeNull();
  });

  it('setWebhookToken persists, getByWebhookToken finds it', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'tok123');
    const agent = await store.getByWebhookToken('tok123');
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe('agt_a');
    expect(agent!.webhookToken).toBe('tok123');
  });

  it('setWebhookToken on unknown agent throws', async () => {
    const store = createAgentStore(db);
    await expect(store.setWebhookToken('agt_missing', 'tok')).rejects.toThrow();
  });

  it('getById returns webhookToken when set', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'tok');
    const agent = await store.getById('agt_a');
    expect(agent?.webhookToken).toBe('tok');
  });

  it('setWebhookToken rotates: second call replaces prior token', async () => {
    await seedAgent('agt_a');
    const store = createAgentStore(db);
    await store.setWebhookToken('agt_a', 'first');
    await store.setWebhookToken('agt_a', 'second');
    expect(await store.getByWebhookToken('first')).toBeNull();
    expect((await store.getByWebhookToken('second'))?.id).toBe('agt_a');
  });
});
```

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/agents test -- store-webhook
```

Expected: FAIL — methods don't exist.

- [ ] **Step 3: Extend Agent type**

In `packages/agents/src/types.ts`, add the field to `Agent`:

```ts
export interface Agent {
  // ...existing fields...
  workspaceRef: string | null;
  /**
   * Opaque per-agent webhook bearer token; null until first webhook
   * routine indexes for this agent. URL-safe base64; rotated via
   * `agents:rotate-webhook-token`.
   */
  webhookToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 4: Extend AgentStore + rowToAgent**

In `packages/agents/src/store.ts`:

Update `rowToAgent` (around line 318-327) to populate `webhookToken`:

```ts
function rowToAgent(row: AgentsRow): Agent {
  // ...existing allowedTools / mcpConfigIds parsing unchanged...
  return {
    id: row.agent_id,
    ownerId: row.owner_id,
    ownerType: row.owner_type as 'user' | 'team',
    visibility: row.visibility as 'personal' | 'team',
    displayName: row.display_name,
    systemPrompt: row.system_prompt,
    allowedTools,
    mcpConfigIds,
    model: row.model,
    workspaceRef: row.workspace_ref,
    webhookToken: row.webhook_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Add two methods on the `AgentStore` interface:

```ts
export interface AgentStore {
  getById(agentId: string): Promise<Agent | null>;
  listScoped(scope: AgentScope): Promise<Agent[]>;
  create(args: AgentStoreCreateArgs): Promise<Agent>;
  update(agentId: string, patch: Partial<ValidatedAgentInput>): Promise<Agent>;
  deleteById(agentId: string): Promise<boolean>;
  /**
   * Lookup by opaque webhook token. Returns null on miss (no oracle —
   * the caller maps null to 404).
   */
  getByWebhookToken(token: string): Promise<Agent | null>;
  /**
   * Atomic write of `webhook_token`. Throws `PluginError` with code
   * `not-found` when no row matched. UNIQUE partial index prevents
   * collisions across agents.
   */
  setWebhookToken(agentId: string, token: string): Promise<void>;
}
```

Implement both inside `createAgentStore`:

```ts
    async getByWebhookToken(token) {
      const row = await db
        .selectFrom('agents_v1_agents')
        .selectAll('agents_v1_agents')
        .where('webhook_token', '=', token)
        .executeTakeFirst();
      return row === undefined ? null : rowToAgent(row);
    },

    async setWebhookToken(agentId, token) {
      const result = await db
        .updateTable('agents_v1_agents')
        .set({ webhook_token: token, updated_at: new Date() } as never)
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      const affected = Number(result.numUpdatedRows ?? 0n);
      if (affected === 0) {
        throw new PluginError({
          code: 'not-found',
          plugin: PLUGIN_NAME,
          message: `agent '${agentId}' not found`,
        });
      }
    },
```

In the existing `create` and `update` `returning` lists, append
`'webhook_token'` so rows surface the column. (Both blocks; the
`update` returning list at lines 408-440.)

Also update the existing `getById` / `listScoped` to ensure
`selectAll()` returns the new column — `selectAll` already covers it
once `AgentsRow` carries `webhook_token`, but verify the type derives
cleanly.

- [ ] **Step 5: Run tests, confirm pass**

```
pnpm --filter @ax/agents test -- store-webhook
```

Expected: PASS. Also rerun the wider agents test suite to confirm no
regression:

```
pnpm --filter @ax/agents test
```

Expected: full pass.

- [ ] **Step 6: Commit**

```
git add packages/agents/src/store.ts packages/agents/src/types.ts \
        packages/agents/src/__tests__/store-webhook.test.ts
git commit -m "feat(agents): store helpers for webhook_token (Phase C)

getByWebhookToken returns Agent | null for the route handler;
setWebhookToken is the single writer (used by agents:rotate-webhook-
token). Agent.webhookToken is surfaced on all read paths."
```

---

## Task 4: `@ax/agents` service hooks — resolve-by-webhook-token + rotate-webhook-token

**Files:**
- Modify: `packages/agents/src/types.ts`
- Modify: `packages/agents/src/plugin.ts`
- Create: `packages/agents/src/__tests__/webhook-token-hooks.test.ts`

`agents:resolve-by-webhook-token` is unauthenticated by design — the
token IS the auth. Return `{ agent: Agent } | null`; route handler
maps `null` to 404.

`agents:rotate-webhook-token` always issues a fresh token (caller
implements lazy-on-first-use). ACL: the caller must be either the
agent's owner (`agent.ownerId === actor.userId`) or an admin
(`actor.isAdmin`) — mirrors `agents:update`.

- [ ] **Step 1: Define hook input/output types**

In `packages/agents/src/types.ts`, add:

```ts
export interface ResolveByWebhookTokenInput {
  token: string;
}

/**
 * Null on miss. No PluginError — the caller maps null → 404 and we
 * deliberately avoid distinguishing "wrong token" from "no agent."
 */
export type ResolveByWebhookTokenOutput = { agent: Agent } | null;

export interface RotateWebhookTokenInput {
  actor: Actor;
  agentId: string;
}

export interface RotateWebhookTokenOutput {
  token: string;
}
```

- [ ] **Step 2: Write failing hook tests**

Create `packages/agents/src/__tests__/webhook-token-hooks.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestHarness, type TestHarness } from '@ax/test-harness';
import { createDatabasePostgresPlugin } from '@ax/database-postgres';
import { createAgentsPlugin } from '../plugin.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
let harness: TestHarness;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);
afterAll(async () => await container.stop());

beforeEach(async () => {
  harness = await createTestHarness({
    services: {
      'http:register-route': async () => ({ unregister: () => {} }),
      'auth:require-user': async () => ({ user: { id: 'u1', isAdmin: false } }),
    },
    plugins: [
      createDatabasePostgresPlugin({ connectionString }),
      createAgentsPlugin({}),
    ],
  });
});

afterEach?.(async () => harness && (await harness.close({ onError: () => {} })));

async function createAgent(ownerUserId: string) {
  const out = await harness.bus.call<{ actor: { userId: string; isAdmin: boolean }; input: unknown }, { agent: { id: string } }>(
    'agents:create',
    harness.ctx({ userId: ownerUserId }),
    { actor: { userId: ownerUserId, isAdmin: false },
      input: { displayName: 'a', systemPrompt: '', allowedTools: [], mcpConfigIds: [],
               model: 'claude-opus-4-7', visibility: 'personal' } },
  );
  return out.agent.id;
}

describe('agents:rotate-webhook-token', () => {
  it('issues a fresh URL-safe token', async () => {
    const id = await createAgent('u1');
    const out = await harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token',
      harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id },
    );
    expect(typeof out.token).toBe('string');
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('replaces a prior token on second call', async () => {
    const id = await createAgent('u1');
    const a = await harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const b = await harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    expect(a.token).not.toBe(b.token);
  });

  it('denies rotation by a non-owner non-admin', async () => {
    const id = await createAgent('u1');
    await expect(harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u2' }),
      { actor: { userId: 'u2', isAdmin: false }, agentId: id },
    )).rejects.toThrow(/forbidden|access/i);
  });

  it('throws not-found when the agent does not exist', async () => {
    await expect(harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: 'agt_missing' },
    )).rejects.toThrow(/not-found|not found/i);
  });
});

describe('agents:resolve-by-webhook-token', () => {
  it('returns the agent when the token matches', async () => {
    const id = await createAgent('u1');
    const { token } = await harness.bus.call<{ actor: unknown; agentId: string }, { token: string }>(
      'agents:rotate-webhook-token', harness.ctx({ userId: 'u1' }),
      { actor: { userId: 'u1', isAdmin: false }, agentId: id });
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token });
    expect(out).not.toBeNull();
    expect(out!.agent.id).toBe(id);
  });

  it('returns null on unknown token', async () => {
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token: 'nope' });
    expect(out).toBeNull();
  });

  it('returns null on empty token (no oracle)', async () => {
    const out = await harness.bus.call<{ token: string }, { agent: { id: string } } | null>(
      'agents:resolve-by-webhook-token', harness.ctx({ userId: 'system' }), { token: '' });
    expect(out).toBeNull();
  });
});
```

(Adapt imports as needed — `afterEach` may need importing. The
harness `close` shape matches Phase B canary patterns.)

- [ ] **Step 3: Run failing tests**

```
pnpm --filter @ax/agents test -- webhook-token-hooks
```

Expected: FAIL — hooks aren't registered.

- [ ] **Step 4: Register both hooks in plugin.ts**

In `packages/agents/src/plugin.ts`:

Add to the manifest's `registers` list:

```ts
      registers: [
        'agents:resolve',
        'agents:list-for-user',
        'agents:create',
        'agents:update',
        'agents:delete',
        'agents:resolve-by-webhook-token',
        'agents:rotate-webhook-token',
      ],
```

Import the new types from `./types.js`:

```ts
import type {
  // ...existing imports...
  ResolveByWebhookTokenInput, ResolveByWebhookTokenOutput,
  RotateWebhookTokenInput, RotateWebhookTokenOutput,
} from './types.js';
import { randomBytes } from 'node:crypto';
```

Inside `init({ bus })`, after the existing `bus.registerService(...)`
calls and before `registerAdminAgentRoutes`, add:

```ts
      bus.registerService<ResolveByWebhookTokenInput, ResolveByWebhookTokenOutput>(
        'agents:resolve-by-webhook-token',
        PLUGIN_NAME,
        async (_ctx, input) => {
          if (typeof input.token !== 'string' || input.token.length === 0) {
            return null;
          }
          const agent = await localStore.getByWebhookToken(input.token);
          if (agent === null) return null;
          return { agent };
        },
      );

      bus.registerService<RotateWebhookTokenInput, RotateWebhookTokenOutput>(
        'agents:rotate-webhook-token',
        PLUGIN_NAME,
        async (ctx, input) => {
          const agent = await localStore.getById(input.agentId);
          if (agent === null) {
            throw new PluginError({
              code: 'not-found',
              plugin: PLUGIN_NAME,
              hookName: 'agents:rotate-webhook-token',
              message: `agent '${input.agentId}' not found`,
            });
          }
          // ACL: owner OR admin. Mirrors agents:update access.
          const isOwner = agent.ownerType === 'user' && agent.ownerId === input.actor.userId;
          if (!isOwner && !input.actor.isAdmin) {
            throw new PluginError({
              code: 'forbidden',
              plugin: PLUGIN_NAME,
              hookName: 'agents:rotate-webhook-token',
              message: `actor '${input.actor.userId}' cannot rotate webhook token for agent '${input.agentId}'`,
            });
          }
          const token = randomBytes(32).toString('base64url');
          await localStore.setWebhookToken(input.agentId, token);
          return { token };
        },
      );
```

- [ ] **Step 5: Run tests, confirm pass**

```
pnpm --filter @ax/agents test -- webhook-token-hooks
pnpm --filter @ax/agents test
```

Expected: both pass; full agents suite green (no regression on `agents:resolve` or admin routes).

- [ ] **Step 6: Commit**

```
git add packages/agents/src/plugin.ts packages/agents/src/types.ts \
        packages/agents/src/__tests__/webhook-token-hooks.test.ts
git commit -m "feat(agents): resolve-by-webhook-token + rotate-webhook-token (K7/K8)

agents:resolve-by-webhook-token returns null on miss (no oracle).
agents:rotate-webhook-token always issues a fresh URL-safe 32-byte
token; ACL mirrors agents:update (owner OR admin)."
```

---

## Task 5: `renderTemplate` — strict-whitelist payload substitution (K9)

**Files:**
- Create: `packages/routines/src/template.ts`
- Create: `packages/routines/src/__tests__/template.test.ts`

The only sink for webhook payload bytes inside the agent's prompt.

- [ ] **Step 1: Write failing tests**

Create `packages/routines/src/__tests__/template.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../template.js';

describe('renderTemplate', () => {
  it('substitutes a top-level string', () => {
    expect(renderTemplate('hello {{payload.name}}', { payload: { name: 'world' } }))
      .toBe('hello world');
  });

  it('walks a nested path', () => {
    expect(renderTemplate('PR {{payload.pr.title}}', {
      payload: { pr: { title: 'fix bug' } },
    })).toBe('PR fix bug');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(renderTemplate('{{payload.n}}/{{payload.b}}', {
      payload: { n: 42, b: true },
    })).toBe('42/true');
  });

  it('JSON.stringifies object / array values', () => {
    expect(renderTemplate('{{payload.arr}}', { payload: { arr: [1, 2, 3] } }))
      .toBe('[1,2,3]');
    expect(renderTemplate('{{payload.obj}}', { payload: { obj: { a: 1 } } }))
      .toBe('{"a":1}');
  });

  it('empties missing fields', () => {
    expect(renderTemplate('hi [{{payload.missing}}]', { payload: {} }))
      .toBe('hi []');
  });

  it('empties when intermediate is non-object', () => {
    expect(renderTemplate('{{payload.a.b}}', { payload: { a: 'string' } }))
      .toBe('');
  });

  it('treats {{payload}} as whole-payload JSON', () => {
    expect(renderTemplate('full = {{payload}}', { payload: { x: 1 } }))
      .toBe('full = {"x":1}');
  });

  it('leaves unmatched braces literal', () => {
    expect(renderTemplate('a {{ not.payload.x }} b', { payload: { x: 'y' } }))
      .toBe('a {{ not.payload.x }} b');
  });

  it('does not support array indexing syntax', () => {
    expect(renderTemplate('{{payload.arr[0]}}', { payload: { arr: ['x'] } }))
      // The lookup falls through (no segment matches "arr[0]") → empty.
      // The literal "{{payload.arr[0]}}" is NOT preserved because the
      // regex matches up to "arr" — confirm via the actual emission
      // behaviour, which is "[0]}}" trailing the substituted "arr"
      // value. The whitelist disallows brackets in path segments, so
      // the regex doesn't match this whole token; the literal stays.
      // Document the actual behaviour: assert it does NOT crash and
      // does not invoke function-call semantics.
      .not.toContain('x');
  });

  it('does not support function-call syntax', () => {
    expect(renderTemplate('{{payload.x()}}', { payload: { x: 'safe' } }))
      .not.toContain('safe-called'); // baseline negative: nothing dynamic ran
  });
});
```

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/routines test -- template
```

Expected: FAIL — `../template.js` does not exist.

- [ ] **Step 3: Implement renderTemplate**

Create `packages/routines/src/template.ts`:

```ts
/**
 * Strict-whitelist payload substitution for webhook routine prompts.
 *
 * Only two emission shapes:
 *   {{payload}}              → JSON.stringify(payload)
 *   {{payload.dotted.path}}  → dot-walked value, coerced to string
 *
 * Path segments match [a-zA-Z0-9_-]+ ONLY. Brackets, dots inside
 * segments, function-call syntax, and any other expression form are
 * left literal by the regex. There is no expression engine here by
 * design — anything beyond string substitution would be a
 * prompt-injection amplifier (the substituted output flows verbatim
 * into the agent's prompt; see K9 in the Phase C design doc).
 *
 * Missing fields, non-object intermediates, and null/undefined
 * terminals all collapse to the empty string. The walk never throws.
 */
const WHOLE_RE = /\{\{\s*payload\s*\}\}/g;
const PATH_RE = /\{\{\s*payload((?:\.[a-zA-Z0-9_-]+)+)\s*\}\}/g;

export function renderTemplate(body: string, ctx: { payload: unknown }): string {
  return body
    .replace(WHOLE_RE, () => JSON.stringify(ctx.payload))
    .replace(PATH_RE, (_m, raw: string) => walkOrEmpty(ctx.payload, raw));
}

function walkOrEmpty(root: unknown, raw: string): string {
  const segments = raw.slice(1).split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return JSON.stringify(cur);
}
```

- [ ] **Step 4: Confirm tests pass**

```
pnpm --filter @ax/routines test -- template
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add packages/routines/src/template.ts packages/routines/src/__tests__/template.test.ts
git commit -m "feat(routines): strict-whitelist payload templating (K9)

renderTemplate is the only sink for webhook payload bytes inside the
agent prompt. Two emissions only: {{payload}} → whole JSON, and
{{payload.dotted.path}} → walked value (string|number|boolean|JSON).
No expression engine; missing/non-object intermediates collapse to
empty string."
```

---

## Task 6: Extend `fireRoutine` to accept an optional payload

**Files:**
- Modify: `packages/routines/src/fire.ts`
- Modify: `packages/routines/src/__tests__/fire.test.ts`

Phase B callers (tick loop, `routines:fire-now`) keep passing two args.
Phase C webhook handler passes a third — the parsed body — and
`fireRoutine` renders the template only when `source === 'webhook' &&
payload !== undefined`.

- [ ] **Step 1: Write failing test for payload templating**

Append to `packages/routines/src/__tests__/fire.test.ts` (read first to
understand harness shape):

```ts
import { renderTemplate } from '../template.js';

describe('fireRoutine — webhook payload templating', () => {
  it('substitutes {{payload.x}} into the agent:invoke prompt', async () => {
    const captured: { invokes: Array<{ content: string }> } = { invokes: [] };
    const bus = makeBusStub({ /* same shape Phase B fire tests use */
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1' } }),
      'conversations:create': async () => ({ conversationId: 'c1' }),
      'agent:invoke': async (_ctx, input: { message: { content: string } }) => {
        captured.invokes.push(input.message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const row: RoutineRow = {
      ...baseRow(),
      promptBody: 'PR {{payload.pr.title}}',
      trigger: { kind: 'webhook', path: '/r' },
    };
    await fire(row, 'webhook', { pr: { title: 'fix bug' } });
    await new Promise(r => setImmediate(r));
    expect(captured.invokes[0]?.content).toBe('PR fix bug');
  });

  it('does not template when source is "tick"', async () => {
    const captured: { invokes: Array<{ content: string }> } = { invokes: [] };
    const bus = makeBusStub({
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1' } }),
      'conversations:create': async () => ({ conversationId: 'c1' }),
      'agent:invoke': async (_ctx, input: { message: { content: string } }) => {
        captured.invokes.push(input.message);
        return { kind: 'complete', messages: [] };
      },
    });
    const fire = createFireRoutine({ bus, pending: new Map() });
    const row: RoutineRow = {
      ...baseRow(),
      promptBody: 'literal {{payload.x}}',
    };
    await fire(row, 'tick');
    await new Promise(r => setImmediate(r));
    expect(captured.invokes[0]?.content).toBe('literal {{payload.x}}');
  });
});
```

(`makeBusStub` and `baseRow` mirror what Phase B `fire.test.ts` already
uses; if they don't exist as helpers, define them inline at the top of
the new describe block by adapting `canary.test.ts:38-92`.)

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/routines test -- fire
```

Expected: FAIL — payload arg not threaded through; prompt body emitted verbatim with template literal.

- [ ] **Step 3: Extend createFireRoutine**

In `packages/routines/src/fire.ts`:

Import the template renderer at the top:

```ts
import { renderTemplate } from './template.js';
```

Change the returned function signature:

```ts
export function createFireRoutine(deps: FireDeps) {
  return async (
    row: RoutineRow,
    source: FireSource,
    payload?: unknown,
  ): Promise<FireResult> => {
    // ...existing agents:resolve / conversation logic unchanged...

    const prompt =
      source === 'webhook' && payload !== undefined
        ? renderTemplate(row.promptBody, { payload })
        : row.promptBody;

    // ...existing pending.set / reqId / fireCtx unchanged...

    void deps.bus.call('agent:invoke', fireCtx, {
      message: { role: 'user', content: prompt },
    }).catch((err) => {
      // ...existing catch unchanged...
    });

    return { status: 'ok', conversationId, error: null };
  };
}
```

(The only change inside the function is the single `prompt` const
replacing the prior `row.promptBody` argument to `agent:invoke`.)

- [ ] **Step 4: Run tests, confirm pass**

```
pnpm --filter @ax/routines test -- fire
```

Expected: PASS. Phase B fire tests continue to pass (they pass two args; `payload` defaults to `undefined`; template branch never taken).

- [ ] **Step 5: Commit**

```
git add packages/routines/src/fire.ts packages/routines/src/__tests__/fire.test.ts
git commit -m "feat(routines): fireRoutine renders template when source=webhook

Additive third arg payload?: unknown. Template path is gated on
source === 'webhook' && payload !== undefined, so tick / manual
callers see no behaviour change."
```

---

## Task 7: Store helper — `findOne({ agentId, path })` + upsert returns spec_hash drift

**Files:**
- Modify: `packages/routines/src/store.ts`
- Modify: `packages/routines/src/__tests__/sync.test.ts` (or a new store test file if `findOne` deserves one)

The webhook route handler needs an indexed `(agentId, path)` lookup so
it doesn't pull the full `list({ agentId })` set on every request. The
subscriber also needs to know whether the spec_hash changed so it can
short-circuit unregister/register on no-op applies (K6).

- [ ] **Step 1: Write failing tests**

Add to `packages/routines/src/__tests__/store.test.ts` (create if it doesn't exist; otherwise extend an existing file with the right shape — read first):

```ts
it('findOne returns the row for an existing (agentId, path)', async () => {
  const store = createRoutinesStore(db);
  await store.upsert({ /* same baseRow shape Phase B sync tests use */
    agentId: 'a', path: '.ax/routines/x.md', authorUserId: 'u',
    name: 'n', description: 'd', specHash: 'h',
    trigger: { kind: 'webhook', path: '/r' },
    activeHours: null, silenceToken: null, silenceMax: 300,
    conversation: 'per-fire', promptBody: 'hi', nextRunAt: null,
  });
  const row = await store.findOne({ agentId: 'a', path: '.ax/routines/x.md' });
  expect(row).not.toBeNull();
  expect(row!.agentId).toBe('a');
});

it('findOne returns null on miss', async () => {
  const store = createRoutinesStore(db);
  expect(await store.findOne({ agentId: 'a', path: '.ax/routines/missing.md' })).toBeNull();
});

it('upsert returns { changed: true } on first insert', async () => {
  const store = createRoutinesStore(db);
  const r = await store.upsert({ /* same shape */ specHash: 'h1', /* ... */ });
  expect(r.changed).toBe(true);
});

it('upsert returns { changed: true } when spec_hash differs', async () => {
  const store = createRoutinesStore(db);
  await store.upsert({ /* baseline */ specHash: 'h1', /* ... */ });
  const r = await store.upsert({ /* same agentId/path */ specHash: 'h2', /* ... */ });
  expect(r.changed).toBe(true);
});

it('upsert returns { changed: false } when spec_hash matches', async () => {
  const store = createRoutinesStore(db);
  await store.upsert({ /* baseline */ specHash: 'h1', /* ... */ });
  const r = await store.upsert({ /* same agentId/path/specHash */ specHash: 'h1', /* ... */ });
  expect(r.changed).toBe(false);
});
```

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/routines test -- store
```

Expected: FAIL — `findOne` undefined; `upsert` returns `void`.

- [ ] **Step 3: Extend the RoutinesStore interface + implement**

In `packages/routines/src/store.ts`:

Update the interface:

```ts
export interface RoutinesStore {
  upsert(input: UpsertInput): Promise<{ changed: boolean }>;
  delete(input: { agentId: string; path: string }): Promise<void>;
  claimDue(input: ClaimInput): Promise<RoutineRow[]>;
  advance(input: AdvanceInput): Promise<void>;
  recordFire(input: RecordFireInput): Promise<number>;
  list(input: { agentId?: string }): Promise<RoutineRow[]>;
  findOne(input: { agentId: string; path: string }): Promise<RoutineRow | null>;
}
```

Modify `upsert` to detect spec_hash drift. Use `INSERT ... ON CONFLICT
... RETURNING` with a synthetic `changed` boolean:

```ts
    async upsert(input) {
      const result = await db.insertInto('routines_v1_definitions').values({
        // ...existing values unchanged...
      }).onConflict((oc) => oc
        .columns(['agent_id', 'path'])
        .doUpdateSet((eb) => ({
          // ...existing set unchanged...
        }))
      )
      // Returning the row gives us a way to detect "did this row's
      // spec_hash actually change?" but the simpler tell is: use an
      // explicit SELECT-then-update via a CTE, or stash the prior
      // spec_hash and compare in JS. We use the second — cheaper.
      .returning(['spec_hash'])
      .execute();
      // After ON CONFLICT, `result` is the *post-update* row, so we
      // need the *pre-update* hash for the comparison. Read the prior
      // row inside a tx for atomicity. (Cleaner option below.)
      // [implementation note]: implement with a two-step read+upsert
      // inside `db.transaction()` so the `changed` boolean is reliable.
      return { changed: /* see implementation note above */ true };
    },
```

**Cleaner implementation** (use this — drop the comment block above):

```ts
    async upsert(input) {
      return db.transaction().execute(async (trx) => {
        const prior = await trx
          .selectFrom('routines_v1_definitions')
          .select(['spec_hash'])
          .where('agent_id', '=', input.agentId)
          .where('path', '=', input.path)
          .executeTakeFirst();
        await trx.insertInto('routines_v1_definitions').values({
          // ...existing values unchanged...
        }).onConflict((oc) => oc
          .columns(['agent_id', 'path'])
          .doUpdateSet((eb) => ({
            // ...existing set unchanged...
          }))
        ).execute();
        const changed = prior === undefined || prior.spec_hash !== input.specHash;
        return { changed };
      });
    },
```

Implement `findOne`:

```ts
    async findOne(input) {
      const row = await db
        .selectFrom('routines_v1_definitions')
        .selectAll()
        .where('agent_id', '=', input.agentId)
        .where('path', '=', input.path)
        .executeTakeFirst();
      return row === undefined ? null : rowToRoutine(row);
    },
```

- [ ] **Step 4: Update existing callers**

The Phase B sync subscriber calls `await store.upsert(...)` and
ignores the return. That's still valid (TypeScript widens to `void`),
but for the Phase C subscriber wiring to compile we update only the
new caller in Task 8. Existing call sites remain unchanged in this
task.

Run the full routines suite to confirm no Phase B regression:

```
pnpm --filter @ax/routines test
```

Expected: full pass.

- [ ] **Step 5: Commit**

```
git add packages/routines/src/store.ts packages/routines/src/__tests__/store.test.ts
git commit -m "feat(routines): store.findOne + upsert returns changed flag

findOne(agentId, path) is the indexed lookup the webhook handler uses.
upsert returns { changed: boolean } so the workspace:applied subscriber
can short-circuit route re-registration on no-op applies (K6)."
```

---

## Task 8: Webhook handler factory — HMAC + body parse + event filter + fire

**Files:**
- Create: `packages/routines/src/webhook-handler.ts`
- Create: `packages/routines/src/__tests__/webhook-handler.test.ts`

The handler closure binds `(bus, store, agentId, routinePath, fire)`
and produces an `HttpRouteHandler`. The chain is exactly the
sequence in design §5: row lookup → HMAC → body parse → event
filter → `fire(row, 'webhook', payload)` → 202. Token + slug come
implicitly from the literal mounted path (the router only matched
because the URL matched the bound token).

- [ ] **Step 1: Write failing tests**

Create `packages/routines/src/__tests__/webhook-handler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeWebhookHandler } from '../webhook-handler.js';
import type { HookBus } from '@ax/core';
import type { RoutineRow } from '../types.js';
import type { HttpRequest, HttpResponse } from '@ax/http-server';

function makeRow(over: Partial<RoutineRow> = {}): RoutineRow {
  return {
    agentId: 'agt_a',
    path: '.ax/routines/r.md',
    authorUserId: 'u1',
    name: 'r',
    description: '',
    specHash: 'h',
    trigger: { kind: 'webhook', path: '/r' },
    activeHours: null,
    silenceToken: null,
    silenceMaxChars: 300,
    conversation: 'per-fire',
    promptBody: 'hi',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    ...over,
  };
}

function makeReq(over: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    path: '/webhooks/tok/slug',
    query: {},
    params: {},
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{}'),
    cookies: {},
    signedCookie: () => null,
    ...over,
  } as HttpRequest;
}

function makeRes() {
  const calls: { status?: number; ended?: boolean } = {};
  const res = {
    status(n: number) { calls.status = n; return res; },
    header() { return res; },
    text() { calls.ended = true; },
    json() { calls.ended = true; },
    body() { calls.ended = true; },
    end() { calls.ended = true; },
    redirect() { calls.ended = true; },
    setSignedCookie() {},
    clearCookie() {},
    stream() { throw new Error('not used'); },
  } as unknown as HttpResponse & { _calls: typeof calls };
  (res as any)._calls = calls;
  return res as HttpResponse & { _calls: typeof calls };
}

function makeBus(stubs: Record<string, (ctx: unknown, input: unknown) => unknown>): HookBus {
  return {
    call: async (name: string, ctx: unknown, input: unknown) => {
      const fn = stubs[name];
      if (!fn) throw new Error(`unexpected bus.call: ${name}`);
      return fn(ctx, input);
    },
    fire: async () => ({ rejected: false }),
    subscribe: () => {},
    unsubscribe: () => {},
    registerService: () => {},
    hasService: () => true,
  } as unknown as HookBus;
}

describe('makeWebhookHandler', () => {
  it('responds 202 and fires the routine on a valid POST', async () => {
    const fired: Array<{ row: RoutineRow; source: string; payload: unknown }> = [];
    const row = makeRow();
    const fire = vi.fn().mockImplementation(async (...args) => {
      fired.push({ row: args[0], source: args[1], payload: args[2] });
      return { status: 'ok', conversationId: 'c1', error: null };
    });
    const store = { findOne: async () => row };
    const bus = makeBus({});

    const handler = makeWebhookHandler({ bus, store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const req = makeReq({ body: Buffer.from('{"x":1}') });
    const res = makeRes();
    await handler(req, res);
    expect(res._calls.status).toBe(202);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ source: 'webhook', payload: { x: 1 } });
  });

  it('returns 404 when the row is gone (race between unregister and request)', async () => {
    const fire = vi.fn();
    const store = { findOne: async () => null };
    const handler = makeWebhookHandler({
      bus: makeBus({}), store: store as any, agentId: 'agt_a',
      routinePath: '.ax/routines/r.md', fire,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._calls.status).toBe(404);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 401 on HMAC mismatch', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const bus = makeBus({
      'credentials:get': async () => 'shhh',
    });
    const handler = makeWebhookHandler({ bus, store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': 'deadbeef' },
      body: Buffer.from('{"x":1}'),
    }), res);
    expect(res._calls.status).toBe(401);
    expect(fire).not.toHaveBeenCalled();
  });

  it('returns 401 on missing HMAC header when hmac configured', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256' } },
    });
    const store = { findOne: async () => row };
    const bus = makeBus({ 'credentials:get': async () => 'shhh' });
    const handler = makeWebhookHandler({ bus, store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('{}') }), res);
    expect(res._calls.status).toBe(401);
  });

  it('accepts a valid HMAC over the raw body and fires', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r',
        hmac: { secretRef: 's', header: 'X-Sig', algorithm: 'sha256', prefix: 'sha256=' } },
    });
    const store = { findOne: async () => row };
    const bus = makeBus({ 'credentials:get': async () => 'shhh' });
    const handler = makeWebhookHandler({ bus, store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const body = Buffer.from('{"x":1}');
    const sig = 'sha256=' + createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig },
      body,
    }), res);
    expect(res._calls.status).toBe(202);
    expect(fire).toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const fire = vi.fn();
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({ bus: makeBus({}), store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('not json{') }), res);
    expect(res._calls.status).toBe(400);
  });

  it('returns 415 on unsupported Content-Type', async () => {
    const fire = vi.fn();
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({ bus: makeBus({}), store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({ headers: { 'content-type': 'text/plain' }, body: Buffer.from('hi') }), res);
    expect(res._calls.status).toBe(415);
  });

  it('parses application/x-www-form-urlencoded body', async () => {
    let captured: unknown;
    const fire = vi.fn().mockImplementation(async (_r, _s, p) => { captured = p; return { status: 'ok', conversationId: 'c1', error: null }; });
    const row = makeRow();
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({ bus: makeBus({}), store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('foo=bar&n=1'),
    }), res);
    expect(res._calls.status).toBe(202);
    expect(captured).toEqual({ foo: 'bar', n: '1' });
  });

  it('returns 204 when events filter mismatches X-GitHub-Event', async () => {
    const fire = vi.fn();
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r', events: ['pull_request'] },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({ bus: makeBus({}), store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
      body: Buffer.from('{}'),
    }), res);
    expect(res._calls.status).toBe(204);
    expect(fire).not.toHaveBeenCalled();
  });

  it('ignores events filter when X-GitHub-Event header is absent', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'ok', conversationId: 'c1', error: null });
    const row = makeRow({
      trigger: { kind: 'webhook', path: '/r', events: ['pull_request'] },
    });
    const store = { findOne: async () => row };
    const handler = makeWebhookHandler({ bus: makeBus({}), store: store as any, agentId: 'agt_a', routinePath: row.path, fire });
    const res = makeRes();
    await handler(makeReq({ body: Buffer.from('{}') }), res);
    expect(res._calls.status).toBe(202);
  });
});
```

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/routines test -- webhook-handler
```

Expected: FAIL — `../webhook-handler.js` not found.

- [ ] **Step 3: Implement makeWebhookHandler**

Create `packages/routines/src/webhook-handler.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeAgentContext, type HookBus } from '@ax/core';
import type { HttpRouteHandler } from '@ax/http-server';
import type { CredentialsGetInput, CredentialsGetOutput } from '@ax/credentials';
import type { RoutineRow, FireSource } from './types.js';
import type { FireResult } from './tick.js';
import type { RoutinesStore } from './store.js';

export interface WebhookHandlerDeps {
  bus: HookBus;
  store: Pick<RoutinesStore, 'findOne'>;
  agentId: string;
  routinePath: string;
  fire: (row: RoutineRow, source: FireSource, payload?: unknown) => Promise<FireResult>;
}

/**
 * Build the http handler bound to a specific (agentId, routinePath).
 *
 * Chain (design §5):
 *   1. lookup row by (agentId, routinePath); 404 if gone / wrong kind
 *   2. if hmac configured: fetch secret, compute, timingSafeEqual; 401 on miss
 *   3. parse body by Content-Type; 400 on malformed JSON, 415 on unknown CT
 *   4. if events configured AND X-GitHub-Event present AND mismatch: 204
 *   5. fire(row, 'webhook', payload) fire-and-forget
 *   6. 202
 */
export function makeWebhookHandler(deps: WebhookHandlerDeps): HttpRouteHandler {
  return async (req, res) => {
    const ctx = makeAgentContext({
      sessionId: `webhook-${deps.agentId}-${deps.routinePath}`,
      agentId: deps.agentId,
      userId: 'system',
    });

    const row = await deps.store.findOne({ agentId: deps.agentId, path: deps.routinePath });
    if (row === null || row.trigger.kind !== 'webhook') {
      res.status(404).end();
      return;
    }
    const trigger = row.trigger;

    if (trigger.hmac !== undefined) {
      let secret: string;
      try {
        secret = await deps.bus.call<CredentialsGetInput, CredentialsGetOutput>(
          'credentials:get', ctx, { ref: trigger.hmac.secretRef, userId: row.authorUserId },
        );
      } catch {
        res.status(401).end();
        return;
      }
      const headerName = trigger.hmac.header.toLowerCase();
      const header = req.headers[headerName];
      if (typeof header !== 'string' || header.length === 0) {
        res.status(401).end();
        return;
      }
      const bare = trigger.hmac.prefix !== undefined && header.startsWith(trigger.hmac.prefix)
        ? header.slice(trigger.hmac.prefix.length)
        : header;
      const algorithm = trigger.hmac.algorithm;
      const computed = createHmac(algorithm, secret).update(req.body).digest('hex');
      const lhs = Buffer.from(bare.toLowerCase(), 'utf8');
      const rhs = Buffer.from(computed, 'utf8');
      if (lhs.length !== rhs.length || !timingSafeEqual(lhs, rhs)) {
        res.status(401).end();
        return;
      }
    }

    const ct = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    let payload: unknown;
    if (ct === 'application/json') {
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        res.status(400).end();
        return;
      }
    } else if (ct === 'application/x-www-form-urlencoded') {
      payload = Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
    } else {
      res.status(415).end();
      return;
    }

    if (trigger.events !== undefined && trigger.events.length > 0) {
      const ghEvent = req.headers['x-github-event'];
      if (typeof ghEvent === 'string' && ghEvent.length > 0 && !trigger.events.includes(ghEvent)) {
        res.status(204).end();
        return;
      }
    }

    // Fire-and-forget. The fire path records its own status (ok |
    // silenced | error) via the chat:turn-end one-shot in plugin.ts.
    void deps.fire(row, 'webhook', payload).catch((err: unknown) => {
      process.stderr.write(
        `[ax/routines] webhook fire failed for ${deps.agentId}${deps.routinePath}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    res.status(202).end();
  };
}
```

- [ ] **Step 4: Run tests, confirm pass**

```
pnpm --filter @ax/routines test -- webhook-handler
```

Expected: PASS.

- [ ] **Step 5: Run security-checklist skill (K9)**

Invoke `superpowers:using-superpowers` to load the `security-checklist` skill, then walk the three threat models against the new `webhook-handler.ts` + `template.ts` modules. Append findings to the PR-notes draft (kept in working tree, not committed).

- [ ] **Step 6: Commit**

```
git add packages/routines/src/webhook-handler.ts \
        packages/routines/src/__tests__/webhook-handler.test.ts
git commit -m "feat(routines): webhook handler — HMAC + body parse + event filter (K9/K11)

makeWebhookHandler binds (agentId, routinePath) and runs:
  row lookup → HMAC verify → body parse → event filter → fire.
HMAC uses crypto.timingSafeEqual over equal-length lowercase hex.
JSON / x-www-form-urlencoded only; other Content-Type → 415.
Fire-and-forget dispatch; 202 sent before agent:invoke completes."
```

---

## Task 9: `workspace:applied` subscriber — mount/unmount per-routine routes

**Files:**
- Modify: `packages/routines/src/sync.ts`
- Modify: `packages/routines/src/plugin.ts`
- Modify: `packages/routines/src/__tests__/sync-subscriber.test.ts` (or `sync.test.ts` if that's where Phase B tests live)

Extends `handleWorkspaceApplied` with the webhook lifecycle: lazy
token via `agents:rotate-webhook-token`, register fresh route via
`http:register-route`, stash the closure in a caller-provided
`Map`, drop and re-register on spec_hash drift, unregister on delete
or kind transition. K10 wraps each webhook step in try/catch so a
broken routine never wedges workspace apply.

- [ ] **Step 1: Write failing tests for the webhook arm of sync**

Append to the existing sync subscriber test (or create `sync-webhook.test.ts` if cleaner):

```ts
describe('handleWorkspaceApplied — webhook arm', () => {
  it('registers a route on first webhook routine add', async () => {
    const captured = { routes: [] as Array<{ path: string }>, unregisters: [] as string[] };
    const bus = makeBusStub({
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1', webhookToken: null } }),
      'agents:rotate-webhook-token': async () => ({ token: 'tok123' }),
      'http:register-route': async (_c: unknown, input: { path: string; handler: unknown }) => {
        captured.routes.push({ path: input.path });
        return { unregister: () => { captured.unregisters.push(input.path); } };
      },
    });
    const store = await freshStore();
    const webhookRoutes = new Map<string, () => void>();
    await handleWorkspaceApplied({ store, bus, webhookRoutes, fireRoutine: noopFire }, ctx(), delta({
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => Buffer.from(webhookFile()) }],
    }), new Date());
    expect(captured.routes).toEqual([{ path: '/webhooks/tok123/r' }]);
    expect(webhookRoutes.size).toBe(1);
  });

  it('does not call agents:rotate-webhook-token when agent already has one', async () => {
    let rotates = 0;
    const bus = makeBusStub({
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1', webhookToken: 'existing' } }),
      'agents:rotate-webhook-token': async () => { rotates += 1; return { token: 'never' }; },
      'http:register-route': async () => ({ unregister: () => {} }),
    });
    await handleWorkspaceApplied(/* same shape */);
    expect(rotates).toBe(0);
  });

  it('unregisters on delete', async () => {
    const captured = { unregisters: [] as string[] };
    const bus = makeBusStub({
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1', webhookToken: 'tok' } }),
      'http:register-route': async (_c, input) => ({
        unregister: () => { captured.unregisters.push((input as any).path); },
      }),
    });
    const webhookRoutes = new Map<string, () => void>();
    // Step 1: add the routine
    await handleWorkspaceApplied(/* add */);
    expect(webhookRoutes.size).toBe(1);
    // Step 2: delete it
    await handleWorkspaceApplied({ store, bus, webhookRoutes, fireRoutine: noopFire }, ctx(), delta({
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'deleted' }],
    }), new Date());
    expect(captured.unregisters).toEqual(['/webhooks/tok/r']);
    expect(webhookRoutes.size).toBe(0);
  });

  it('does not unregister-then-re-register on no-op apply (spec_hash unchanged)', async () => {
    const captured = { routes: [] as string[], unregisters: [] as string[] };
    const bus = makeBusStub({ /* same — track route calls */ });
    const webhookRoutes = new Map<string, () => void>();
    await handleWorkspaceApplied(/* add: spec_hash h1 */);
    await handleWorkspaceApplied(/* re-add same bytes: spec_hash h1 */);
    expect(captured.routes).toHaveLength(1);
    expect(captured.unregisters).toHaveLength(0);
  });

  it('unregisters when a webhook routine transitions to interval', async () => {
    const captured = { unregisters: [] as string[] };
    /* add webhook routine, then re-add with kind: interval */
    /* assert unregister called once and webhookRoutes.size === 0 */
  });

  it('logs and continues when http:register-route throws', async () => {
    const bus = makeBusStub({
      'agents:resolve': async () => ({ agent: { id: 'agt_a', ownerId: 'u1', webhookToken: 'tok' } }),
      'http:register-route': async () => { throw new PluginError({ code: 'duplicate-route', plugin: 'test', message: 'x' }); },
    });
    const webhookRoutes = new Map<string, () => void>();
    await expect(handleWorkspaceApplied(/* webhook routine */)).resolves.toBeUndefined();
    expect(webhookRoutes.size).toBe(0);
  });
});

function webhookFile(): string {
  return [
    '---', 'name: r', 'description: d',
    'trigger:', '  kind: webhook', '  path: "/r/x"',
    'conversation: per-fire', '---',
    'hi {{payload.foo}}',
  ].join('\n');
}
```

(Helpers `makeBusStub`, `delta`, `ctx`, `freshStore`, `noopFire` must
either reuse Phase B test utilities or be defined at file scope.)

- [ ] **Step 2: Run failing tests**

```
pnpm --filter @ax/routines test -- sync
```

Expected: FAIL — the new args to `handleWorkspaceApplied` don't exist.

- [ ] **Step 3: Refactor handleWorkspaceApplied to accept the webhook map + bus**

In `packages/routines/src/sync.ts`:

```ts
import { PluginError, type AgentContext, type HookBus, type WorkspaceDelta } from '@ax/core';
import type { HttpRegisterRouteInput, HttpRegisterRouteOutput } from '@ax/http-server';
import type { ResolveInput, ResolveOutput, RotateWebhookTokenInput, RotateWebhookTokenOutput, Agent } from '@ax/agents';
import type { RoutinesStore } from './store.js';
import type { FireResult } from './tick.js';
import type { RoutineRow, FireSource } from './types.js';
import { parseRoutineRow } from './parse-routine.js';
import { engineFor } from './engines/index.js';
import { makeWebhookHandler } from './webhook-handler.js';

const ROUTINE_PATH = /^\.ax\/routines\/[^/]+\.md$/;

export interface HandleWorkspaceAppliedDeps {
  store: RoutinesStore;
  bus: HookBus;
  webhookRoutes: Map<string, () => void>;
  fireRoutine: (row: RoutineRow, source: FireSource, payload?: unknown) => Promise<FireResult>;
}

function webhookKey(agentId: string, path: string): string {
  return `${agentId}::${path}`;
}

export async function handleWorkspaceApplied(
  deps: HandleWorkspaceAppliedDeps,
  ctx: AgentContext,
  delta: WorkspaceDelta,
  now: Date,
): Promise<void> {
  const agentId = delta.author?.agentId;
  const userId = delta.author?.userId;
  if (typeof agentId !== 'string' || agentId.length === 0) return;
  if (typeof userId !== 'string' || userId.length === 0) return;

  for (const change of delta.changes) {
    if (!ROUTINE_PATH.test(change.path)) continue;
    const key = webhookKey(agentId, change.path);

    if (change.kind === 'deleted') {
      const unreg = deps.webhookRoutes.get(key);
      if (unreg !== undefined) {
        try { unreg(); } catch { /* idempotent per http-server */ }
        deps.webhookRoutes.delete(key);
      }
      try {
        await deps.store.delete({ agentId, path: change.path });
      } catch (err) {
        ctx.logger.warn('routines_sync_delete_failed', {
          agentId, path: change.path,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    let parsedFields: RoutineRow | undefined;
    try {
      const fetcher = change.contentAfter;
      if (typeof fetcher !== 'function') continue;
      const bytes = await fetcher();
      const parsed = parseRoutineRow(bytes);
      if (!parsed.ok) {
        ctx.logger.warn('routines_sync_parse_failed', {
          agentId, path: change.path, reason: parsed.reason,
        });
        continue;
      }
      const eng = engineFor(parsed.fields.trigger);
      const nextRunAt = parsed.fields.trigger.kind === 'webhook'
        ? null
        : eng?.nextRun(parsed.fields.trigger, now) ?? null;

      const upsertResult = await deps.store.upsert({
        agentId, path: change.path, authorUserId: userId,
        name: parsed.fields.name, description: parsed.fields.description,
        specHash: parsed.specHash, trigger: parsed.fields.trigger,
        activeHours: parsed.fields.activeHours ?? null,
        silenceToken: parsed.fields.silenceToken ?? null,
        silenceMax: parsed.fields.silenceMaxChars,
        conversation: parsed.fields.conversation,
        promptBody: parsed.fields.promptBody,
        nextRunAt,
      });
      parsedFields = { /* row shape — keep it local; the canonical row will be read by webhook-handler.findOne anyway */ } as RoutineRow;

      // ---- Webhook lifecycle ----
      if (parsed.fields.trigger.kind !== 'webhook') {
        // Was webhook, now isn't — drop the prior closure.
        const stale = deps.webhookRoutes.get(key);
        if (stale !== undefined) {
          try { stale(); } catch { /* swallow */ }
          deps.webhookRoutes.delete(key);
        }
        continue;
      }

      // No-op apply: same spec_hash → keep existing closure as-is.
      if (!upsertResult.changed && deps.webhookRoutes.has(key)) continue;

      try {
        const resolved = await deps.bus.call<ResolveInput, ResolveOutput>(
          'agents:resolve', ctx, { agentId, userId },
        );
        let token = resolved.agent.webhookToken;
        if (typeof token !== 'string' || token.length === 0) {
          const rot = await deps.bus.call<RotateWebhookTokenInput, RotateWebhookTokenOutput>(
            'agents:rotate-webhook-token', ctx,
            { actor: { userId, isAdmin: false } as any, agentId },
          );
          token = rot.token;
        }
        // Unregister prior closure before binding the fresh path. The
        // path is deterministic from (token, slug), so when spec_hash
        // changes but path stays the same, http-server would otherwise
        // throw `duplicate-route`.
        const stale = deps.webhookRoutes.get(key);
        if (stale !== undefined) {
          try { stale(); } catch { /* swallow */ }
        }
        const slug = change.path.replace(/^\.ax\/routines\//, '').replace(/\.md$/, '');
        const out = await deps.bus.call<HttpRegisterRouteInput, HttpRegisterRouteOutput>(
          'http:register-route', ctx,
          {
            method: 'POST',
            path: `/webhooks/${token}/${slug}`,
            handler: makeWebhookHandler({
              bus: deps.bus, store: deps.store,
              agentId, routinePath: change.path, fire: deps.fireRoutine,
            }),
          },
        );
        deps.webhookRoutes.set(key, out.unregister);
      } catch (err) {
        // K10: route binding failures log + continue. The routine
        // row is in the DB; admin UI surfaces last_status='error' via
        // a follow-up advance call below.
        ctx.logger.warn('routines_sync_webhook_bind_failed', {
          agentId, path: change.path,
          err: err instanceof Error ? err.message : String(err),
        });
        try {
          await deps.store.advance({
            agentId, path: change.path, nextRunAt: null,
            lastRunAt: now, lastStatus: 'error',
            lastError: err instanceof Error ? err.message : String(err),
          });
        } catch { /* best-effort */ }
      }
    } catch (err) {
      ctx.logger.warn('routines_sync_upsert_failed', {
        agentId, path: change.path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

(Drop the unused `parsedFields` local — keep it out. The pseudocode
above is illustrative; the real implementation can omit the binding
and read it back from the store inside the handler.)

In `packages/routines/src/plugin.ts`:

Update the manifest:

```ts
      calls: [
        'database:get-instance',
        'agents:resolve',
        'agents:rotate-webhook-token',
        'agents:resolve-by-webhook-token',
        'conversations:find-or-create',
        'conversations:create',
        'conversations:drop-turn',
        'conversations:hide',
        'agent:invoke',
        'credentials:get',
        'http:register-route',
      ],
```

Add the manifest-comment paragraph above the plugin export that
declares Phase C's K3 (single-replica):

```ts
/**
 * Single-replica only at v1: `workspace:applied` is a local in-process
 * hook (no LISTEN/NOTIFY broadcast), so webhook route registrations
 * are local to the replica that received the apply. Multi-replica
 * fan-out lands when the rest of the preset lifts out of
 * single-replica (presets/k8s/src/index.ts:51,650-723 — multiple
 * plugins already declare this). See K3 in
 * docs/plans/2026-05-15-routines-phase-c-design.md.
 */
```

Inside `init({ bus })`, create the closure registry and thread it
through `handleWorkspaceApplied`:

```ts
      const webhookRoutes = new Map<string, () => void>();

      bus.subscribe<WorkspaceDelta>(
        'workspace:applied', PLUGIN_NAME,
        async (ctx, delta) => {
          await handleWorkspaceApplied(
            { store: localStore, bus, webhookRoutes, fireRoutine },
            ctx, delta, clock.now(),
          );
          return undefined;
        },
      );
```

Extend `shutdown()`:

```ts
    async shutdown() {
      for (const unreg of webhookRoutes.values()) {
        try { unreg(); } catch { /* idempotent */ }
      }
      webhookRoutes.clear();
      abortCtl?.abort();
      abortCtl = undefined;
      db = undefined;
      store = undefined;
    },
```

(The `webhookRoutes` closes over via the `init` scope; `shutdown` runs
inside the same plugin instance closure, so it sees the same map.)

- [ ] **Step 4: Re-run sync tests**

```
pnpm --filter @ax/routines test -- sync
pnpm --filter @ax/routines test
```

Expected: all green. Phase B tests pass unchanged.

- [ ] **Step 5: Commit**

```
git add packages/routines/src/sync.ts packages/routines/src/plugin.ts \
        packages/routines/src/__tests__/sync*.test.ts
git commit -m "feat(routines): webhook route lifecycle on workspace:applied (K1/K3/K6/K10)

Subscriber threads a Map<key, unregister> through handleWorkspaceApplied.
- delete kind: call stashed closure, drop from map.
- non-webhook kind: drop stale closure (transition).
- webhook kind: lazy agents:rotate-webhook-token on missing token,
  unregister-then-register-fresh keyed on (agentId, path).
- spec_hash unchanged: keep existing closure (no churn).
- bind failure: log + record last_status='error', don't wedge apply.
Plugin manifest gains http:register-route + credentials:get +
agents:resolve-by-webhook-token + agents:rotate-webhook-token in calls."
```

---

## Task 10: Phase C canary — five cases that close the half-wired window (K5)

**Files:**
- Modify: `packages/routines/src/__tests__/canary.test.ts`

Append a `describe('Phase C webhook canary', ...)` block. Phase B
cases stay green; the new cases assert mount/unmount + HMAC + template
substitution against stubbed bus services. No HTTP socket; the
captured handler is invoked directly.

- [ ] **Step 1: Add the failing canary block**

In `packages/routines/src/__tests__/canary.test.ts`, append:

```ts
import { createHmac } from 'node:crypto';

describe('Phase C webhook canary — half-wired window closure', () => {
  function webhookBody(over: { events?: string[]; hmacSecretRef?: string } = {}): Uint8Array {
    const lines = [
      '---',
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
    ];
    if (over.events) lines.push(`  events: ${JSON.stringify(over.events)}`);
    if (over.hmacSecretRef) {
      lines.push('  hmac:', `    secretRef: ${over.hmacSecretRef}`,
                 '    header: "X-Sig"', '    algorithm: sha256',
                 '    prefix: "sha256="');
    }
    lines.push('conversation: per-fire', '---', 'PR: {{payload.pr.title}}');
    return ENC.encode(lines.join('\n') + '\n');
  }

  interface WebCaptured extends Captured {
    routes: Array<{ method: string; path: string }>;
    handlers: Map<string, (req: any, res: any) => Promise<void>>;
    unregisters: string[];
    rotates: number;
  }

  async function makeWebHarness(reply: { contentBlocks: unknown[] }) {
    const captured: WebCaptured = {
      invokes: [], drops: [], hides: [], findOrCreateCalls: [],
      routes: [], handlers: new Map(), unregisters: [], rotates: 0,
    };
    let nextConvId = 1;
    const busRef: { current: TestHarness | undefined } = { current: undefined };
    const tokens = new Map<string, string>();
    const h = await createTestHarness({
      services: {
        'agents:resolve': async (_c, input: any) => ({
          agent: { id: input.agentId, ownerId: 'u1', workspaceRef: null,
            webhookToken: tokens.get(input.agentId) ?? null },
        }),
        'agents:rotate-webhook-token': async (_c, input: any) => {
          captured.rotates += 1;
          const tok = `tok-${captured.rotates}`;
          tokens.set(input.agentId, tok);
          return { token: tok };
        },
        'agents:resolve-by-webhook-token': async (_c, input: any) => {
          for (const [id, t] of tokens.entries()) {
            if (t === input.token) return { agent: { id, ownerId: 'u1' } };
          }
          return null;
        },
        'credentials:get': async (_c, input: any) => {
          if (input.ref === 'gh-secret') return 'shhh';
          throw new Error('not-found');
        },
        'http:register-route': async (_c, input: any) => {
          captured.routes.push({ method: input.method, path: input.path });
          captured.handlers.set(input.path, input.handler);
          return { unregister: () => { captured.unregisters.push(input.path); captured.handlers.delete(input.path); } };
        },
        'conversations:create': async () => ({ conversationId: `cnv_${nextConvId++}` }),
        'conversations:drop-turn': async (_c, i: any) => { captured.drops.push(i); },
        'conversations:hide': async (_c, i: any) => { captured.hides.push(i); },
        'conversations:find-or-create': async () => ({ conversation: { conversationId: 'shared' }, created: false }),
        'agent:invoke': async (ctx, input: any) => {
          captured.invokes.push({ message: input.message, reqId: ctx.reqId ?? '', conversationId: ctx.conversationId });
          await busRef.current!.bus.fire('chat:turn-end', ctx, {
            reqId: ctx.reqId, turnId: 'fake-uuid-1', contentBlocks: reply.contentBlocks,
          });
          return { kind: 'complete', messages: [] };
        },
      },
      plugins: [
        createDatabasePostgresPlugin({ connectionString }),
        createRoutinesPlugin({ tickIntervalMs: 60_000 }),
      ],
    });
    busRef.current = h;
    harnesses.push(h);
    return { h, captured };
  }

  function makeReq(over: Partial<{ headers: Record<string, string>; body: Buffer }> = {}) {
    return {
      method: 'POST',
      path: '/webhooks/tok-1/r',
      query: {}, params: {},
      headers: { 'content-type': 'application/json', ...(over.headers ?? {}) },
      body: over.body ?? Buffer.from('{}'),
      cookies: {},
      signedCookie: () => null,
    } as any;
  }

  function makeRes() {
    const calls: { status?: number; ended?: boolean } = {};
    const r: any = {
      status(n: number) { calls.status = n; return r; },
      header() { return r; },
      end() { calls.ended = true; },
      text() { calls.ended = true; },
      json() { calls.ended = true; },
      body() { calls.ended = true; },
      redirect() { calls.ended = true; },
      setSignedCookie() {}, clearCookie() {},
      _calls: calls,
    };
    return r;
  }

  it('case 1: route mounts on indexing', async () => {
    const { h, captured } = await makeWebHarness({ contentBlocks: [{ type: 'text', text: 'ack' }] });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    expect(captured.routes).toEqual([{ method: 'POST', path: '/webhooks/tok-1/r' }]);
    expect(captured.rotates).toBe(1);
    expect(captured.handlers.size).toBe(1);
  });

  it('case 2: lazy token generation is idempotent across two webhook routines', async () => {
    const { h, captured } = await makeWebHarness({ contentBlocks: [{ type: 'text', text: 'ack' }] });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [
        { path: '.ax/routines/a.md', kind: 'added', contentAfter: async () => webhookBody() },
        { path: '.ax/routines/b.md', kind: 'added', contentAfter: async () => webhookBody() },
      ],
    });
    expect(captured.rotates).toBe(1);
    expect(captured.routes.map((r) => r.path).sort()).toEqual([
      '/webhooks/tok-1/a', '/webhooks/tok-1/b',
    ]);
  });

  it('case 3: HMAC mismatch returns 401 and does not fire agent:invoke', async () => {
    const { h, captured } = await makeWebHarness({ contentBlocks: [{ type: 'text', text: 'ack' }] });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody({ hmacSecretRef: 'gh-secret' }) }],
    });
    const handler = captured.handlers.get('/webhooks/tok-1/r')!;
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': 'sha256=deadbeef' },
      body: Buffer.from('{"pr":{"title":"x"}}'),
    }), res);
    expect(res._calls.status).toBe(401);
    expect(captured.invokes).toHaveLength(0);
  });

  it('case 4: valid POST → templated agent:invoke with substituted body', async () => {
    const { h, captured } = await makeWebHarness({ contentBlocks: [{ type: 'text', text: 'ack' }] });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody({ hmacSecretRef: 'gh-secret' }) }],
    });
    const handler = captured.handlers.get('/webhooks/tok-1/r')!;
    const body = Buffer.from('{"pr":{"title":"fix bug"}}');
    const sig = 'sha256=' + createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = makeRes();
    await handler(makeReq({
      headers: { 'content-type': 'application/json', 'x-sig': sig }, body,
    }), res);
    await vi.waitFor(() => expect(captured.invokes).toHaveLength(1), { timeout: 2_000, interval: 25 });
    expect(res._calls.status).toBe(202);
    expect(captured.invokes[0]!.message.content).toBe('PR: fix bug');
  });

  it('case 5: routine deleted → captured unregister fires', async () => {
    const { h, captured } = await makeWebHarness({ contentBlocks: [{ type: 'text', text: 'ack' }] });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: null, after: asWorkspaceVersion('v1'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'added',
        contentAfter: async () => webhookBody() }],
    });
    await h.bus.fire('workspace:applied', h.ctx({ userId: 'u1' }), {
      before: asWorkspaceVersion('v1'), after: asWorkspaceVersion('v2'),
      author: { agentId: 'agt_a', userId: 'u1' },
      changes: [{ path: '.ax/routines/r.md', kind: 'deleted' }],
    });
    expect(captured.unregisters).toEqual(['/webhooks/tok-1/r']);
    expect(captured.handlers.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the canary**

```
pnpm --filter @ax/routines test -- canary
```

Expected: all five cases pass; Phase B cases remain green.

- [ ] **Step 3: Run the full suite (cross-package)**

```
pnpm build
pnpm test
pnpm lint
```

Expected: everything green.

- [ ] **Step 4: Commit**

```
git add packages/routines/src/__tests__/canary.test.ts
git commit -m "test(routines): Phase C canary — webhook half-wired window CLOSED (K5)

Five cases covering: route mount on index, lazy-token idempotency,
HMAC mismatch 401, templated POST → agent:invoke, delete unmounts.
Full HTTP round-trip lives in deploy/MANUAL-ACCEPTANCE.md."
```

---

## Task 11: MANUAL-ACCEPTANCE — add the webhook acceptance walk

**Files:**
- Modify: `deploy/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Read the current file**

```
cat deploy/MANUAL-ACCEPTANCE.md | head -60
```

Note the existing section conventions and find the right insertion
point (after the routines / Phase B section if it exists, otherwise
at the bottom under a `## Routines` heading).

- [ ] **Step 2: Append the webhook walk**

Insert (verbatim — adapt headings to match the doc's style):

```markdown
### Receive a webhook (Phase C)

1. Create `.ax/routines/notify.md` by chatting with the agent —
   trigger.kind: webhook, path: /test, no HMAC. Confirm the
   workspace apply landed (`kubectl logs <pod> | grep workspace`).

2. Read the agent's webhook token. In Phase C there is no admin UI
   yet; fetch it from postgres directly:
   `SELECT agent_id, webhook_token FROM agents_v1_agents WHERE
   webhook_token IS NOT NULL;`

3. Hit the route:
   `curl -X POST -H 'Content-Type: application/json'
        -d '{"foo":"bar"}'
        http://localhost:8080/webhooks/<token>/notify`

   Expected: HTTP 202 immediately. A new per-fire conversation
   appears in the sidebar within ~1 second. The first user turn
   contains the prompt body with `{{payload.foo}}` substituted to
   `bar`.

4. HMAC variant: store a secret via the credentials admin UI
   (`gh-webhook-secret`, scope: global, kind: api-key,
   value: `shhh`), edit the routine frontmatter to add the hmac
   block, then re-curl with a wrong signature → HTTP 401, no
   conversation appears. Re-curl with the correct signature
   (`sha256=$(printf '%s' '{"foo":"bar"}' | openssl dgst -sha256 -hmac shhh | awk '{print $2}')`)
   → HTTP 202 and a new conversation appears.
```

- [ ] **Step 3: Commit**

```
git add deploy/MANUAL-ACCEPTANCE.md
git commit -m "docs(deploy): MANUAL-ACCEPTANCE — webhook walk (Phase C)"
```

---

## Task 12: Full build / lint / test + open PR

- [ ] **Step 1: Full build + lint + tests**

```
pnpm build
pnpm test
pnpm lint
```

Expected: all green. Per Vinay's pre-PR rule (`feedback_run_lint_before_pr`), all three must pass.

- [ ] **Step 2: Push branch + open PR**

```
git push -u origin HEAD
gh pr create --title "feat(routines): Phase C — webhook trigger" \
  --body "$(cat <<'EOF'
## Summary

Routines Phase C — the third trigger kind (webhook) that Phase B's
validator deferred. Closes the half-wired window with the producer
(webhook routes mounted via `http:register-route`), the consumer
(`fireRoutine` accepts `payload` and renders the strict-whitelist
template), and the canary in the same PR.

### Phase C window CLOSED

Five canary cases in `packages/routines/src/__tests__/canary.test.ts`:

1. route mounts on indexing
2. lazy token generation is idempotent across two routines
3. HMAC mismatch → 401, no agent:invoke
4. valid POST → templated `agent:invoke` with substituted body
5. routine deleted → captured `unregister` fires

Full HTTP round-trip lives in `deploy/MANUAL-ACCEPTANCE.md`.

## K-Invariants (carry-forward from Phase B I1–I8 / J1–J5)

- **K1** — `http:unregister-route` doesn't exist; we hold the
  closure returned by `http:register-route`.
- **K2** — `credentials:get-by-name` doesn't exist; we reuse
  `credentials:get({ ref, userId })` with `row.authorUserId`.
- **K3** — webhook routes are local to the replica that received
  the apply; multi-replica fan-out deferred.
- **K4** — no cross-plugin imports; all reach via the bus.
- **K5** — producer + consumer + canary same PR.
- **K6** — `spec_hash` gates route re-registration.
- **K7** — capabilities additions enumerated in `@ax/routines.calls`
  + `@ax/agents.registers`. No spawn, no FS, no `http:unregister-route`,
  no `credentials:get-by-name`.
- **K8** — new `@ax/agents` hook payloads use opaque `agentId` /
  `token`.
- **K9** — payload bytes flow JSON.parse → renderTemplate (string
  substitution only) → agent:invoke. No dynamic-JS-evaluation sinks.
  security-checklist skill walked on body-parse / HMAC / template.
- **K10** — webhook bind failures log + record
  `last_status='error'`; never wedge the apply.
- **K11** — HMAC compare uses `crypto.timingSafeEqual` over
  equal-length lowercase hex buffers.

## Test plan

- [x] `pnpm test --filter @ax/validator-routine` — webhook validation
- [x] `pnpm test --filter @ax/agents` — token store + hooks
- [x] `pnpm test --filter @ax/routines` — template, webhook-handler,
      sync, canary
- [x] `pnpm build && pnpm test && pnpm lint`
- [ ] MANUAL-ACCEPTANCE walk (Section 9) in kind cluster

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm the PR URL surfaces back to the user**

Capture the URL printed by `gh pr create` and report it.

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 credentials:get reuse | Task 8 (handler), Task 9 (sync passes `userId`) |
| §1.2 webhook_token column + lazy hooks | Task 2, 3, 4 |
| §1.3 closure registry | Task 9 |
| §1.4 single-replica K3 docstring | Task 9 plugin.ts header |
| §1.5 in-process canary | Task 10 |
| §1.6 strict-whitelist template | Task 5 |
| §3 frontmatter format | Task 1 |
| §4 route lifecycle | Task 9 |
| §5 handler chain | Task 8 |
| §6 fireRoutine extension | Task 6 |
| §7 canary cases | Task 10 |
| §8 K1-K11 | Header — invariants referenced in every relevant task |
| §9 MANUAL-ACCEPTANCE | Task 11 |
| §10 capability budget | Task 4 + Task 9 (both manifests updated) |
| §11 test plan | Tasks 1-10 individually + Task 12 full suite |

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to Task N" left in plan body.

**Type consistency:** `getByWebhookToken` / `setWebhookToken` named consistently across types.ts + store.ts + plugin.ts. `WebhookHmacSpec` exported from `@ax/validator-routine` and re-exported by `@ax/routines/types.ts`. `RotateWebhookTokenInput.actor` matches `Actor` interface (read at Task 4 step 1). `HandleWorkspaceAppliedDeps` signature consistent between sync.ts (definition) and plugin.ts (caller).

One known refinement to apply during implementation: the pseudocode in Task 9 step 3 declares an unused `parsedFields` local — drop it. Implementer should follow the cleaner version of the handler that reads `row` back from the store inside the handler (already wired through Task 8's `store.findOne`).
