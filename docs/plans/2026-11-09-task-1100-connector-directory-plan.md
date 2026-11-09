# TASK-1100 MCP directory: `@ax/connector-directory`, registry sync, search hook, admin route — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a host-side plugin mirrors the official MCP Registry into our Postgres about hourly and answers `connectors:directory-search` against that copy; `GET /admin/connectors/directory` in `@ax/connectors` calls it; the k8s preset and Helm chart wire it, with the off switch.

**Architecture:** new plugin package `packages/connector-directory` (owns two `connector_directory_v1_*` tables, the sync job, the hook). The sync pages `GET /v0.1/servers?version=latest` through an injected `fetchImpl`, cleans every field (untrusted), and upserts or deletes one row per server name. Search is parameterized SQL over our copy, ranked domain-first. `@ax/connectors` reaches it only through the bus (local structural mirror types, `bus.hasService`).

**Tech stack:** TypeScript, kysely `0.28.17` (`sql` template), zod `^3.23.8` (our contract only), `@ax/core` helpers (`capResponseBody`, `replaceSurfaceRewriters`, `toWellFormedText`, `clampCodeUnits`), vitest + Postgres testcontainers, Helm.

**Spec:** `docs/plans/2026-11-09-mcp-directory-connectors-design.md` (Decisions 2, 3, 5, 6, 7, 9; Shape; Boundary review; Security) and the card body. Every planning decision, with rationale and the alternatives rejected, is in `.claude/memory/decisions/2026-11-09-TASK-1100.md` — read it before Task 2.

---

## Premise check (verified against code and the live registry, 2026-11-09)

| Card claim | Verdict | Evidence / what the plan does instead |
|---|---|---|
| "registered before `/admin/connectors/:id` so it isn't swallowed by the `:id` route" | **False premise, real consequence.** | `packages/http-server/src/router.ts` `match()` tries the exact-path map first, whatever the registration order. What does matter: a GET exact path shadows `GET /admin/connectors/:id` for a connector whose id is `directory`, the `authored` precedent. Task 6 adds `directory` to `RESERVED_CONNECTOR_IDS` (and its mirror in `@ax/tool-connector-propose`). |
| "`'signin'` when the remote declares OAuth/authorization" | **Nothing to read.** | Live OpenAPI (`/openapi.json`): `Transport` = `{type, url, headers, variables}`, no auth declaration. Notion, Linear, Atlassian, Stripe, Figma and Canva (all OAuth) declare no headers. `'signin'` is never derived from the official registry; `'none'` means "declares no required key". The remote connector form discovers OAuth from the URL on its own, so nothing saved depends on the label. Decisions shard has the full rule. |
| "cap total rows (e.g. 20000)" | **Too small, measured.** | 60,000 latest entries in the first 600 pages, 40,135 with an http remote, list not finished. Pages are in name order, so 20,000 stops the first crawl at `io.github.E…`. Cap = **100,000**. |
| "`GET /v0/servers` (or the current documented list endpoint)" | Use **`/v0.1/servers`**. | The aggregator guide names v0.1. `include_deleted` is implied by `updated_since`. |
| `remotes[]` streamable-http / sse; `status` deleted/deprecated; `io.github.<user>`; reverse-DNS namespaces | True | Live data: 1,499 streamable-http + 20 sse remotes in 1,800 sampled; statuses `active` / `deprecated` seen; namespace pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, max 200. |
| blob-gc periodic pattern; connectors admin gating + `hasService`; `headerName` rule; k8s preset location | True | `packages/blob-gc/src/plugin.ts`; `admin-routes.ts` `authenticate()`; `types.ts:149`; `presets/k8s/src/index.ts:1279`. |
| "Check whether any other preset/CLI loads `@ax/connectors`" | Only via composition | `presets/memory` wraps `createK8sPlugins` (inherits the new plugin automatically). The CLI loads no connectors (`presets/k8s/src/index.ts:1270-1273`). Nothing else to wire. |

## Stale text this card relied on or makes stale (rule 5)

