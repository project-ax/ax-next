# MCP Connector OAuth — Implementation Plan (Phase 1: backend slice)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fully-wired, canary-tested OAuth 2.0 path for connector-based MCP servers — the agent owner authorizes once via a host-side flow, the token is stored agent-bound and refreshed lazily, and the access token is injected on the wire by the credential-proxy so it never enters the sandbox.

**Architecture:** A new host-side plugin `@ax/mcp-oauth` drives the OAuth dance with `@modelcontextprotocol/sdk@1.29.0`'s OAuth helper functions, persists tokens in the existing credentials vault under a new `mcp-oauth` kind at `scope:'agent'`, and registers `credentials:resolve:mcp-oauth` for lazy refresh. The connector model gains an `oauth` credential-slot kind; the orchestrator's connector-fold maps that to `kind:'mcp-oauth'` so the existing placeholder→proxy injection path carries the token unchanged. Phase 1 exposes the flow as two HTTP routes (`/api/connectors/oauth/begin` + `/callback`) drivable by a canary; the human connect-UI is Phase 2.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, Kysely + Postgres (per-plugin `mcp_oauth_v1_*` tables via `database:get-instance`), zod, vitest, `@modelcontextprotocol/sdk` OAuth helpers, `@ax/core` hook bus.

**Scope note:** This plan is Phase 1 — the backend slice that produces working, canary-tested software on its own. Phase 2 (channel-web connect UI) and Phase 3 (manual-acceptance walk card) get their own plans (see "Future phases"). Design: `docs/plans/2026-06-08-mcp-connector-oauth-design.md`.

**PR split:** Phase 1 may ship as one PR or be split 1a (package: model + store + flow + resolver + unit/integration tests) / 1b (orchestrator fold + preset wiring + e2e canary, which closes the half-wired window). Each sub-PR must be green + lint-clean. Decide at execution time; the task order below supports either.

---

## File structure

**New package `packages/mcp-oauth/`:**
- `src/index.ts` — public exports (plugin factory + the types other packages need).
- `src/plugin.ts` — `createMcpOAuthPlugin()`: manifest, init (migration + resolver + routes), shutdown.
- `src/migrations.ts` — `mcp_oauth_v1_clients` + `mcp_oauth_v1_pending` DDL + row types + `McpOAuthDatabase`.
- `src/store.ts` — `createMcpOAuthStore()`: client-registration upsert/get + pending insert/consume (single-use, TTL).
- `src/ssrf.ts` — `assertSafeUrl()` / `safeFetch()`: https-only + private-IP block for all discovery/registration/token fetches.
- `src/oauth-flow.ts` — thin wrappers over the SDK helpers: `discover()`, `ensureClient()`, `buildAuthorization()`, `redeemCode()`, `refresh()`.
- `src/resolver.ts` — `credentials:resolve:mcp-oauth` handler (refresh-on-resolve + rotation re-store).
- `src/routes.ts` — `begin` + `callback` HTTP handlers + `registerMcpOAuthRoutes()`.
- `src/types.ts` — `McpOAuthTokenBlob`, `PendingAuthorization`, `ClientRegistration`, config type, zod schemas.
- `src/__tests__/*.test.ts` — one test file per module + `e2e.test.ts` (the canary).

**Modified:**
- `packages/connectors/src/types.ts` — extend `CapabilitySlotSchema` to allow `kind:'oauth'` + the oauth config; export the new types.
- `packages/chat-orchestrator/src/connector-union.ts` — map an `oauth` slot to `kind:'mcp-oauth'` in `baseCreds` instead of hardcoded `'api-key'`.
- `packages/cli/src/main.ts` — load `@ax/mcp-oauth` in the multi-tenant assembly (with routes mounted).
- The preset assertion test (the one that pins the loaded multi-tenant plugin list) — add `@ax/mcp-oauth`.

---

## Conventions to mirror (read before starting)

- **Plugin shape / migration / `database:get-instance`:** `packages/connectors/src/plugin.ts:121-170` and `packages/connectors/src/migrations.ts`. Per-plugin `_v1_` tables, idempotent `IF NOT EXISTS` DDL, no cross-plugin FK.
- **Credentials contract:** `packages/credentials/src/plugin.ts:62-137`. `credentials:set` (`{scope,ownerId,ref,kind,payload:Uint8Array,expiresAt?,metadata?}`), `credentials:get` (`{ref,userId}`→`string`), and the resolver sub-service `credentials:resolve:<kind>` (`CredentialsResolveInput {payload,userId,ref}` → `CredentialsResolveOutput {value, refreshed?{payload,expiresAt?,metadata?}}`). Returning `refreshed` triggers an automatic re-store under the same scope+ref.
- **HTTP route registration:** `packages/connectors/src/admin-routes.ts:111-130` (`auth:require-user` → `{user:{id,isAdmin}}`) and `:818-840` (`bus.call('http:register-route', ctx, {method,path,handler}) → {unregister}`; duck-typed `RouteRequest`/`RouteResponse`).
- **Reading connector config:** `connectors:get` (`GetInput`→`GetOutput` with `capabilities.mcpServers`) — call it from the begin route to resolve the MCP server URL + scopes.
- **SDK OAuth helpers:** `@modelcontextprotocol/sdk/client/auth.js` — `discoverOAuthProtectedResourceMetadata`, `discoverAuthorizationServerMetadata`, `registerClient`, `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`, `extractResourceMetadataUrl`.

---

## Task 1: Scaffold the `@ax/mcp-oauth` package

**Files:**
- Create: `packages/mcp-oauth/package.json`
- Create: `packages/mcp-oauth/tsconfig.json`
- Create: `packages/mcp-oauth/vitest.config.ts`
- Create: `packages/mcp-oauth/src/index.ts`

- [ ] **Step 1: Copy the package scaffolding from a sibling**

Mirror `packages/connectors/package.json` exactly, changing `name` to `@ax/mcp-oauth` and trimming `dependencies` to what this package imports: `@ax/core` (workspace:*), `@modelcontextprotocol/sdk` (match the version range in `packages/mcp-client/package.json`), `kysely`, `zod`. Copy `tsconfig.json` and `vitest.config.ts` verbatim from `packages/connectors/`.

- [ ] **Step 2: Add a placeholder export so the build graph resolves**

```ts
// packages/mcp-oauth/src/index.ts
export const MCP_OAUTH_PLUGIN_NAME = '@ax/mcp-oauth';
```