- `docs/plans/2026-11-09-mcp-directory-connectors-design.md:67-68` — the Shape's hook output `{ entries, syncedAt, nextCursor? }` (no `enabled`, `stale`, `verifiedOnly`, `deprecated?`). Fix in Task 8.
- Same file, `:98-99` — "A prefilled URL goes through the same `input-guards.ts` checks as a typed one." `packages/connectors/src/input-guards.ts` holds only `requireUserId`; there is no server-side URL check on save. Reword truthfully in Task 8.
- Same file, Decisions 2 and 5 — add the measured facts (v0.1 endpoint, checkpoint + overlap, 100k cap, publisher-label ranking, why `'signin'` isn't derived). Task 8.
- `packages/connectors/src/store.ts:48-57` and `packages/tool-connector-propose/src/plugin.ts:25-31` comments name only `authored`. Task 6.

## Brainstorm (self-answered)

- **What and why now?** Admins must currently know a remote MCP server's address, auth style and key header. The registry publishes that for ~40k remote servers. This card ships the server half; TASK-1101 builds the UI, TASK-1102 records provenance.
- **Success:** an admin search returns ranked, cleaned, honestly-dated results from our own copy; the sync is bounded, idempotent, switchable off, and no test touches the network.
- **Non-goals:** UI, provenance, non-admin discovery, stdio/package servers, ratings, periodic full reconciliation, OAuth probing, a "refresh now" button.
- **Anti-goals:** unbounded egress or DB growth; one hostile listing breaking the sync for everyone (U+0000, giant page, cursor loop); registry text that can rewrite the UI surface; claiming "verified" or "sign-in" on a guess; any test calling the real registry; preset canaries suddenly needing Postgres or the network.
- **Prior art copied:** `packages/host-grants` (package scaffold, same deps), `packages/blob-gc/src/plugin.ts` (timers, unref, drain), `packages/llm-anthropic/src/models-available.ts` + its test's `stub(pages)` (paged GET, page cap, never throws), `packages/embeddings` (`fetchImpl?: typeof fetch`, `invalid-config`), `presets/k8s/src/__tests__/blob-gc-report-acceptance.test.ts` (KEEP-list preset composition).

## Global Constraints

- No runtime cross-plugin imports. `@ax/connectors` mirrors the hook types locally (`*Like`), like `tool-permissions.ts`. Plugin code imports only `@ax/core` (and its subpaths `@ax/core/response-cap`, `@ax/core/surface-text`).
- Parameterized SQL only (kysely `sql` template with bound values). Text matching uses `strpos`, never LIKE.
- No test may reach the network: every fetch goes through `fetchImpl`; tests that boot the plugin also `vi.stubGlobal('fetch', …)` to a function that throws `network is off in tests`.
- Never put response text, headers or URLs from the registry into a log line or an error message. Failures are fixed short codes.
- Registry text is untrusted: clean with `replaceSurfaceRewriters(…, ' ')` FIRST (it turns U+0000 and the other controls, bidi and zero-width characters into a space; doing `toWellFormedText` first would leave U+FFFD where the NUL was) → `toWellFormedText` (lone surrogates) → collapse whitespace → trim → `clampCodeUnits` → trimEnd. Never hand-write a bidi/control character class (`scripts/__tests__/surface-text-single-owner.test.js`).
- Postgres tests: literal `new PostgreSqlContainer('postgres:16-alpine')`; package `vitest.config.ts` sets `testTimeout: 60_000`, `hookTimeout: 120_000` (out-of-process timeout guard, CI pre-pull guard). Hook timeouts are numeric literals; no `for (…; i < N && cond; …)` polling loops (use `vi.waitFor`).
- Deps exactly as `packages/host-grants/package.json` (kysely `0.28.17`, zod `^3.23.8`, dev: `@ax/database-postgres`, `@ax/test-harness`, `@testcontainers/postgresql` `11.14.0`, `pg` `8.20.0`, `@types/pg` `8.20.0`, `@types/node` `^25.6.0`, `typescript` `^6.0.3`, `vitest` `^5.0.1`). No new third-party package.
- Hook name `connectors:directory-search`; plugin name `@ax/connector-directory`; tables `connector_directory_v1_entries`, `connector_directory_v1_sync_state`.
- Docs and memory must contain no private-range IP literals (`no-deployment-specifics-committed`).

## Review Focus

1. **A server's newest version drops its remote (package-only, templated URL, http)** → the next incremental sync must DELETE the stored row, not just skip the insert. Pinned in Task 4, test 2.
2. **A listing whose title or description carries U+0000, a bidi override or zero-width characters** → stored cleaned; the page and the sync still succeed. Task 2 tests + Task 4, test 4.
3. **An admin types `%`, `_`, `\`, a quote, or 200+ characters** → literal match or a clean 400, never a 500 or a wildcard match. Task 5 (search 11, 12) + Task 6 (route 6).
4. **An operator switches `registryUrl` to a subregistry** → the old copy is cleared and the new source crawled in full; never a mix. Task 4, test 7.
5. **The registry hangs, redirects, or sends a huge page during host shutdown or a normal sync** → short-code failure, copy kept, `stale` shown, and shutdown does not wait on the request. Task 3 + Task 5 (plugin 5).

---

## Security pre-walk (feeds the `security-checklist` note in the PR)

Required for this PR: it adds network egress and stores untrusted third-party content. Tasks 2, 3, 4 and 5 are the ones that make the security decisions.

- **Sandbox escape:** N/A, and say why: host-only plugin, no IPC action, no tool, the sandbox never sees the directory; the only wire is an admin HTTP route.
- **Prompt injection / untrusted content:** every registry field is untrusted. Cleaned at sync (above), URLs normalized to WHATWG `href` (IDN homographs show as punycode) and refused when templated, credentialed, non-https, or over 2,048; ids pattern-checked; served as JSON to an admin UI that renders text (TASK-1101). A description reaches a model only after an admin saves it as a usage note (existing fencing). A hostile listing can only drop itself.
- **Network / capabilities (invariant 5):** one origin, operator-set, `https:` only, no redirects, 30 s per request, 30 min per run, 4 MiB per page, 2,000 pages, repeated cursor = failure; off unless configured (env unset = off; the chart turns it on by default). Host NetworkPolicy allows 443 to anywhere, nothing else.
- **DoS / DB bloat:** 100,000 rows, title 120, description 500, version 255; search limit ≤ 50, query ≤ 200; seq scan bounded by the row cap.
- **Integrity:** https protects "verified domain" claims from a MITM; publisher proof never upgrades on a guess (`io.github.*` checked first, uppercase or odd namespaces stay `account`).
- **Authz:** route is admin-only (401 / 403 pinned). SQL is parameterized.
- **Supply chain:** no new package; versions identical to `@ax/host-grants`.

## Boundary review (paste into the PR, CLAUDE.md format)

- **Alternate impl:** any subregistry implementing the registry OpenAPI (same plugin, different `registryUrl`; the plugin clears and re-crawls on a source change), or a static curated list baked into an air-gapped deployment.
- **Payload field names that might leak:** `url` is on the checklist's IPC row, but here it is the listing's subject (the address a connector will call, same field connectors already store), not how the hook is served. `keyHeader` is the connector vocabulary `headerName` already uses. `nextCursor` is our own opaque offset cursor; the registry's `name:version` cursor never leaves the plugin. `remotes`, `packages`, `_meta`, `isLatest`, `statusChangedAt` and `io.github.*` stay inside the normalizer. Pinned by the contract key-set test.
- **Subscriber risk:** none, a service hook with no subscriber payload.
- **Wire surface:** HTTP admin route `GET /admin/connectors/directory?q=&cursor=` only; no IPC action. The route forwards the hook's fields by name and adds nothing.

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/connector-directory/{package.json,tsconfig.json,vitest.config.ts}` | scaffold (copy host-grants) | 1 |
| `packages/connector-directory/src/contract.ts` | hook name, input/output/entry types + zod schemas, search limits | 1 |
| `packages/connector-directory/src/index.ts` | public exports | 1, 5 |
| `packages/connector-directory/src/limits.ts` | every sync-time named constant | 2 |
| `packages/connector-directory/src/normalize.ts` | raw registry entry → upsert / delete / skip | 2 |
| `packages/connector-directory/src/registry-client.ts` | registry URL validation, page URL, one-page fetch | 3 |
| `packages/connector-directory/src/migrations.ts`, `store.ts`, `sync.ts` | tables, row + state writes, the crawl | 4 |
| `packages/connector-directory/src/search.ts`, `plugin.ts` | cursor, ranked search, the plugin | 5 |
| `packages/connectors/src/directory-route.ts` + `admin-routes.ts`, `plugin.ts`, `store.ts` | admin route, optional call, reserved id | 6 |
| `packages/tool-connector-propose/src/plugin.ts` | reserved-id mirror | 6 |
| `presets/k8s/…`, `deploy/charts/ax-next/…`, `.changeset/connector-directory.md` | wiring, env, chart, composition test | 7 |
| `docs/plans/2026-11-09-mcp-directory-connectors-design.md` | stale lines | 8 |

Order: 1 → (2 ∥ 3) → 4 → 5 → 7 → 8. Task 6 depends only on the contract (Task 1) and can run beside 2-5.

---

### Task 1 [tier: integration] Package scaffold and the hook contract

**Files:**
- Create: `packages/connector-directory/package.json`, `tsconfig.json`, `vitest.config.ts` — copies of `packages/host-grants/{package.json,tsconfig.json,vitest.config.ts}` with the name changed (`tsconfig` references `[{ "path": "../core" }]` only; `files: ["dist"]`).
- Create: `packages/connector-directory/src/contract.ts`, `src/index.ts`, `src/__tests__/contract.test.ts`
- Modify: root `tsconfig.json` (add `{ "path": "packages/connector-directory" }` beside `packages/connectors`, ~line 45); `pnpm-lock.yaml` (one new importer block; every version already resolved).

**Interfaces — Produces** (`src/contract.ts`, re-exported from `src/index.ts`):
```ts
export const DIRECTORY_SEARCH_HOOK = 'connectors:directory-search';
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const QUERY_MAX = 200;   // UTF-16 code units
export const CURSOR_MAX = 64;
export type PublisherProof = 'domain' | 'account';
export type DirectoryAuth = 'signin' | 'key' | 'none';
export interface DirectoryEntry {
  id: string; title: string; description: string; publisher: string;
  publisherProof: PublisherProof; url: string; auth: DirectoryAuth;
  keyHeader?: string; version: string; updatedAt: string; deprecated?: true;
}
export interface DirectorySearchInput { query: string; limit?: number; cursor?: string }
export interface DirectorySearchOutput {
  enabled: boolean; entries: DirectoryEntry[]; syncedAt: string | null;
  stale: boolean; verifiedOnly: boolean; nextCursor?: string;
}
export const DirectorySearchInputSchema;   // z.object({...}).strict(): query max QUERY_MAX, limit int optional, cursor max CURSOR_MAX optional
export const DirectoryEntrySchema;         // z.object, enums as above, updatedAt string, deprecated z.literal(true).optional()
export const DirectorySearchOutputSchema;  // z.object; used as the hook's `returns` (zod strips undeclared keys, so it must list every field)
```
Export the raw `z.object` values (not cast to `ZodType`) so tests can read `.shape`. Doc-comment `auth` exactly: `'key'` = the listing says a key is required (`keyHeader` names the header when usable); `'none'` = the listing declares no required key, NOT "no sign-in" (the editor discovers sign-in from the address); `'signin'` = the source itself declares sign-in (the official registry cannot, so its entries never carry it).

- [ ] **Step 1: Write `contract.test.ts` (fails: module missing)**
  - `'the hook is connectors:directory-search'`
  - `'payload field names are exactly the contract, with no registry vocabulary'`:
    ```ts
    expect(Object.keys(DirectorySearchInputSchema.shape).sort()).toEqual(['cursor', 'limit', 'query']);
    expect(Object.keys(DirectorySearchOutputSchema.shape).sort()).toEqual(['enabled', 'entries', 'nextCursor', 'stale', 'syncedAt', 'verifiedOnly']);
    expect(Object.keys(DirectoryEntrySchema.shape).sort()).toEqual(['auth', 'deprecated', 'description', 'id', 'keyHeader', 'publisher', 'publisherProof', 'title', 'updatedAt', 'url', 'version']);
    // and no key across the three matches /remote|package|_meta|github|latest/i
    ```
  - `'input is strict and bounded'`: `safeParse` fails for `{query:'x', extra:1}`, a 201-char query, `limit: 2.5`, a 65-char cursor; passes for `{query:''}` and `{query:'a', limit: 500, cursor:'abc'}` (clamping is search's job, not the schema's).
  - `'entry enums are closed'`: `auth: 'oauth'` and `publisherProof: 'github'` fail.
  - `'search limits are pinned'`: `{SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, QUERY_MAX, CURSOR_MAX}` equals `{20, 50, 200, 64}`.
- [ ] **Step 2: Implement `contract.ts` and `index.ts`; add the root tsconfig reference.**
- [ ] **Step 3: Lockfile.** `pnpm install`, then `git diff pnpm-lock.yaml` must show only the new importer block (no `resolution:` lines). If unrelated churn appears, `git checkout pnpm-lock.yaml` and splice the importer block by hand (memory recipe, TASK-65). Prove it: `pnpm install --frozen-lockfile`.
- [ ] **Step 4: Run** `pnpm --filter @ax/connector-directory build && pnpm --filter @ax/connector-directory test` → PASS.
- [ ] **Step 5: Commit** `feat(connector-directory): scaffold package and hook contract (TASK-1100)`.

### Task 2 [tier: sensitive] Listing normalizer — untrusted registry content (security-checklist)

**Files:**
- Create: `packages/connector-directory/src/limits.ts`, `src/normalize.ts`
- Test: `src/__tests__/limits.test.ts`, `src/__tests__/normalize.test.ts`, helper `src/__tests__/support/listing.ts`

**Interfaces — Produces:**
```ts
// limits.ts — every cap is a named constant (card)
export const TITLE_MAX = 120, DESCRIPTION_MAX = 500, URL_MAX = 2048, VERSION_MAX = 255, ID_MAX = 200, KEY_HEADER_MAX = 64;
export const MAX_REMOTES_CONSIDERED = 16, MAX_HEADERS_CONSIDERED = 32;
export const MAX_ROWS = 100_000, PAGE_LIMIT = 100, MAX_PAGE_BYTES = 4 * 1024 * 1024, MAX_PAGES_PER_SYNC = 2_000, MAX_CURSOR_CHARS = 512;
export const REQUEST_TIMEOUT_MS = 30_000, SYNC_BUDGET_MS = 30 * 60_000, WATERMARK_OVERLAP_MS = 10 * 60_000;
export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60_000, DEFAULT_SYNC_INITIAL_DELAY_MS = 10_000;
export const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

// normalize.ts
export interface DirectoryRow {
  id: string; title: string; description: string; publisher: string; publisherProof: PublisherProof;
  url: string; auth: DirectoryAuth; keyHeader: string | null; version: string; updatedAt: Date; deprecated: boolean;
}
export type EntryPlan =
  | { kind: 'upsert'; row: DirectoryRow }
  | { kind: 'delete'; id: string; reason: 'deleted' | 'no-usable-remote' | 'invalid-fields' }
  | { kind: 'skip'; reason: 'malformed' | 'not-latest' };
export function planEntry(raw: unknown): EntryPlan;
export function derivePublisher(namespace: string): { publisher: string; publisherProof: PublisherProof };
export function pickRemote(remotes: unknown): { url: string; headers: unknown } | null;
export function deriveAuth(headers: unknown): { auth: DirectoryAuth; keyHeader?: string };
export function cleanText(raw: string, max: number): string;
```
Rules (the decisions shard has the why). Use hand-written type checks, not zod, and look at no more than `MAX_REMOTES_CONSIDERED` remotes and `MAX_HEADERS_CONSIDERED` headers.
- `planEntry`: `raw.server.name` must be a string matching `/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/` and ≤ `ID_MAX`, else `skip malformed`. Official meta = `raw._meta?.['io.modelcontextprotocol.registry/official']`. `isLatest === false` → `skip not-latest`. Status: absent / `'active'` normal, `'deprecated'` sets `deprecated`, `'deleted'` → `delete deleted`, any other value → `delete invalid-fields`. No usable remote → `delete no-usable-remote`. Version must be a string of 1..`VERSION_MAX`, with no `REWRITES_THE_SURFACE` match and equal to `toWellFormedText(version)` (it is provenance-equality material for TASK-1102, so it is never rewritten), else `delete invalid-fields`. `updatedAt` = first parseable of meta `updatedAt`, `statusChangedAt`, `publishedAt`, else `delete invalid-fields`. Title = `cleanText(title, TITLE_MAX)`, falling back to the id when empty or absent. Description = `cleanText(description ?? '', DESCRIPTION_MAX)`.
- `pickRemote`: first `type === 'streamable-http'` remote with a usable URL, else the first `'sse'` one. Usable URL: a string with no whitespace, no `{` or `}`, no `REWRITES_THE_SURFACE` match; `new URL` parses; protocol `https:`; empty username and password; `href.length <= URL_MAX`. Return the `href`. (Node's URL parser ACCEPTS `https://{tenant}.example.com/mcp` and silently drops a newline inside a host, hence the raw-string checks.)
- `deriveAuth`: credential header = object with a string `name`, `isRequired === true`, and (`isSecret === true` or `name.toLowerCase() === 'authorization'`). Distinct by lowercase name. 0 → `'none'`. 1 → `'key'` plus `keyHeader` when it matches the `headerName` regex at `packages/connectors/src/types.ts:149` (copy it verbatim; it contains a backtick, so it isn't quoted here) and is ≤ 64 chars. 2 or more → `'key'` with no `keyHeader`. Never `'signin'`.
- `derivePublisher`: `/^io\.github\.([A-Za-z0-9-]{1,39})$/i` → `account`, publisher = the login as written. Else, if the namespace equals its own lowercase, has ≥ 2 labels each matching `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`, and its first label (the TLD) matches `/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/` → `domain`, publisher = labels reversed and joined with `.`. Everything else → `account`, publisher = the namespace.
- `cleanText`: `replaceSurfaceRewriters(s, ' ')` (from `@ax/core/surface-text`; U+0000 is a C0 control, so it becomes a space here) → `toWellFormedText` (lone surrogates to U+FFFD) → `/\s+/g` → `' '` → trim → `clampCodeUnits(s, max)` → trimEnd. This order is load-bearing: `toWellFormedText` first would leave U+FFFD where a NUL was.

- [ ] **Step 1: `support/listing.ts`** — `listing(o: { name: string; title?: string; description?: string; version?: string; remotes?: unknown[]; packages?: unknown[]; status?: string; isLatest?: boolean; updatedAt?: string }): unknown` builds the raw registry JSON (`{ server: {...}, _meta: { 'io.modelcontextprotocol.registry/official': {...} } }`) with defaults: description `'A test server'`, version `'1.0.0'`, one streamable-http remote `https://mcp.example.com/mcp`, status `'active'`, isLatest `true`, `publishedAt` and `updatedAt` `'2026-11-01T00:00:00Z'`. Also `remote(url, type = 'streamable-http', headers?)` and `header(name, { isRequired?, isSecret? })`.
- [ ] **Step 2: Write `limits.test.ts`** — one test, `'every cap is pinned'`, asserting each constant above equals its value.
- [ ] **Step 3: Write `normalize.test.ts` (fails)**:
  - `'keeps a listing with a streamable-http remote'` → upsert, url `'https://mcp.example.com/mcp'`.
  - `'keeps an sse-only listing'`; `'prefers streamable-http over sse when both are listed'` (sse listed first).
  - `'a package-only listing deletes any stored row'` → `{ kind: 'delete', id, reason: 'no-usable-remote' }`; same for a `stdio` remote.
  - `'refuses unusable remote URLs'` (`it.each`): `http://x.example/mcp`, `https://{tenant}.example.com/mcp`, `https://x.example/{t}/mcp`, `https://u:p@x.example/mcp`, `'https://x.example\n.evil.example/x'`, `' https://x.example/mcp'`, `'https://x.example/' + 'a'.repeat(2048)` → `no-usable-remote`; a listing whose first remote is bad and second is good → upsert with the second.
  - `'stores the WHATWG href, so a lookalike host shows as punycode'`: `https://n\u043etion.com/mcp` (Cyrillic \u043e, written as `\u043e` in the test) → url `'https://xn--ntion-jye.com/mcp'`.
  - `'status deleted deletes; deprecated keeps and flags; an unknown status deletes; isLatest:false is skipped'`.
  - `'a name that fails the registry pattern or exceeds 200 is skipped as malformed'`; `'non-object input is skipped'` (`null`, `[]`, `'x'`).
  - `'version must be 1..255 with no surface-rewriting characters'` → `invalid-fields` for `''`, 256 chars, `'1.0\u202e'`.
  - `'updatedAt falls back to statusChangedAt then publishedAt; none parseable deletes'`.
  - Proof (`derivePublisher`, `it.each`): `com.linear` → domain `linear.com`; `app.linear` → domain `linear.app`; `com.figma.mcp` → domain `mcp.figma.com`; `ac.inference.sh` → domain `sh.inference.ac`; `io.github.octocat` → account `octocat`; `io.github.Octo-Cat` → account `Octo-Cat`; `IO.GITHUB.x` → account `x`; `io.github` → account `io.github`; `io.github.a.b` → account `io.github.a.b`; `Com.Example` → account `Com.Example`; `localhost` → account; `com.123` → account; `com.-bad` → account.
  - Auth (`deriveAuth`): no headers → `none`; `[header('X-API-Key', {isRequired:true, isSecret:true})]` → `{auth:'key', keyHeader:'X-API-Key'}`; required `Authorization` without `isSecret` → key `Authorization`; optional secret → `none`; required non-secret `x-project-id` → `none`; the same Authorization listed twice → key `Authorization`; two different required secrets → `{auth:'key'}` and no `keyHeader`; bad names (`''`, `'X API Key'`, `'x'.repeat(65)`, `'\u043a\u043b\u044e\u0447'`) → `{auth:'key'}` and no `keyHeader`; never returns `'signin'` for any of the above.
  - Text: title of 121 chars → 120; description of 501 → 500; a surrogate pair straddling 120 is dropped whole (no lone surrogate in the result); `'Not\u0000ion\u202e'` → `'Not ion'`; zero-width `'No\u200btion'` → `'No tion'`; newlines collapse to single spaces; title missing or whitespace-only → id.
- [ ] **Step 4: Implement `limits.ts` and `normalize.ts`.**
- [ ] **Step 5: Run** `pnpm --filter @ax/connector-directory test` → PASS. **Step 6: Commit** `feat(connector-directory): normalize untrusted registry listings`.

### Task 3 [tier: sensitive] Registry client — the only egress (security-checklist)

**Files:** Create `packages/connector-directory/src/registry-client.ts`. Test `src/__tests__/registry-client.test.ts`, helper `src/__tests__/support/fake-registry.ts`.

**Interfaces — Consumes:** `PAGE_LIMIT`, `MAX_PAGE_BYTES`, `REQUEST_TIMEOUT_MS`, `MAX_CURSOR_CHARS` (Task 2). **Produces:**
```ts
export type RegistryFailure =
  'timeout' | 'aborted' | 'network' | 'redirect' | 'too-large' | 'invalid-json' | 'invalid-shape' | `http-${number}`;
export class RegistryError extends Error {          // message is `registry request failed: <reason>`, nothing else
  readonly reason: RegistryFailure;
  constructor(reason: RegistryFailure);
}
export interface RegistryPage { servers: unknown[]; nextCursor?: string }
export interface PageQuery { since?: Date; cursor?: string }
/** https only; no username/password, query or fragment; trailing slashes dropped. Throws PluginError code 'invalid-config' (plugin '@ax/connector-directory'). */
export function parseRegistryUrl(raw: string): URL;
/** `<base path>/v0.1/servers?limit=100&version=latest[&updated_since=ISO][&cursor=…]`, built with URLSearchParams. */
export function registryPageUrl(base: URL, q: PageQuery): URL;
export function fetchRegistryPage(
  fetchImpl: typeof fetch, base: URL, q: PageQuery,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<RegistryPage>;   // throws RegistryError only
```
Behavior: `fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS), ...caller]) })`. Status 300-399 → cancel the body, `redirect`. Other non-2xx → cancel the body, `http-<status>`; never read it. 2xx → `capResponseBody(res, MAX_PAGE_BYTES)` (from `@ax/core/response-cap`), `.text()` (`ResponseTooLargeError` → `too-large`), `JSON.parse` (→ `invalid-json`). The body must be an object whose `servers` is an array (→ `invalid-shape`). `metadata.nextCursor`: a non-empty string → `nextCursor`; empty or absent → none; longer than `MAX_CURSOR_CHARS` → `invalid-shape`. A rejection whose name is `TimeoutError` → `timeout`; the caller's signal aborted → `aborted`; any other rejection → `network`.

- [ ] **Step 1: `support/fake-registry.ts`** — `createFakeRegistry(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetchImpl: typeof fetch; requests: URL[]; inits: RequestInit[] }` plus `page(servers: unknown[], nextCursor?: string): Response` (JSON, status 200). Model on `stub(pages)` in `packages/llm-anthropic/src/__tests__/models-available.test.ts`.
- [ ] **Step 2: Write `registry-client.test.ts` (fails)**:
  - `parseRegistryUrl`: `DEFAULT_REGISTRY_URL` parses; `'https://sub.example/registry/'` → pathname `/registry`; `it.each(['http://registry.example', 'https://u:p@registry.example', 'https://registry.example/?a=1', 'https://registry.example/#x', 'not a url'])` throws `PluginError` with `code === 'invalid-config'`.
  - `registryPageUrl`: `{}` → exactly `'https://registry.test/v0.1/servers?limit=100&version=latest'`; `since: new Date('2026-11-09T00:00:00Z')` → `searchParams.get('updated_since') === '2026-11-09T00:00:00.000Z'`; cursor `'io.github.a/b:1.0.0&evil=1'` → `searchParams.get('cursor')` equals it and `searchParams.get('evil')` is `null`; base `https://sub.test/registry` → pathname `/registry/v0.1/servers`.
  - `'GETs with redirect: manual, an AbortSignal and accept: application/json'` (read `inits[0]`).
  - `'returns servers and nextCursor'`; `'an empty or missing nextCursor means last page'`.
  - Failures (`it.each`, each `rejects` a `RegistryError` with the `reason`): 301 → `redirect`; 503 → `http-503`; `content-length` over `MAX_PAGE_BYTES` → `too-large`; a streamed body past the cap with no `content-length` → `too-large`; `'not json'` → `invalid-json`; `'[]'` and `'{"servers":{}}'` → `invalid-shape`; a 513-char `nextCursor` → `invalid-shape`; `fetchImpl` rejecting a `TypeError` → `network`; a fetch that waits on its signal with `timeoutMs: 20` → `timeout`; a caller signal aborted mid-request → `aborted`.
  - `'never echoes response text'`: a 500 whose body is `'UPSTREAM-SECRET'` and a 200 of `'UPSTREAM-SECRET'` (invalid JSON) → `err.message` excludes `UPSTREAM-SECRET`.
- [ ] **Step 3: Implement. Step 4: Run** → PASS. **Step 5: Commit** `feat(connector-directory): registry page client with fixed-origin egress`.

### Task 4 [tier: sensitive] Mirror tables, store and the sync crawl (security-checklist: DB bounds)

**Files:** Create `packages/connector-directory/src/migrations.ts`, `src/store.ts`, `src/sync.ts`. Test `src/__tests__/sync.test.ts` (one container for the file; `TRUNCATE` both tables in `beforeEach`; pattern `packages/blob-gc/src/__tests__/service.test.ts:27-40`).

**Migration** (exact DDL; `CREATE … IF NOT EXISTS`, no foreign keys, `runConnectorDirectoryMigration<DB>(db: Kysely<DB>): Promise<void>`):
```sql
CREATE TABLE IF NOT EXISTS connector_directory_v1_entries (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  publisher       TEXT NOT NULL,
  publisher_proof TEXT NOT NULL CHECK (publisher_proof IN ('domain', 'account')),
  url             TEXT NOT NULL,
  auth            TEXT NOT NULL CHECK (auth IN ('signin', 'key', 'none')),
  key_header      TEXT NULL,
  version         TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  deprecated      BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS connector_directory_v1_sync_state (
  id                  SMALLINT PRIMARY KEY CHECK (id = 1),
  source              TEXT NOT NULL,
  watermark           TIMESTAMPTZ NULL,
  synced_at           TIMESTAMPTZ NULL,
  last_attempt_at     TIMESTAMPTZ NULL,
  last_attempt_failed BOOLEAN NOT NULL DEFAULT false
);
```

**Interfaces — Consumes:** `planEntry`, `DirectoryRow` (Task 2); `fetchRegistryPage`, `RegistryError`, `RegistryFailure`, `RegistryPage`, `PageQuery` (Task 3). **Produces:**
```ts
export interface ConnectorDirectoryDatabase { connector_directory_v1_entries: …; connector_directory_v1_sync_state: … }
export interface SyncState { source: string; watermark: Date | null; syncedAt: Date | null; lastAttemptAt: Date | null; lastAttemptFailed: boolean }
export interface DirectoryStore {
  readState(): Promise<SyncState | null>;
  /** Insert the state row if missing. A different stored source: delete every entry and reset the state, one transaction. Resolves true when it cleared. */
  useSource(source: string): Promise<boolean>;
  /** One transaction: deletes first; then upserts, where a NEW id is skipped once the table holds maxRows rows. */
  applyPage(page: { upserts: DirectoryRow[]; deletes: string[] }, maxRows: number): Promise<{ upserted: number; deleted: number; capped: number }>;
  recordSuccess(at: { watermark: Date; syncedAt: Date }): Promise<void>;   // also clears last_attempt_failed
  recordFailure(at: Date): Promise<void>;                                 // sets last_attempt_at, last_attempt_failed = true; keeps watermark and synced_at
}
export function createDirectoryStore(db: Kysely<ConnectorDirectoryDatabase>): DirectoryStore;

export type SyncFailure = RegistryFailure | 'too-many-pages' | 'cursor-loop' | 'store';
export type SyncResult =
  | { outcome: 'ok'; full: boolean; pages: number; upserted: number; deleted: number; skipped: number; capped: number }
  | { outcome: 'failed'; reason: SyncFailure }
  | { outcome: 'disabled' };
export interface SyncDeps {
  store: DirectoryStore; source: string;
  fetchPage(q: PageQuery): Promise<RegistryPage>;
  now(): Date; logger: Logger;              // Logger from @ax/core
  maxRows?: number; maxPages?: number;     // default MAX_ROWS, MAX_PAGES_PER_SYNC
}
/** Never throws. */
export function runSync(deps: SyncDeps): Promise<SyncResult>;
```
`runSync` order: `startedAt = now()`; `useSource(source)`; `readState()`; `since = watermark ? watermark - WATERMARK_OVERLAP_MS : undefined` (no `since` = full crawl). Loop: page cap (`too-many-pages`), `fetchPage({ since, cursor })` with the SAME `since` on every page, plan every server (a later entry with the same id wins within a page), `applyPage`, stop on no `nextCursor`, a cursor seen before → `cursor-loop`. Success: `recordSuccess({ watermark: startedAt, syncedAt: now() })`, `logger.warn('connector_directory_row_cap_reached', { cap, skipped })` when `capped > 0`, `logger.info('connector_directory_sync_ok', { full, pages, upserted, deleted, skipped, capped })`. Any failure: `recordFailure(now())` (its own failure swallowed), `logger.warn('connector_directory_sync_failed', { reason })` (`reason` = `RegistryError.reason`, the loop's own code, or `store` for anything else), return `failed`.

- [ ] **Step 1: Write `sync.test.ts` (fails)**. Use the fake registry and `listing()` helpers; `now` is a controllable clock; `logger` is a recording fake.
  1. `'first sync crawls every page with no updated_since and keeps only https remotes'` — page 1 (`nextCursor 'c1'`): remote listing, package-only, sse-only; page 2: templated-URL listing → 2 rows; `requests[0]` has no `updated_since`; `requests[1].searchParams.get('cursor') === 'c1'`; state `watermark` = start time, `synced_at` set, `last_attempt_failed` false.
  2. `'the next sync asks for updated_since = last start − 10 min and applies changes'` — after (1) at t0, run again at t1: `updated_since === new Date(t0 - 600_000).toISOString()` on EVERY page; in the page: A `status: 'deleted'` → gone; B `'deprecated'` → `deprecated = true`; C newest version package-only → gone; D new title → updated; E `isLatest: false` → untouched.
  3. `'a failed page keeps the copy, records the failure and leaves the checkpoint'` — seeded success; next run: page 2 is 503 → `{ outcome: 'failed', reason: 'http-503' }`; pre-existing rows intact; `last_attempt_failed` true; `watermark` and `synced_at` unchanged; a later good run clears `last_attempt_failed`.
  4. `'a NUL or bidi character in a listing never fails the page'` — title `'Bad\u0000Title\u202e'` stored as `'Bad Title'`.
  5. `'the row cap skips new names but still applies updates and deletes'` — `maxRows: 3`, 3 seeded rows; page = 1 update, 1 delete, 2 new → table has 3 rows (update applied, delete applied, 1 new in), result `capped: 1`, warn `connector_directory_row_cap_reached` with `{ cap: 3, skipped: 1 }`.
  6. `'a repeated cursor and the page cap end the run as failures'` — `cursor-loop`; `maxPages: 2` with 3 pages → `too-many-pages`; both record the failure and keep rows.
  7. `'a different registry URL clears the old copy and crawls in full'` — run with source A, rows exist; run with source B whose fake fails page 1 → zero rows left and `synced_at` null (never served a mix); its request had no `updated_since`.
  8. `'the migration runs twice without error'`.
  9. `'logs failure reasons as short codes, never response text'` — a 500 with body `'UPSTREAM-SECRET'` → warn fields `{ reason: 'http-500' }` and no logged value contains `UPSTREAM-SECRET`.
- [ ] **Step 2: Implement `migrations.ts`, `store.ts`, `sync.ts`.** **Step 3: Run** (needs `DOCKER_HOST`, see CLAUDE.md) → PASS. **Step 4: Commit** `feat(connector-directory): mirror tables and hourly-sync crawl`.

### Task 5 [tier: sensitive] Search and the plugin (timers, concurrency, off switch)

**Files:** Create `packages/connector-directory/src/search.ts`, `src/plugin.ts`; modify `src/index.ts` (export the plugin factory and types, `DEFAULT_REGISTRY_URL`). Tests: `src/__tests__/cursor.test.ts` (no Docker), `src/__tests__/search.test.ts` (container), `src/__tests__/plugin.test.ts` (container), `src/__tests__/plugin-config.test.ts` (no Docker).

**Interfaces — Consumes:** Tasks 1-4. **Produces:**
```ts
// search.ts
export function encodeCursor(offset: number): string;   // base64url of JSON {"o":offset}
export function decodeCursor(cursor: string): number;   // integer 0..MAX_ROWS, exactly one key "o", else PluginError invalid-payload 'invalid cursor'
export function searchDirectory(
  db: Kysely<ConnectorDirectoryDatabase>, input: unknown, opts: { verifiedOnly: boolean },
): Promise<DirectorySearchOutput>;
// plugin.ts
export interface ConnectorDirectoryConfig {
  enabled?: boolean;                 // default true (card)
  registryUrl?: string;              // default DEFAULT_REGISTRY_URL; validated only when enabled
  verifiedPublishersOnly?: boolean;  // default false
  fetchImpl?: typeof fetch;          // test seam; default (input, init) => fetch(input, init)
  now?: () => Date;
  syncIntervalMs?: number;           // default DEFAULT_SYNC_INTERVAL_MS; 0 = no timers
  syncInitialDelayMs?: number;       // default DEFAULT_SYNC_INITIAL_DELAY_MS
}
export interface ConnectorDirectoryPlugin extends Plugin {
  /** Joins a sync already running; `{ outcome: 'disabled' }` when off or before init. Never throws. */
  sync(): Promise<SyncResult>;
  /** Resolves once any running sync has settled. */
  drain(): Promise<void>;
}
export function createConnectorDirectoryPlugin(config?: ConnectorDirectoryConfig): ConnectorDirectoryPlugin;
```
`searchDirectory`: `DirectorySearchInputSchema.safeParse(input)` fails → `PluginError` `invalid-payload`, message exactly `'invalid directory search input'`. Normalize the query (trim, collapse whitespace). Read the state: `syncedAt` ISO or null, `stale = lastAttemptFailed && syncedAt !== null`. Empty query, or `syncedAt` null → `entries: []` (no row query). Else `limit = min(50, max(1, input.limit ?? 20))`, `offset = cursor ? decodeCursor(cursor) : 0`, run the query below with `LIMIT limit + 1`, set `nextCursor = encodeCursor(offset + limit)` only when an extra row came back. Map rows: `keyHeader` only when not null, `deprecated: true` only when true, `updatedAt` ISO. Always `enabled: true`, `verifiedOnly: opts.verifiedOnly`.

The ranking (the one algorithm the tests pin but don't determine; `$q` is bound, never interpolated):
```sql
SELECT … FROM connector_directory_v1_entries e
WHERE (strpos(lower(e.title), lower($q)) > 0 OR strpos(lower(e.description), lower($q)) > 0
    OR strpos(lower(e.publisher), lower($q)) > 0 OR strpos(lower(e.id), lower($q)) > 0)
  AND ($verifiedOnly = false OR e.publisher_proof = 'domain')
ORDER BY
  CASE WHEN e.publisher_proof = 'domain' THEN 0 ELSE 1 END,
  CASE
    WHEN strpos('.' || lower(e.publisher) || '.', '.' || lower($q) || '.') > 0 THEN 0
    WHEN lower(e.title) = lower($q) THEN 1
    WHEN strpos(lower(e.title), lower($q)) = 1 THEN 2
    WHEN strpos(lower(e.title), lower($q)) > 0 THEN 3
    WHEN strpos(lower(e.id), lower($q)) > 0 OR strpos(lower(e.publisher), lower($q)) > 0 THEN 4
    ELSE 5
  END,
  lower(e.title), e.id
LIMIT $limitPlusOne OFFSET $offset
```

Plugin: manifest `{ name: '@ax/connector-directory', version: '0.0.0', registers: ['connectors:directory-search'], calls: enabled ? ['database:get-instance'] : [], subscribes: [] }`. Construction, only when enabled: `parseRegistryUrl(config.registryUrl ?? DEFAULT_REGISTRY_URL)`, and `syncIntervalMs` / `syncInitialDelayMs` must be non-negative safe integers (`invalid-config` otherwise). Init: register the hook with `{ returns: DirectorySearchOutputSchema }`. Disabled: validate the input the same way, then answer `{ enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly }`. Enabled: `database:get-instance` (ctx from `makeAgentContext({ sessionId: 'init', agentId: '@ax/connector-directory', userId: 'system' })`, as blob-gc), migrate, store, hook → `searchDirectory`, then (interval > 0) `setTimeout(initialDelay)` → `void sync()` and `setInterval(() => void sync(), interval)`, both `.unref()`. `sync()`: one in-flight promise; each run calls `runSync` with `fetchPage = (q) => fetchRegistryPage(fetchImpl, base, q, { signal: AbortSignal.any([AbortSignal.timeout(SYNC_BUDGET_MS), shutdownController.signal]) })`. `shutdown()`: clear both timers, `shutdownController.abort()`, await the in-flight sync. Same teardown on an `init` failure (blob-gc pattern).

- [ ] **Step 1: Write `cursor.test.ts`**: round trip for 0, 20, 100_000; `decodeCursor` throws `invalid-payload` `'invalid cursor'` for `'!!'`, base64url of `'nope'`, `{"o":-1}`, `{"o":1.5}`, `{"o":100001}`, `{"o":1,"x":1}`; the message never contains the input.
- [ ] **Step 2: Write `search.test.ts`** (seed via `store.applyPage` + `recordSuccess`):
  1. `'an empty or whitespace query returns no entries but still reports freshness'` (`''`, `'   '` → `entries: []`, `syncedAt` ISO, `stale: false`, `enabled: true`).
  2. `'never synced: no entries even when rows exist'` (rows, no `recordSuccess` → `[]`, `syncedAt: null`).
  3. `'matches title, description, publisher and id, case-insensitively'` (four rows, `ACME` in a different field each, query `'acme'` → all four).
  4. `'domain listings outrank account listings whatever the match'` (account with exact title `'Notion'` vs domain with a description-only hit → domain first).
  5. `'within a tier: publisher label, exact title, title prefix, title contains, id or publisher, description'` (six domain rows built for ranks 0-5, query `'zeta'` → that exact order).
  6. `'the official listing outranks a third party titled with the brand'` (`com.notion/mcp`, no title so title = id, publisher `notion.com` vs `com.insightfulpipe/notion` titled `'Notion'` → `com.notion/mcp` first for `'notion'`).
  7. `'ties break by title then id, the same every time'`.
  8. `'verifiedOnly drops account listings and says so'`.
  9. `'stale only when the last attempt failed and a copy exists'`.
  10. `'limit is clamped to 1..50 and pages with our cursor'` (60 matches: `limit: 500` → 50 + `nextCursor`; following it → 10, no `nextCursor`; `limit: 0` → 1).
  11. `'LIKE metacharacters and quotes match literally'` (`'%'`, `'_'`, `"o'brien"`, `'\\'` each return only rows containing that literal text; no error).
  12. `'bad input is invalid-payload with fixed text'` (201-char query, junk cursor, `{ query: 1 }`).
  13. `'keyHeader and deprecated appear only when set'` (`'keyHeader' in entry` false for a `none` row).
- [ ] **Step 3: Write `plugin-config.test.ts`** (no Docker; `vi.stubGlobal('fetch', …)` throwing):
  1. `'disabled: calls nothing, never fetches, answers the off body'` — `createTestHarness({ plugins: [p] })` with no services; `bus.call('connectors:directory-search', …, { query: 'x' })` equals `{ enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false }`; `p.sync()` → `{ outcome: 'disabled' }`; fake timers advanced 2 h → the `fetchImpl` spy never called; `p.manifest.calls` is `[]`.
  2. `'disabled echoes verifiedPublishersOnly'`.
  3. `'disabled ignores the registry URL'` (`registryUrl: 'http://x'` constructs).
  4. `'enabled with a bad registry URL or a negative interval fails with invalid-config'`.
  5. `'the factory default is enabled against the official registry'` (`calls` is `['database:get-instance']`).
- [ ] **Step 4: Write `plugin.test.ts`** (container; boot with `createDatabasePostgresPlugin({ connectionString })` in `createTestHarness`; `vi.stubGlobal('fetch', …)` throwing):
  1. `'the hook answers through the bus after a sync'` (`p.sync()` → `ok`; `bus.call(… { query: 'linear', limit: 5 })` returns the fake's Linear listing, `enabled: true`).
  2. `'first sync after the initial delay, then hourly; shutdown stops it'` (`vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })`, `syncInitialDelayMs: 10_000`: at 9_999 ms no request, at 10_000 one crawl, +1 h a second; `harness.close()`, +2 h no more requests; use `vi.advanceTimersByTimeAsync` and `p.drain()`).
  3. `'a sync started while one runs joins it'` (gated fake; two `sync()` calls return the same promise; one request per page).
  4. `'the returns schema holds the shape'` (every key of a real answer is in the contract).
  5. `'shutdown aborts an in-flight request and resolves'` (fetch waits on its signal; `close()` resolves; the sync result is `failed` / `aborted`; no unhandled rejection).
- [ ] **Step 5: Implement `search.ts`, `plugin.ts`, exports. Step 6: Run** `pnpm --filter @ax/connector-directory test` → PASS. **Step 7: Commit** `feat(connector-directory): ranked search hook and the plugin`.

### Task 6 [tier: integration] Admin route in `@ax/connectors` and the reserved id

**Files:**
- Create: `packages/connectors/src/directory-route.ts`
- Modify: `packages/connectors/src/admin-routes.ts` (handler in `createConnectorRouteHandlers`'s returned object; route entry beside `/admin/connectors/authored`, ~line 1122), `packages/connectors/src/plugin.ts` (one `optionalCalls` entry, appended after `auth:get-user`), `packages/connectors/src/store.ts:48-57`, `packages/tool-connector-propose/src/plugin.ts:25-31`.
- Test: `packages/connectors/src/__tests__/directory-route.test.ts` (no Docker: a bare `HookBus` with stub services), `packages/connectors/src/__tests__/plugin.test.ts` (manifest pin, ~line 48), `packages/connectors/src/__tests__/store.test.ts` (next to the `authored` case, ~line 555), `packages/tool-connector-propose/src/__tests__/plugin.test.ts` (next to the `authored` case, ~line 184).

**Interfaces — Produces** (`directory-route.ts`; local mirrors, NO import of `@ax/connector-directory`):
```ts
export const DIRECTORY_SEARCH_HOOK = 'connectors:directory-search';
export const DIRECTORY_QUERY_MAX = 200;
export const DIRECTORY_PAGE_SIZE = 20;
export const DIRECTORY_CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/;
export interface DirectoryEntryLike { /* the 11 contract fields */ }
export interface DirectorySearchInputLike { query: string; limit: number; cursor?: string }
export interface DirectorySearchOutputLike { enabled: boolean; entries: DirectoryEntryLike[]; syncedAt: string | null; stale: boolean; verifiedOnly: boolean; nextCursor?: string }
export const DIRECTORY_OFF_BODY: DirectorySearchOutputLike;  // { enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false }
/** Copies only the known fields, entry by entry. */
export function shapeDirectoryBody(out: DirectorySearchOutputLike): DirectorySearchOutputLike;
```
Handler `directorySearch(req, res)`: `authenticate(req, res, { adminOnly: true })`; `q = req.query.q ?? ''`, longer than 200 → 400 `{ error: 'invalid-query' }`; `cursor = req.query.cursor` (absent or `''` = no cursor), otherwise failing the regex → 400 `{ error: 'invalid-cursor' }`; `!deps.bus.hasService(DIRECTORY_SEARCH_HOOK)` → 200 `DIRECTORY_OFF_BODY`; else call the hook with `{ query: q, limit: 20, ...(cursor && { cursor }) }` (also for an empty `q`: the UI shows freshness before typing) → 200 `shapeDirectoryBody(out)`; errors via `handleHookError`. Route entry comment: exact paths beat `:id` whatever the order, so `directory` is reserved like `authored`. `optionalCalls` entry: `{ hook: 'connectors:directory-search', degradation: 'the admin connector directory answers as turned off (no @ax/connector-directory loaded)' }`. `RESERVED_CONNECTOR_IDS = new Set(['authored', 'directory'])` in both places, comments naming both routes.

- [ ] **Step 1: Write `directory-route.test.ts` (fails)** — `makeReq`/`makeRes` as in `admin-routes.test.ts:185-230`, extended with `query`; the auth stub throws `PluginError` code `'unauthenticated'` for anonymous:
  1. `'401 when signed out'` → `{ error: 'unauthenticated' }`, hook not called.
  2. `'403 for a signed-in non-admin'` → `{ error: 'forbidden' }`, hook not called.
  3. `'admin: forwards q, cursor and a page size of 20 and returns the hook body'` → hook input `toEqual({ query: 'linear', limit: 20, cursor: 'eyJvIjoyMH0' })`.
  4. `'an empty or missing q still asks the hook'` → `query: ''`.
  5. `'no directory plugin loaded: 200 with the off body'`.
  6. `'q over 200 characters is 400 invalid-query and a malformed cursor is 400 invalid-cursor; the hook is not called'` (cursors `'a.b'` and `'a'.repeat(65)`; `?cursor=` with an empty value counts as no cursor and is NOT an error).
  7. `'a hook invalid-payload becomes 400 with the hook\'s fixed message'`.
  8. `'only contract fields reach the wire'` (hook adds `debug` at the top and `remotes` on an entry → both absent).
  9. `'the admin bundle registers GET /admin/connectors/directory; the /settings bundle does not'` (capture `http:register-route` calls from `registerAdminConnectorRoutes` / `registerUserConnectorRoutes`).
- [ ] **Step 2: Reserved-id tests (fail):** store: `assertConnectorIdCreatable('directory')` throws `/reserved/`, `validateConnectorId('directory')` passes. tool-connector-propose: `'directory'` is rejected with the fixed reserved message before the hook is called (copy the `authored` test).
- [ ] **Step 3: Update the manifest pin** in `packages/connectors/src/__tests__/plugin.test.ts` with the new `optionalCalls` entry (exact text above).
- [ ] **Step 4: Implement. Step 5: Run** `pnpm --filter @ax/connectors test && pnpm --filter @ax/tool-connector-propose test` → PASS (connectors' other files need Docker). **Step 6: Commit** `feat(connectors): admin directory search route; reserve the directory id`.

### Task 7 [tier: integration] k8s preset, Helm chart and the composition test

**Files:**
- Modify: `presets/k8s/package.json` (`"@ax/connector-directory": "workspace:*"` before `@ax/connectors`), `presets/k8s/tsconfig.json` (`{ "path": "../../packages/connector-directory" }` before `connectors`, ~line 29), `pnpm-lock.yaml` (the preset importer's new link).
- Modify: `presets/k8s/src/index.ts` — import beside line 46; `K8sPresetConfig` field; push in section `9b. connectors`, immediately BEFORE line 1279; loader near the other boolean flags (~2017-2029).
- Modify: `presets/k8s/src/__tests__/preset.test.ts` (exact list ~307-366: add `'@ax/connector-directory'`; new tests below), `acceptance.test.ts` (`PLUGINS_TO_DROP` ~130-296, beside `'@ax/connectors'` at ~161), `multi-tenant-acceptance.test.ts` (`PLUGINS_TO_DROP` ~112-225, beside ~133), `prod-bootstrap.test.ts` (`REQUIRED_PROD_PLUGINS` ~207-256).
- Create: `presets/k8s/src/__tests__/connector-directory-composition.test.ts`
- Modify: `deploy/charts/ax-next/values.yaml` (new `# ─── Connector directory ───` block after `webTools`), `values.schema.json` (new `connectorDirectory` object), `templates/host/deployment.yaml` (three stanzas after `AX_ALLOW_USER_INSTALLED_SKILLS`, ~409-412), `__tests__/render.test.ts` (new block modeled on TASK-347's at ~1454).
- Create: `.changeset/connector-directory.md` (`'@ax/connector-directory': minor`, `'@ax/connectors': patch`, `'@ax/tool-connector-propose': patch`, `'@ax/preset-k8s': patch`; one plain paragraph).

**Interfaces — Consumes:** `createConnectorDirectoryPlugin`, `ConnectorDirectoryPlugin` (Task 5); the route (Task 6). **Produces:**
```ts
// K8sPresetConfig
connectorDirectory?: { enabled?: boolean; registryUrl?: string; verifiedPublishersOnly?: boolean; fetchImpl?: typeof fetch };
// createK8sPlugins, unconditional, before createConnectorsPlugin:
createConnectorDirectoryPlugin({
  enabled: config.connectorDirectory?.enabled === true,      // absent = OFF: hand-built configs never reach the network
  verifiedPublishersOnly: config.connectorDirectory?.verifiedPublishersOnly === true,
  ...(registryUrl / fetchImpl only when defined),
})
// loadK8sConfigFromEnv: enabled = (env.AX_CONNECTOR_DIRECTORY_ENABLED ?? '').toLowerCase() === 'true';
// verifiedPublishersOnly likewise from AX_CONNECTOR_DIRECTORY_VERIFIED_ONLY; registryUrl = AX_CONNECTOR_DIRECTORY_REGISTRY_URL when non-empty.
// Set config.connectorDirectory only when one of the three is on or non-empty (the preset's "leave it unset" convention).
```
Chart: `connectorDirectory: { enabled: true, registryUrl: "", verifiedPublishersOnly: false }`. Template:
```yaml
{{- if (include "ax-next.bool" .Values.connectorDirectory.enabled) }}
- name: AX_CONNECTOR_DIRECTORY_ENABLED
  value: "true"
{{- end }}
{{- with .Values.connectorDirectory.registryUrl }}
- name: AX_CONNECTOR_DIRECTORY_REGISTRY_URL
  value: {{ . | quote }}
{{- end }}
{{- if (include "ax-next.bool" .Values.connectorDirectory.verifiedPublishersOnly) }}
- name: AX_CONNECTOR_DIRECTORY_VERIFIED_ONLY
  value: "true"
{{- end }}
```
Schema: two `"type": "boolean"` entries (render.test.ts derives every values.yaml boolean and checks the schema) and `registryUrl` `{"type": "string", "pattern": "^$|^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$"}`. values.yaml comments (house voice): what it does (the host refreshes a copy of the public MCP Registry about hourly so Admin › Connectors can search it), `false` = no sync and no egress, the directory just shows its empty state; empty `registryUrl` = `https://registry.modelcontextprotocol.io`, a subregistry must be https and, under the default network policy, on port 443; `verifiedPublishersOnly` hides listings whose publisher proved only a GitHub account (admins can still add any server by hand). `kind-dev-values.yaml` and `gke-values.yaml` need no edit: both inherit `enabled: true`.

- [ ] **Step 1: Preset tests (fail)** in `preset.test.ts`:
  - exact list includes `'@ax/connector-directory'`.
  - `'loads the connector directory disabled when the config says nothing'` (`createK8sPlugins(stubConfig)` → found, `registers` `['connectors:directory-search']`, `calls` `[]`).
  - `'connectorDirectory.enabled turns the sync on'` (`calls` `['database:get-instance']`).
  - `'an enabled directory with an http registry URL fails the preset build'` (throws `invalid-config`).
  - Loader (copy the `AX_ALLOW_USER_INSTALLED_SKILLS` block, ~2297-2318): `'true'` → `{ enabled: true, verifiedPublishersOnly: false }`; none of the three set → `undefined`; `it.each(['false', '0', '', 'TRUE-ish', 'yes'])` for ENABLED alone → `undefined`; `'TRUE'` → enabled; VERIFIED_ONLY `'true'` alone → `{ enabled: false, verifiedPublishersOnly: true }`; REGISTRY_URL alone → passed through verbatim with `enabled: false`.
- [ ] **Step 2: Drop / keep lists:** add `'@ax/connector-directory'` to both `PLUGINS_TO_DROP` sets with a one-line comment (postgres-backed when enabled; the route that reaches it, `@ax/connectors`, is dropped here too; covered by the composition test), and to `REQUIRED_PROD_PLUGINS` (loaded unconditionally; disabled in that env so it boots with no database call). Leave the usage-limits / disk-quota drop sets alone: the plugin calls no http hook and, disabled, no database.
- [ ] **Step 3: Write `connector-directory-composition.test.ts`** (KEEP-list pattern of `blob-gc-report-acceptance.test.ts:51-56, 172-183, 87-111, 245-260`):
  - `beforeAll(…, 180_000)`: `startTestContainer(new PostgreSqlContainer('postgres:16-alpine'))`; `vi.stubGlobal('fetch', …)` throwing; `createK8sPlugins({ ...presetConfig(uri), connectorDirectory: { enabled: true, registryUrl: 'https://registry.test', fetchImpl: fake.fetchImpl } })`; KEEP `@ax/database-postgres`, `@ax/connectors`, `@ax/connector-directory` and assert the kept names; a stubs plugin registering `http:register-route` (records each `{ method, path, handler }`), `auth:require-user` (returns the test's current actor or throws `'unauthenticated'`), `credentials:list` (`{ credentials: [] }`); `bootstrap({ bus, plugins: [...kept, stubs], config: {} })`. `afterAll`: shutdown, `stopPostgresContainer`.
  - The fake registry serves one page: `app.linear/linear` (title `'Linear'`, remote `https://mcp.linear.app/mcp`), `io.github.someone/linear-tools` (account), and a package-only `com.example/pkg`.
  - Test `'route → hook → table: an admin search returns the synced listings, domain first'`: `await (dir as ConnectorDirectoryPlugin).sync()` → `ok`; call the captured `GET /admin/connectors/directory` handler with `query: { q: 'linear' }` as admin → 200, `enabled: true`, `syncedAt` set, `entries.map(e => e.id)` equals `['app.linear/linear', 'io.github.someone/linear-tools']`, the first has `publisherProof: 'domain'`, `publisher: 'linear.app'`, `url: 'https://mcp.linear.app/mcp'`, `auth: 'none'`.
  - Test `'a non-admin is refused'` → 403.
  - Test `'every registry request went to the configured origin'` → each `fake.requests` URL has origin `https://registry.test` and pathname `/v0.1/servers`.
- [ ] **Step 4: Chart test** in `render.test.ts`, `describeIfHelm('ax-next chart: connector directory (TASK-1100)', …)`: default render stamps `AX_CONNECTOR_DIRECTORY_ENABLED` = `"true"` and neither other var; `--set connectorDirectory.enabled=false` stamps none; `--set connectorDirectory.registryUrl=https://sub.example/registry` stamps it verbatim; `--set connectorDirectory.verifiedPublishersOnly=true` stamps `"true"`; `--set connectorDirectory.registryUrl=http://sub.example` fails the render.
- [ ] **Step 5: Implement** preset, chart and changeset. **Step 6: Run** `pnpm install --frozen-lockfile`; `pnpm --filter @ax/preset-k8s test`; `pnpm --filter @ax/preset-memory test` (it composes the k8s base set); `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test` (env-shape Gate 3 needs the template names) → PASS. Then the isolated-build trap check: `rm -rf packages/connector-directory/dist packages/connector-directory/tsconfig.tsbuildinfo && pnpm --filter @ax/preset-k8s build` → PASS. **Step 7: Commit** `feat(preset-k8s): wire the connector directory; chart values (TASK-1100)`.

### Task 8 [tier: mechanical] Stale design text

**Files:** Modify `docs/plans/2026-11-09-mcp-directory-connectors-design.md`.
- [ ] **Step 1:** Shape (`:67-68`): replace the hook line with the shipped contract (`{ query, limit?, cursor? } → { enabled, entries, syncedAt, stale, verifiedOnly, nextCursor? }`, entry with `deprecated?`), and the route with `GET /admin/connectors/directory?q=&cursor=`.
- [ ] **Step 2:** Decision 2: one paragraph — list endpoint `GET /v0.1/servers?version=latest`, checkpoint = sync start, next query `updated_since` minus a 10-minute overlap, rows capped at 100,000 (measured 2026-11-09: 40,135 remote listings in the first 60,000 entries; a 20,000 cap would have cut the crawl at `io.github.E…`).
- [ ] **Step 3:** Decision 5: ranking also puts a listing whose verified domain contains the query as a whole label first (Notion's, Stripe's and PayPal's listings have no title). Add one sentence on `auth`: the registry has no sign-in declaration, so `'signin'` is never derived from it; `'none'` means "declares no required key" and the editor discovers sign-in from the address.
- [ ] **Step 4:** Security, "No bypass" (`:98-99`): replace the `input-guards.ts` sentence with the truth: a prefilled URL goes through the same `connectors:upsert` path as a typed one, which does not check URLs server-side; the directory only stores https listings with no credentials or templates, and connect-time guards (mcp-oauth `ssrf.ts`, mcp-client `safe-fetch.ts`) apply as for any connector.
- [ ] **Step 5: Commit** `docs(plans): directory design matches the shipped contract`.

---

## Verification gate (before the PR)

- `pnpm build`, `pnpm lint`, `pnpm typecheck`.
- `pnpm --filter @ax/connector-directory test`, `pnpm --filter @ax/connectors test`, `pnpm --filter @ax/tool-connector-propose test`, `pnpm --filter @ax/preset-k8s test`, `pnpm --filter @ax/preset-memory test`, `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test` (Docker suites need `DOCKER_HOST`, see CLAUDE.md).
- `pnpm test:scripts` (tsconfig references, out-of-process timeouts, CI pre-pull image, zod version, surface-text single owner, memory cited paths) and `pnpm test:eslint-rules`.
- `pnpm install --frozen-lockfile && pnpm audit --audit-level moderate`.
- The lockfile changes, so CI runs the FULL suite. Run it locally the way CLAUDE.md says: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- `grep -rn "registry.modelcontextprotocol.io" packages/connector-directory/src presets/k8s/src --include='*.ts'` (quote the glob: the Bash tool runs zsh, which aborts on an unmatched `*.ts`): the only non-test hit is `DEFAULT_REGISTRY_URL`, and no test passes it to a live fetch.
- PR description: the Boundary review above, the `security-checklist` note (run the skill; seed it from the pre-walk), the measured facts from the decisions shard, and two operational notes: deploying this turns on hourly egress from the host to `registry.modelcontextprotocol.io:443` (allowed by the existing NetworkPolicy), and the first sync is a full crawl (~60k+ entries, a few minutes, ~55 MB at the time of measuring).

## Follow-ups to file (not this PR)

- TASK-1101 must not render `auth: 'none'` as "no sign-in needed" (see the contract doc comment).
- Periodic full re-crawl with reconciliation (the guide warns of data resets before GA).
- A sooner retry after a failed sync (today: the next hourly tick).
- Prefer domain-proven rows when the 100,000 cap is reached.
- Derive `'signin'` once the registry schema can declare authorization.