- [ ] **Step 3: Install + typecheck the new package**

Run: `pnpm install && pnpm --filter @ax/mcp-oauth build`
Expected: PASS (empty package compiles).

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-oauth pnpm-lock.yaml
git commit -m "feat(mcp-oauth): scaffold @ax/mcp-oauth package"
```

---

## Task 2: Extend the connector model with an `oauth` credential slot

**Files:**
- Modify: `packages/connectors/src/types.ts:62-77` (`CapabilitySlotSchema`, `McpServerSpecSchema`)
- Test: `packages/connectors/src/__tests__/oauth-slot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/connectors/src/__tests__/oauth-slot.test.ts
import { describe, expect, it } from 'vitest';
import { CapabilitiesSchema } from '../types.js';

describe('oauth credential slot', () => {
  it('accepts an oauth slot referencing a server, with optional pinned client', () => {
    const parsed = CapabilitiesSchema.parse({
      allowedHosts: ['mcp.example.com', 'auth.example.com'],
      credentials: [
        { slot: 'MCP_TOKEN', kind: 'oauth', server: 'example', scopes: ['read'] },
      ],
      mcpServers: [
        { name: 'example', transport: 'http', url: 'https://mcp.example.com',
          allowedHosts: ['mcp.example.com'], credentials: [] },
      ],
      packages: { npm: [], pypi: [] },
    });
    expect(parsed.credentials[0]).toMatchObject({ kind: 'oauth', server: 'example' });
  });

  it('still accepts a plain api-key slot (back-compat)', () => {
    const parsed = CapabilitiesSchema.parse({
      allowedHosts: [], credentials: [{ slot: 'X', kind: 'api-key' }],
      mcpServers: [], packages: { npm: [], pypi: [] },
    });
    expect(parsed.credentials[0].kind).toBe('api-key');
  });

  it('rejects backend vocabulary smuggled onto the oauth slot', () => {
    expect(() =>
      CapabilitiesSchema.parse({
        allowedHosts: [], packages: { npm: [], pypi: [] }, mcpServers: [],
        credentials: [{ slot: 'X', kind: 'oauth', server: 'e', command: 'curl' }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ax/connectors test oauth-slot`
Expected: FAIL (`kind: 'oauth'` not in the literal union).

- [ ] **Step 3: Make `CapabilitySlotSchema` a discriminated union**

Replace `CapabilitySlotSchema` in `packages/connectors/src/types.ts:62-66`:

```ts
const ApiKeySlotSchema = z
  .object({
    slot: z.string(),
    kind: z.literal('api-key'),
    description: z.string().optional(),
  })
  .strict();

// OAuth slot: `server` names the mcpServers[] entry whose `url` is the OAuth
// resource. Pinned client fields are optional (DCR is the default path). No
// backend vocabulary leaks — `.strict()` rejects smuggled transport/command/url.
const OAuthSlotSchema = z
  .object({
    slot: z.string(),
    kind: z.literal('oauth'),
    server: z.string(),
    scopes: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    clientSecretRef: z.string().optional(),
    authServerUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
  })
  .strict();

const CapabilitySlotSchema = z.discriminatedUnion('kind', [
  ApiKeySlotSchema,
  OAuthSlotSchema,
]);
```

Update the `CapabilitySlot` TypeScript type (find its declaration in `types.ts`) to the union of the two, and export an `OAuthCapabilitySlot` type alias. Note: `McpServerSpecSchema.credentials` reuses `CapabilitySlotSchema`, so per-server credential arrays also accept oauth slots — leave that as-is (top-level `capabilities.credentials` is what the orchestrator folds; see Task 10).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/connectors test oauth-slot`
Expected: PASS.

- [ ] **Step 5: Run the connectors package build + full test (guard the union change)**

Run: `pnpm --filter @ax/connectors build && pnpm --filter @ax/connectors test`
Expected: PASS. If any existing store/validation test asserts the old object-schema shape, fix it to the union (the value shape for api-key slots is unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/types.ts packages/connectors/src/__tests__/oauth-slot.test.ts
git commit -m "feat(connectors): add oauth credential-slot kind to the capabilities schema"
```

---

## Task 3: Token-blob, pending, and client-registration types + schemas

**Files:**
- Create: `packages/mcp-oauth/src/types.ts`
- Test: `packages/mcp-oauth/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/mcp-oauth/src/__tests__/types.test.ts
import { describe, expect, it } from 'vitest';
import { McpOAuthTokenBlobSchema, encodeTokenBlob, decodeTokenBlob } from '../types.js';

describe('McpOAuthTokenBlob', () => {
  it('round-trips through encode/decode', () => {
    const blob = {
      accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer',
      expiresAt: 1000, scope: 'read', resource: 'https://mcp.example.com',
      authServerUrl: 'https://auth.example.com', clientKey: 'example|https://auth.example.com',
    };
    expect(decodeTokenBlob(encodeTokenBlob(blob))).toEqual(blob);
  });

  it('rejects a blob missing the access token', () => {
    expect(() => McpOAuthTokenBlobSchema.parse({ tokenType: 'Bearer' })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ax/mcp-oauth test types`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the types**

```ts
// packages/mcp-oauth/src/types.ts
import { z } from 'zod';

/** The credentials-vault payload for a `mcp-oauth` credential. Self-contained:
 *  the resolver gets ONLY this payload (not the envelope metadata), so it carries
 *  everything needed to decide-to-refresh and to refresh. `clientKey` indexes the
 *  client-registration row in this plugin's own store. */
export const McpOAuthTokenBlobSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  tokenType: z.string().default('Bearer'),
  /** Epoch ms when the access token expires (0/undefined ⇒ unknown ⇒ refresh). */
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
  resource: z.string().url(),
  authServerUrl: z.string().url(),
  clientKey: z.string().min(1),
});
export type McpOAuthTokenBlob = z.infer<typeof McpOAuthTokenBlobSchema>;

export function encodeTokenBlob(b: McpOAuthTokenBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(McpOAuthTokenBlobSchema.parse(b)));
}
export function decodeTokenBlob(bytes: Uint8Array): McpOAuthTokenBlob {
  return McpOAuthTokenBlobSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** A persisted pending authorization, keyed by `state`. */
export interface PendingAuthorization {
  state: string;
  userId: string;
  agentId: string;
  connectorId: string;
  slot: string;
  codeVerifier: string;
  authServerUrl: string;
  clientKey: string;
  resource: string;
  scope: string | undefined;
  createdAt: number;
}

/** A stored OAuth client registration (DCR result or pinned). */
export interface ClientRegistration {
  /** `${connectorId}|${authServerUrl}` — stable per (connector, auth server). */
  clientKey: string;
  clientId: string;
  clientSecret: string | undefined;
  /** Whether this came from dynamic registration (vs admin-pinned). */
  dynamic: boolean;
}

/** Compose the stable client key. */
export function clientKeyOf(connectorId: string, authServerUrl: string): string {
  return `${connectorId}|${authServerUrl}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/mcp-oauth test types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/types.ts packages/mcp-oauth/src/__tests__/types.test.ts
git commit -m "feat(mcp-oauth): token-blob + pending + client-registration types"
```

---

## Task 4: SSRF guard for all OAuth fetches

**Files:**
- Create: `packages/mcp-oauth/src/ssrf.ts`
- Test: `packages/mcp-oauth/src/__tests__/ssrf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/mcp-oauth/src/__tests__/ssrf.test.ts
import { describe, expect, it } from 'vitest';
import { assertSafeUrl, BlockedUrlError } from '../ssrf.js';

const allow = new Set(['mcp.example.com', 'auth.example.com']);
// Resolver stub: example hosts → public IP; everything else → loopback.
const resolver = async (h: string) =>
  allow.has(h) ? '93.184.216.34' : '127.0.0.1';

describe('assertSafeUrl', () => {
  it('passes an https URL on an allowlisted host resolving to a public IP', async () => {
    await expect(assertSafeUrl('https://auth.example.com/token', allow, resolver))
      .resolves.toBeUndefined();
  });
  it('rejects http (non-TLS)', async () => {
    await expect(assertSafeUrl('http://auth.example.com/', allow, resolver))
      .rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a host not in the connector allowlist', async () => {
    await expect(assertSafeUrl('https://evil.example.net/', allow, resolver))
      .rejects.toBeInstanceOf(BlockedUrlError);
  });
  it('rejects a host that resolves into a private range', async () => {
    const internalAllow = new Set(['internal.example.com']);
    await expect(
      assertSafeUrl('https://internal.example.com/', internalAllow,
        async () => '169.254.169.254'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ax/mcp-oauth test ssrf`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the guard**

```ts
// packages/mcp-oauth/src/ssrf.ts
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'BlockedUrlError'; }
}

export type HostResolver = (hostname: string) => Promise<string>;
const defaultResolver: HostResolver = async (h) => (await lookup(h)).address;

/** IPv4/IPv6 private, loopback, link-local, ULA ranges. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fe80') ||
    v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:127.') ||
    v.startsWith('::ffff:10.') || v.startsWith('::ffff:169.254.');
}

/**
 * Throw BlockedUrlError unless `url` is https, its host is in `allowedHosts`, and
 * it resolves to a non-private IP. Used for EVERY discovery/registration/token
 * fetch — the metadata that names these URLs is untrusted third-party input.
 */
export async function assertSafeUrl(
  url: string,
  allowedHosts: Set<string>,
  resolver: HostResolver = defaultResolver,
): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { throw new BlockedUrlError(`invalid url: ${url}`); }
  if (u.protocol !== 'https:') throw new BlockedUrlError(`non-https url blocked: ${url}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowedHosts.has(host)) throw new BlockedUrlError(`host not allowlisted: ${host}`);
  const ip = isIP(host) ? host : await resolver(host);
  if (isPrivateIp(ip)) throw new BlockedUrlError(`host resolves to a private ip: ${host}`);
}

/** `fetch` wrapper that runs `assertSafeUrl` first. */
export async function safeFetch(
  url: string, allowedHosts: Set<string>, init?: RequestInit, resolver?: HostResolver,
): Promise<Response> {
  await assertSafeUrl(url, allowedHosts, resolver);
  return fetch(url, init);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/mcp-oauth test ssrf`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/ssrf.ts packages/mcp-oauth/src/__tests__/ssrf.test.ts
git commit -m "feat(mcp-oauth): SSRF guard (https-only + allowlist + private-IP block)"
```

---

## Task 5: Migration + store (clients + pending, single-use + TTL)

**Files:**
- Create: `packages/mcp-oauth/src/migrations.ts`
- Create: `packages/mcp-oauth/src/store.ts`
- Test: `packages/mcp-oauth/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the migration** (mirror `packages/connectors/src/migrations.ts`)

```ts
// packages/mcp-oauth/src/migrations.ts
import { sql, type Kysely } from 'kysely';

export async function runMcpOAuthMigration<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_v1_clients (
      client_key    TEXT PRIMARY KEY,
      client_id     TEXT NOT NULL,
      client_secret TEXT,
      dynamic       BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_v1_pending (
      state         TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      connector_id  TEXT NOT NULL,
      slot          TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      auth_server_url TEXT NOT NULL,
      client_key    TEXT NOT NULL,
      resource      TEXT NOT NULL,
      scope         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`.execute(db);
}

export interface McpOAuthClientRow {
  client_key: string; client_id: string; client_secret: string | null;
  dynamic: boolean; created_at: Date;
}
export interface McpOAuthPendingRow {
  state: string; user_id: string; agent_id: string; connector_id: string;
  slot: string; code_verifier: string; auth_server_url: string; client_key: string;
  resource: string; scope: string | null; created_at: Date;
}
export interface McpOAuthDatabase {
  mcp_oauth_v1_clients: McpOAuthClientRow;
  mcp_oauth_v1_pending: McpOAuthPendingRow;
}
```

- [ ] **Step 2: Write the failing store test** (uses an in-memory sqlite Kysely; mirror how `packages/connectors/src/__tests__/store.test.ts` builds its `db` — copy that harness)

```ts
// packages/mcp-oauth/src/__tests__/store.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createMcpOAuthStore } from '../store.js';
import { makeTestDb } from './helpers.js'; // copy the Kysely test-db builder from connectors' test harness

describe('mcp-oauth store', () => {
  let store: Awaited<ReturnType<typeof makeTestStore>>;
  async function makeTestStore() {
    const db = await makeTestDb();
    return createMcpOAuthStore(db);
  }
  beforeEach(async () => { store = await makeTestStore(); });

  it('upserts + reads a client registration by key', async () => {
    await store.putClient({ clientKey: 'c|a', clientId: 'id', clientSecret: 's', dynamic: true });
    expect(await store.getClient('c|a')).toMatchObject({ clientId: 'id', clientSecret: 's' });
  });

  it('consumePending returns the row once, then null (single-use)', async () => {
    await store.putPending({
      state: 'st', userId: 'u', agentId: 'a', connectorId: 'c', slot: 'S',
      codeVerifier: 'v', authServerUrl: 'https://auth', clientKey: 'c|a',
      resource: 'https://mcp', scope: 'read', createdAt: 1000,
    });
    const first = await store.consumePending('st', 2000, 10 * 60_000);
    expect(first?.userId).toBe('u');
    expect(await store.consumePending('st', 2000, 10 * 60_000)).toBeNull();
  });

  it('consumePending returns null for an expired state (older than ttl)', async () => {
    await store.putPending({
      state: 'old', userId: 'u', agentId: 'a', connectorId: 'c', slot: 'S',
      codeVerifier: 'v', authServerUrl: 'https://auth', clientKey: 'c|a',
      resource: 'https://mcp', scope: undefined, createdAt: 0,
    });
    expect(await store.consumePending('old', 11 * 60_000, 10 * 60_000)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ax/mcp-oauth test store`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the store**

```ts
// packages/mcp-oauth/src/store.ts
import type { Kysely } from 'kysely';
import type { McpOAuthDatabase } from './migrations.js';
import type { ClientRegistration, PendingAuthorization } from './types.js';

export interface McpOAuthStore {
  putClient(c: ClientRegistration): Promise<void>;
  getClient(clientKey: string): Promise<ClientRegistration | null>;
  putPending(p: PendingAuthorization): Promise<void>;
  /** Atomically delete + return the row IFF present and `now - createdAt <= ttlMs`.
   *  Single-use: a second call for the same state returns null. */
  consumePending(state: string, now: number, ttlMs: number): Promise<PendingAuthorization | null>;
}

export function createMcpOAuthStore(db: Kysely<McpOAuthDatabase>): McpOAuthStore {
  return {
    async putClient(c) {
      await db.insertInto('mcp_oauth_v1_clients')
        .values({ client_key: c.clientKey, client_id: c.clientId,
          client_secret: c.clientSecret ?? null, dynamic: c.dynamic })
        .onConflict((oc) => oc.column('client_key').doUpdateSet({
          client_id: c.clientId, client_secret: c.clientSecret ?? null, dynamic: c.dynamic }))
        .execute();
    },
    async getClient(clientKey) {
      const r = await db.selectFrom('mcp_oauth_v1_clients')
        .selectAll().where('client_key', '=', clientKey).executeTakeFirst();
      return r ? { clientKey: r.client_key, clientId: r.client_id,
        clientSecret: r.client_secret ?? undefined, dynamic: r.dynamic } : null;
    },
    async putPending(p) {
      await db.insertInto('mcp_oauth_v1_pending').values({
        state: p.state, user_id: p.userId, agent_id: p.agentId, connector_id: p.connectorId,
        slot: p.slot, code_verifier: p.codeVerifier, auth_server_url: p.authServerUrl,
        client_key: p.clientKey, resource: p.resource, scope: p.scope ?? null,
      }).execute();
    },
    async consumePending(state, now, ttlMs) {
      // Delete-returning makes consume single-use and race-safe.
      const r = await db.deleteFrom('mcp_oauth_v1_pending')
        .where('state', '=', state).returningAll().executeTakeFirst();
      if (!r) return null;
      const createdAt = r.created_at instanceof Date ? r.created_at.getTime() : Number(r.created_at);
      if (now - createdAt > ttlMs) return null;
      return { state: r.state, userId: r.user_id, agentId: r.agent_id, connectorId: r.connector_id,
        slot: r.slot, codeVerifier: r.code_verifier, authServerUrl: r.auth_server_url,
        clientKey: r.client_key, resource: r.resource, scope: r.scope ?? undefined, createdAt };
    },
  };
}
```

> Note: the test stub passes `createdAt` explicitly, but the table defaults `created_at` to `NOW()`. For deterministic TTL tests, give `putPending` an optional `createdAtOverride` (insert `created_at` when present) OR have the test read back the inserted row's `created_at`. Keep production callers on the DB default.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ax/mcp-oauth test store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/migrations.ts packages/mcp-oauth/src/store.ts packages/mcp-oauth/src/__tests__/store.test.ts packages/mcp-oauth/src/__tests__/helpers.ts
git commit -m "feat(mcp-oauth): migration + client/pending store (single-use, TTL)"
```

---

## Task 6: OAuth-flow wrappers over the SDK helpers

**Files:**
- Create: `packages/mcp-oauth/src/oauth-flow.ts`
- Test: `packages/mcp-oauth/src/__tests__/oauth-flow.test.ts`

The wrappers compose the SDK helpers and run every outbound URL through the SSRF guard. They take an injected `safeFetch`/resolver + the allowlist so tests stay offline. Keep them pure (no DB, no bus).

- [ ] **Step 1: Write the failing test** (drive against an in-process fake auth server; assert the authorization URL carries PKCE + state + resource, and that a fetch to a non-allowlisted endpoint throws)

```ts
// packages/mcp-oauth/src/__tests__/oauth-flow.test.ts
import { describe, expect, it } from 'vitest';
import { buildAuthorization, refresh } from '../oauth-flow.js';

const meta = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
};
const allow = new Set(['auth.example.com']);
const resolver = async () => '93.184.216.34';

describe('buildAuthorization', () => {
  it('produces an authorize URL with state, PKCE challenge, and resource', async () => {
    const { authorizationUrl, codeVerifier } = await buildAuthorization({
      metadata: meta,
      client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
      redirectUri: 'https://app.example.com/api/connectors/oauth/callback',
      resource: 'https://mcp.example.com', scope: 'read', state: 'st123',
      allowedHosts: allow, resolver,
    });
    const u = new URL(authorizationUrl);
    expect(u.searchParams.get('state')).toBe('st123');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com');
    expect(codeVerifier.length).toBeGreaterThan(20);
  });

  it('refresh rejects when the token endpoint host is not allowlisted', async () => {
    await expect(refresh({
      metadata: { ...meta, token_endpoint: 'https://evil.example.net/token' },
      client: { clientKey: 'c|a', clientId: 'cid', clientSecret: undefined, dynamic: true },
      refreshToken: 'rt', resource: 'https://mcp.example.com',
      allowedHosts: allow, resolver,
    })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ax/mcp-oauth test oauth-flow`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the wrappers**

Compose the SDK functions; pass a `fetchFn` that the SDK calls and which runs `assertSafeUrl` first. Pseudocode/structure (fill in exact SDK arg names from `@modelcontextprotocol/sdk/client/auth.d.ts`):

```ts
// packages/mcp-oauth/src/oauth-flow.ts
import {
  discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata,
  registerClient, startAuthorization, exchangeAuthorization, refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { assertSafeUrl, type HostResolver } from './ssrf.js';
import type { ClientRegistration } from './types.js';

type Allow = Set<string>;
const guardedFetch = (allow: Allow, resolver?: HostResolver) =>
  async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    await assertSafeUrl(url, allow, resolver);
    return fetch(url, init);
  };

export interface DiscoverResult { authServerUrl: string; metadata: unknown; }

/** PRM → AS-metadata discovery; every fetch SSRF-guarded. Returns the chosen
 *  auth server URL + its metadata. Honors an admin-pinned authServerUrl. */
export async function discover(opts: {
  resourceUrl: string; pinnedAuthServerUrl?: string;
  allowedHosts: Allow; resolver?: HostResolver;
}): Promise<DiscoverResult> {
  const fetchFn = guardedFetch(opts.allowedHosts, opts.resolver);
  let authServerUrl = opts.pinnedAuthServerUrl;
  if (!authServerUrl) {
    const prm = await discoverOAuthProtectedResourceMetadata(opts.resourceUrl, { fetchFn } as never);
    authServerUrl = (prm as { authorization_servers?: string[] }).authorization_servers?.[0];
    if (!authServerUrl) throw new Error('resource advertises no authorization server');
  }
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn } as never);
  return { authServerUrl, metadata };
}

/** DCR (or pass through a pinned client). Caller persists the result. */
export async function ensureClient(opts: {
  metadata: unknown; clientKey: string; redirectUri: string; scope?: string;
  pinned?: { clientId: string; clientSecret?: string };
  allowedHosts: Allow; resolver?: HostResolver;
}): Promise<ClientRegistration> {
  if (opts.pinned) {
    return { clientKey: opts.clientKey, clientId: opts.pinned.clientId,
      clientSecret: opts.pinned.clientSecret, dynamic: false };
  }
  const fetchFn = guardedFetch(opts.allowedHosts, opts.resolver);
  const info = await registerClient((opts.metadata as { issuer: string }).issuer, {
    metadata: opts.metadata as never,
    clientMetadata: { redirect_uris: [opts.redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'client_secret_post', scope: opts.scope } as never,
    fetchFn,
  } as never);
  const i = info as { client_id: string; client_secret?: string };
  return { clientKey: opts.clientKey, clientId: i.client_id, clientSecret: i.client_secret, dynamic: true };
}

export async function buildAuthorization(opts: {
  metadata: unknown; client: ClientRegistration; redirectUri: string;
  resource: string; scope?: string; state: string; allowedHosts: Allow; resolver?: HostResolver;
}): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    (opts.metadata as { issuer: string }).issuer, {
      metadata: opts.metadata as never,
      clientInformation: { client_id: opts.client.clientId, client_secret: opts.client.clientSecret } as never,
      redirectUrl: opts.redirectUri, scope: opts.scope, state: opts.state, resource: new URL(opts.resource),
    } as never);
  return { authorizationUrl: authorizationUrl.toString(), codeVerifier };
}

export async function redeemCode(opts: {
  metadata: unknown; client: ClientRegistration; code: string; codeVerifier: string;
  redirectUri: string; resource: string; allowedHosts: Allow; resolver?: HostResolver;
}) {
  const fetchFn = guardedFetch(opts.allowedHosts, opts.resolver);
  return exchangeAuthorization((opts.metadata as { issuer: string }).issuer, {
    metadata: opts.metadata as never,
    clientInformation: { client_id: opts.client.clientId, client_secret: opts.client.clientSecret } as never,
    authorizationCode: opts.code, codeVerifier: opts.codeVerifier, redirectUri: opts.redirectUri,
    resource: new URL(opts.resource), fetchFn,
  } as never);
}

export async function refresh(opts: {
  metadata: unknown; client: ClientRegistration; refreshToken: string; resource: string;
  allowedHosts: Allow; resolver?: HostResolver;
}) {
  const fetchFn = guardedFetch(opts.allowedHosts, opts.resolver);
  return refreshAuthorization((opts.metadata as { issuer: string }).issuer, {
    metadata: opts.metadata as never,
    clientInformation: { client_id: opts.client.clientId, client_secret: opts.client.clientSecret } as never,
    refreshToken: opts.refreshToken, resource: new URL(opts.resource), fetchFn,
  } as never);
}
```

> The `as never` casts are placeholders for the exact SDK parameter object types — replace each with the real type from `auth.d.ts` (`startAuthorization`/`exchangeAuthorization`/`refreshAuthorization`/`registerClient` signatures shown in the design §3). Do NOT leave `as never` in the final code; they're here only to make the structure readable. Verify each against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts` before implementing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/mcp-oauth test oauth-flow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/oauth-flow.ts packages/mcp-oauth/src/__tests__/oauth-flow.test.ts
git commit -m "feat(mcp-oauth): SSRF-guarded OAuth flow wrappers over the MCP SDK"
```

---

## Task 7: The `credentials:resolve:mcp-oauth` resolver (refresh + rotation)

**Files:**
- Create: `packages/mcp-oauth/src/resolver.ts`
- Test: `packages/mcp-oauth/src/__tests__/resolver.test.ts`

The resolver receives `{ payload, userId, ref }`. It decodes the token blob; if the access token is unexpired (with margin) it returns `{ value: accessToken }`; otherwise it loads the client (by `clientKey` from its store), re-discovers AS metadata (or caches it), calls `refresh()`, and returns `{ value, refreshed: { payload, expiresAt, metadata } }` so the credentials plugin re-stores the rotated blob. `invalid_grant` ⇒ throw a typed `NeedsReconnectError`.

- [ ] **Step 1: Write the failing test** (inject the store + a fake `refresh` so it's offline; assert: unexpired→no refresh; expired→refresh + `refreshed` payload carries the rotated refresh token; `invalid_grant`→NeedsReconnectError)

```ts
// packages/mcp-oauth/src/__tests__/resolver.test.ts
import { describe, expect, it } from 'vitest';
import { createMcpOAuthResolver, NeedsReconnectError } from '../resolver.js';
import { encodeTokenBlob, decodeTokenBlob } from '../types.js';

const baseBlob = {
  accessToken: 'old', refreshToken: 'rt1', tokenType: 'Bearer', expiresAt: 0,
  scope: 'read', resource: 'https://mcp.example.com', authServerUrl: 'https://auth.example.com',
  clientKey: 'c|https://auth.example.com',
};
const deps = (over = {}) => ({
  store: { getClient: async () => ({ clientKey: 'c|a', clientId: 'cid', clientSecret: 's', dynamic: true }) },
  discoverMetadata: async () => ({ issuer: 'https://auth.example.com', token_endpoint: 'https://auth.example.com/token' }),
  refresh: async () => ({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600, token_type: 'Bearer' }),
  allowedHosts: new Set(['auth.example.com', 'mcp.example.com']),
  now: () => 10_000,
  ...over,
});

describe('mcp-oauth resolver', () => {
  it('returns the stored token without refresh when it is still valid', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const blob = encodeTokenBlob({ ...baseBlob, expiresAt: 10_000 + 10 * 60_000 });
    const out = await resolve({ payload: blob, userId: 'u', ref: 'account:c' });
    expect(out.value).toBe('old');
    expect(out.refreshed).toBeUndefined();
  });

  it('refreshes an expired token and re-stores the rotated refresh token', async () => {
    const resolve = createMcpOAuthResolver(deps());
    const out = await resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' });
    expect(out.value).toBe('new');
    expect(out.refreshed).toBeDefined();
    expect(decodeTokenBlob(out.refreshed!.payload).refreshToken).toBe('rt2');
  });

  it('throws NeedsReconnectError on invalid_grant', async () => {
    const resolve = createMcpOAuthResolver(deps({
      refresh: async () => { throw new Error('invalid_grant'); },
    }));
    await expect(resolve({ payload: encodeTokenBlob(baseBlob), userId: 'u', ref: 'account:c' }))
      .rejects.toBeInstanceOf(NeedsReconnectError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ax/mcp-oauth test resolver`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the resolver**

```ts
// packages/mcp-oauth/src/resolver.ts
import type { CredentialsResolveInput, CredentialsResolveOutput } from '@ax/credentials'; // type-only (I2-safe: types, not runtime)
import { decodeTokenBlob, encodeTokenBlob, type McpOAuthTokenBlob } from './types.js';
import type { ClientRegistration } from './types.js';

export class NeedsReconnectError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeedsReconnectError'; }
}

/** Refresh when fewer than this many ms remain. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface ResolverDeps {
  store: { getClient(clientKey: string): Promise<ClientRegistration | null> };
  discoverMetadata(authServerUrl: string, allowedHosts: Set<string>): Promise<unknown>;
  refresh(args: { metadata: unknown; client: ClientRegistration; refreshToken: string;
    resource: string; allowedHosts: Set<string> }): Promise<{ access_token: string;
    refresh_token?: string; expires_in?: number; token_type?: string; scope?: string }>;
  allowedHosts: Set<string>;
  now(): number;
}

export function createMcpOAuthResolver(deps: ResolverDeps) {
  return async function resolve(input: CredentialsResolveInput): Promise<CredentialsResolveOutput> {
    const blob = decodeTokenBlob(input.payload);
    const valid = blob.expiresAt !== undefined && blob.expiresAt - deps.now() > REFRESH_MARGIN_MS;
    if (valid) return { value: blob.accessToken };

    if (!blob.refreshToken) throw new NeedsReconnectError('no refresh token; reconnect required');
    const client = await deps.store.getClient(blob.clientKey);
    if (!client) throw new NeedsReconnectError(`client registration ${blob.clientKey} missing`);

    let tokens;
    try {
      const metadata = await deps.discoverMetadata(blob.authServerUrl, deps.allowedHosts);
      tokens = await deps.refresh({ metadata, client, refreshToken: blob.refreshToken,
        resource: blob.resource, allowedHosts: deps.allowedHosts });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes('invalid_grant')) throw new NeedsReconnectError('refresh token rejected; reconnect required');
      throw err; // transient — let the caller's retry/mutex handle it; keep stored token
    }

    const next: McpOAuthTokenBlob = {
      ...blob,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? blob.refreshToken, // preserve when not rotated
      tokenType: tokens.token_type ?? blob.tokenType,
      expiresAt: tokens.expires_in ? deps.now() + tokens.expires_in * 1000 : undefined,
      scope: tokens.scope ?? blob.scope,
    };
    const payload = encodeTokenBlob(next);
    return {
      value: next.accessToken,
      refreshed: { payload, ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {}) },
    };
  };
}
```

> `@ax/credentials` must be a `type`-only import (the contract types), not a runtime dependency. Add it to `devDependencies` (types) and import with `import type`. If tsc complains about the workspace types resolution, add `@ax/credentials` to `dependencies` but never import a runtime symbol from it — confirm with `pnpm --filter @ax/mcp-oauth build` (the lesson from `feedback_run_tsc_alongside_vitest`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ax/mcp-oauth test resolver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/resolver.ts packages/mcp-oauth/src/__tests__/resolver.test.ts
git commit -m "feat(mcp-oauth): credentials:resolve:mcp-oauth refresh + rotation re-store"
```

---

## Task 8: `begin` + `callback` HTTP route handlers

**Files:**
- Create: `packages/mcp-oauth/src/routes.ts`
- Test: `packages/mcp-oauth/src/__tests__/routes.test.ts`

Mirror the duck-typed `RouteRequest`/`RouteResponse` + `auth:require-user` pattern from `packages/connectors/src/admin-routes.ts:92-130`. Handlers take an injected dependency bundle (bus, store, flow fns, config) so tests don't need a live http-server.

Begin: `auth:require-user` → owner; verify owner controls `agentId` (call `agents:resolve` — the same gate connectors' grant path uses); `connectors:get` → find the oauth slot + its `server`'s url + scopes + pinned client; `discover` → `ensureClient` (persist) → `buildAuthorization` → `putPending(state…)` → `200 { authorizationUrl }`.

Callback: `auth:require-user`; `consumePending(state)`; assert `pending.userId === session.id`; `redeemCode` → build `McpOAuthTokenBlob` → `credentials:set` at `scope:'agent', ownerId=agentId, ref=account:<connectorId>, kind:'mcp-oauth'` → `302` to the connector UI with a success marker.

- [ ] **Step 1: Write the failing tests** (inject fakes for bus/store/flow; assert: begin returns an authorizationUrl + writes pending; callback with a mismatched user → 400 + no `credentials:set`; happy callback → `credentials:set` called with `scope:'agent'` + `kind:'mcp-oauth'` + a 302)

```ts
// packages/mcp-oauth/src/__tests__/routes.test.ts
import { describe, expect, it, vi } from 'vitest';
import { makeBeginHandler, makeCallbackHandler } from '../routes.js';
// Build minimal RouteRequest/RouteResponse fakes (copy the shape from connectors' admin-routes tests).
// ... assert the four behaviors above ...
```

(Write the full assertions; reuse the connectors admin-route test harness for `RouteRequest`/`RouteResponse` fakes and the `auth:require-user` bus stub.)

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test routes` → FAIL.

- [ ] **Step 3: Implement the handlers** (duck-typed req/res; CSRF: state single-use via `consumePending`, user-bound; never log code/token; redirect target = `${publicOrigin}${connectorReturnPath}?connector=<id>&oauth=success|error`).

- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/mcp-oauth test routes` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-oauth/src/routes.ts packages/mcp-oauth/src/__tests__/routes.test.ts
git commit -m "feat(mcp-oauth): begin + callback route handlers (CSRF-bound, owner-gated)"
```

---

## Task 9: Plugin factory (manifest, init, shutdown)

**Files:**
- Create: `packages/mcp-oauth/src/plugin.ts`
- Modify: `packages/mcp-oauth/src/index.ts` (export the factory + config type)
- Test: `packages/mcp-oauth/src/__tests__/plugin.test.ts`

Mirror `packages/connectors/src/plugin.ts:121-170`. Config: `{ mountRoutes?: boolean; publicOrigin: string; connectorReturnPath?: string }`. `calls`: `['database:get-instance', 'credentials:set', 'connectors:get', 'agents:resolve']` plus `['http:register-route','auth:require-user']` when `mountRoutes`. `registers: ['credentials:resolve:mcp-oauth']`. `init`: get db → `runMcpOAuthMigration` → build store → register the resolver service (returns `CredentialsResolveOutputSchema`) → mount routes when enabled. `shutdown`: call the tracked unregister callbacks.

- [ ] **Step 1: Write the failing test** — assert: the manifest registers `credentials:resolve:mcp-oauth`; init runs the migration and registers the resolver service on a test bus (mirror `packages/test-harness` usage in `packages/connectors/src/__tests__/plugin.test.ts`).
- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test plugin` → FAIL.
- [ ] **Step 3: Implement the plugin factory.**
- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/mcp-oauth test plugin` → PASS.
- [ ] **Step 5: Run the whole package green + lint** — `pnpm --filter @ax/mcp-oauth build && pnpm --filter @ax/mcp-oauth test && pnpm --filter @ax/mcp-oauth lint` → PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/plugin.ts packages/mcp-oauth/src/index.ts packages/mcp-oauth/src/__tests__/plugin.test.ts
git commit -m "feat(mcp-oauth): plugin factory (migration + resolver + routes)"
```

---

## Task 10: Orchestrator — map an `oauth` slot to `kind:'mcp-oauth'`

**Files:**
- Modify: `packages/chat-orchestrator/src/connector-union.ts` (the `foldConnectorCaps` credential loop — the `baseCreds[envName] = { ref, kind: slotDef.kind }` site and the installed-entry `credentials.map(... kind: 'api-key' as const)` site)
- Test: `packages/chat-orchestrator/src/__tests__/connector-union.test.ts` (add a case)

- [ ] **Step 1: Write the failing test** — fold a connector whose `capabilities.credentials` has an `oauth` slot; assert `baseCreds[env].kind === 'mcp-oauth'` (not `'api-key'`) and the ref is `account:<connectorId>`.

```ts
it('maps an oauth slot to the mcp-oauth credential kind', () => {
  const baseCreds: Record<string, { ref: string; kind: string }> = {};
  foldConnectorCaps(
    [{ id: 'example', usageNote: '', visibility: 'shared', keyMode: 'personal',
       capabilities: { allowedHosts: ['mcp.example.com'], packages: { npm: [], pypi: [] },
         mcpServers: [{ name: 'example', transport: 'http', url: 'https://mcp.example.com',
           allowedHosts: ['mcp.example.com'], credentials: [] }],
         credentials: [{ slot: 'MCP_TOKEN', kind: 'oauth', server: 'example' }], services: [] } }] as never,
    new Set(), baseCreds, new Map(),
  );
  const entry = Object.values(baseCreds)[0];
  expect(entry.kind).toBe('mcp-oauth');
  expect(entry.ref).toBe('account:example');
});
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/chat-orchestrator test connector-union` → FAIL (kind is the slot's `'oauth'`, not `'mcp-oauth'`).

- [ ] **Step 3: Implement the mapping** — in the credential loop, translate the slot kind: `const credKind = slotDef.kind === 'oauth' ? 'mcp-oauth' : slotDef.kind;` and use `credKind` in `baseCreds[envName] = { ref, kind: credKind }`. Leave the installed-entry `credentials.map` `kind` as `'api-key'` ONLY if that field is unused for resolution (confirm by reading where `installedEntries[].credentials[].kind` is consumed; if it drives the placeholder kind too, map it the same way). Document which site is load-bearing in a code comment.

- [ ] **Step 4: Run the test to verify it passes** — `pnpm --filter @ax/chat-orchestrator test connector-union` → PASS.

- [ ] **Step 5: Run the orchestrator package green** — `pnpm --filter @ax/chat-orchestrator build && pnpm --filter @ax/chat-orchestrator test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-orchestrator/src/connector-union.ts packages/chat-orchestrator/src/__tests__/connector-union.test.ts
git commit -m "feat(orchestrator): fold an oauth connector slot to the mcp-oauth credential kind"
```

---

## Task 11: Preset wiring (load `@ax/mcp-oauth`) + preset assertion

**Files:**
- Modify: `packages/cli/src/main.ts` (the multi-tenant plugin assembly where `createConnectorsPlugin` / `createMcpClientPlugin` are added)
- Modify: the preset assertion test that pins the loaded plugin list (find it: `grep -rl "createConnectorsPlugin\|preset" packages/cli/src/__tests__ packages/*/src/__tests__ | xargs grep -l "@ax/connectors"`)
- Modify: `packages/cli/package.json` (add `@ax/mcp-oauth` workspace dep)

- [ ] **Step 1: Add the dependency** — `@ax/mcp-oauth: "workspace:*"` to `packages/cli/package.json`; `pnpm install`.

- [ ] **Step 2: Write/extend the failing preset test** — assert `@ax/mcp-oauth` is in the loaded multi-tenant plugin list (mirror how the existing test asserts `@ax/connectors`). Per `feedback_preset_drop_vs_load_lists`: this is the LOAD-list assertion (preset.test.ts), not the acceptance drop-list.

- [ ] **Step 3: Run it to verify it fails** — FAIL (plugin not loaded).

- [ ] **Step 4: Wire the plugin** — in `packages/cli/src/main.ts`, add `createMcpOAuthPlugin({ mountRoutes: true, publicOrigin: <the same origin source onboarding/auth-better uses — find it in main.ts>, connectorReturnPath: '/settings/connectors' })` to the assembly, ordered AFTER `@ax/credentials`, `@ax/connectors`, `@ax/http-server`, `@ax/database-postgres`, `@ax/agents` (its `calls` edges). Mirror the placement of `createMcpClientPlugin`.

- [ ] **Step 5: Run the preset test + a repo build** — `pnpm --filter @ax/cli test preset && pnpm build` → PASS (the half-wired window is now closed: plugin loaded + routes mounted + resolver registered).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/package.json pnpm-lock.yaml <preset test path>
git commit -m "feat(cli): load @ax/mcp-oauth in the multi-tenant preset"
```

---

## Task 12: End-to-end canary (in-process fake AS + MCP server)

**Files:**
- Create: `packages/mcp-oauth/src/__tests__/e2e.test.ts`

This is the invariant-#3 reachability proof: drive the real plugin + real resolver against an in-process fake authorization server and assert the agent-bound token resolves for a *different* chatting user.

- [ ] **Step 1: Write the e2e test**

Build a real test bus (mirror `packages/connectors/src/__tests__/plugin.test.ts` + `@ax/test-harness`) wiring `@ax/credentials` (with an in-memory store-blob), a stub `connectors:get` returning a connector with an oauth slot, a stub `agents:resolve` granting the owner, and `@ax/mcp-oauth`. Stand up an in-process HTTP fake auth server (Node `http.createServer`) exposing `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize` (immediately 302s to the callback with a code), `/token` (issues an access+refresh token). Point the SSRF resolver at `127.0.0.1` but ADD the fake host to the allowlist + the test resolver's allowed set (test-only escape hatch — mirror the proxy's `allowedIPs` test seam).

Assert:
1. `begin` (as owner `alice`, agent `A`) returns an `authorizationUrl`; following it + hitting `callback` stores a credential at `scope:'agent', ownerId='A', ref='account:test'`.
2. `credentials:get({ ref:'account:test', userId:'bob' })` **with `ctx.agentId='A'`** resolves to the access token — proving a *sharee* (bob ≠ alice) rides on the agent-bound token.
3. Forcing the stored `expiresAt` into the past and re-resolving triggers a `/token` refresh call and re-stores a rotated refresh token.

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @ax/mcp-oauth test e2e` → FAIL.

- [ ] **Step 3: Make the wiring real until it passes** (this is integration glue, not new product code — fix injection points, not behavior).

- [ ] **Step 4: Run it to verify it passes** — `pnpm --filter @ax/mcp-oauth test e2e` → PASS.

- [ ] **Step 5: Full repo gate** — `pnpm build && pnpm test && pnpm lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-oauth/src/__tests__/e2e.test.ts
git commit -m "test(mcp-oauth): e2e canary — agent-bound token resolves for a sharee + refresh"
```

---

## Task 13: Security-checklist pass + boundary-review note

**Files:**
- The PR description (boundary review + security note).

- [ ] **Step 1: Invoke the `security-checklist` skill** against the Phase-1 diff (new IPC/HTTP routes, untrusted third-party metadata, credential handling, new package). Walk the three threat models; answer every item.
- [ ] **Step 2: Write the boundary-review answers** in the PR body (alternate impl, payload field leaks = none, subscriber risk, wire surface lives in `packages/mcp-oauth/`) — see design §5.
- [ ] **Step 3: Confirm "no new dependency"** — `git diff` the root + cli `package.json`; the only added dep is the first-party `@ax/mcp-oauth` (the SDK was already present). If anything else snuck in, justify or remove.
- [ ] **Step 4: Commit any doc/PR-note files** the checklist produces.

---

## Self-review (run against the design before handing off)

- **Spec coverage:** D1 plugin → Tasks 1,9; D2 agent-bound → Tasks 7,8,12; D3 DCR+pinned → Task 6 `ensureClient`; D4 injection-unchanged → Task 10; D5 lazy refresh → Task 7; §7a flow → Task 8; §7b runtime → Task 10 + (re-stamp-per-turn lives in the orchestrator session-attach — VERIFY this is covered; if the per-turn re-stamp isn't already implied by existing fold-on-open, add a task); §8 errors → Tasks 7,8; §9 security → Tasks 4,8,13; §10 tests/canary → Task 12.
- **Gap flagged:** the §7b "re-stamp the OAuth placeholder at each turn's session-attach" requirement is only covered if the orchestrator already re-folds connector creds on every turn's session open. Before execution, confirm the session-open path runs per turn under keepalive; if it does NOT, add a task to re-resolve+re-stamp the `mcp-oauth` placeholder on turn attach. (Tracked as open item.)
- **Placeholder scan:** the `as never` casts in Task 6 are explicitly flagged to be replaced with real SDK types — not shipped. No other placeholders.
- **Type consistency:** `clientKey`, `McpOAuthTokenBlob`, `consumePending(state, now, ttlMs)`, `kind:'mcp-oauth'`, `ref: account:<connectorId>` used consistently across Tasks 3–12.

---

## Future phases (separate plans via writing-plans)

- **Phase 2 — channel-web connect UI.** Agent-scoped "Connect with \<Service\>" in the agent's connector settings (popup → `begin` → provider → `callback` → postMessage → status refresh); the pinned-client (non-DCR) form; per-agent connected/*Reconnect needed* status; the shared-key consent line at connect time. Connector-form support for authoring an `oauth` slot. Reconcile the connector-card `mcp` auto-approve exclusion.
- **Phase 3 — manual-acceptance walk `(walk)` card.** k8s-acceptance-loop + Playwright on `ax-next-dev`: owner connects against a test provider; a sharee chats the shared agent and the MCP tool works as the owner; revoke → *Reconnect needed*.
