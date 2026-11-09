# MCP directory: "Find in directory" UI (TASK-1101) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin › Connectors gets "Find in directory". The admin searches the host's mirror of the MCP directory (`GET /admin/connectors/directory`, shipped in TASK-1100 / #1162), checks a listing's publisher in a side sheet, and presses "Set it up" to open the existing create editor already filled in. Nothing is saved until they press **Add connector**.

**Architecture:** A new client module, `lib/connector-directory.ts`, owns the wire types, the fetch, a defensive normalizer, the listing → `ConnectorPrefill` mapping and server-address matching. Two new components render it: `DirectoryListingRow`, a presentational row plus sheet built on `SettingsDetailRow`, and `ConnectorDirectory`, the stateful subview. `ConnectorsTab` swaps its list for the subview and passes the prefill down the unchanged `ConnectorEditDialog` → `prefillForRemoteForm` → `RemoteMcpConnectorForm` path. The only form change is copy that knows the prefill came from the directory.

**Tech Stack:** React 19 + TypeScript; the shadcn primitives installed in `packages/channel-web`; vitest + jsdom + `@testing-library/react`. Tests use `fireEvent`, because `@testing-library/user-event` is not installed.

**Spec:** `docs/plans/2026-11-09-mcp-directory-connectors-design.md`, the TASK-1101 card, and the approved mock's copy (quoted, with corrections, in **Copy** below). The planner's decisions and evidence are in `.claude/memory/decisions/2026-11-09-TASK-1101.md`.

## Where this plan departs from the card (verified; read first)

1. **`keyMode` is `'personal'` for every listing.** The card said `'workspace'` for key auth. Agent requests have no auth-based default: `listAuthoredProposals` maps anything else to `'personal'` (`lib/connectors.ts:452`). The editor also defaults to `'personal'` (`RemoteMcpConnectorForm.tsx:148-150`), and so does the mock's Set it up.
2. **Key and sign-in slots go in TOP-LEVEL `capabilities.credentials`, with `server` naming the server.** The server's own `allowedHosts` and `credentials` stay empty, and there is no top-level `allowedHosts`. `prefillForRemoteForm` only carries top-level slots on that server. Anything nested inside a server lands in `leftOut` instead (`connector-request-prefill.ts:85-118`), so the card's shape would prefill nothing. The URL host is added on save (`remote-mcp-form.ts:228-236`).
3. **`connectorId` is a slug the server accepts, plus `-`, plus 8 random hex characters.** `connectorIdFromName` keeps `.` (`connector-form.ts:653-655`), but the server only accepts `^[a-z0-9][a-z0-9_-]*$` (`packages/connectors/src/store.ts:28`). The remote form has no id field, so an id clash would leave the admin stuck.
4. **Nothing says "No sign-in".** `'none'` means only that the listing declares no required key (`packages/connector-directory/src/contract.ts:23-30`), and the big OAuth servers are `'none'`.
5. **An `'account'` publisher reads "Community · X", never "GitHub user X".** `'account'` also covers namespaces that aren't GitHub (`packages/connector-directory/src/normalize.ts:195-212`). Task 3 corrects the stale line in the design doc.
6. **"Already in your connectors" can't use data the tab already has.** `GET /admin/connectors` returns summaries with no capabilities (`packages/connectors/src/types.ts:328-340`). Instead, the subview reads each connector's full record, as the agent rail's Add view already does (`AddConnector.tsx:200-212`). The list view still makes zero such reads.
7. **When the directory is off (`enabled: false`), the "Find in directory" button is hidden.** The tab checks once on mount.
8. **TASK-1102 seam.** `ConnectorPrefill.fromDirectory = { directoryId, version }` is set here (the name comes from 1102's card) and drives the editor copy. It is **not** sent on save; 1102 adds it to the create body.

## Global Constraints

- **Invariant 2.** channel-web imports nothing from `@ax/connectors` or `@ax/connector-directory` at runtime. Mirror the wire shape locally from `packages/connectors/src/directory-route.ts`: `DirectoryEntryLike`, `DirectorySearchOutputLike`, `DIRECTORY_QUERY_MAX = 200`, and `DIRECTORY_CURSOR_RE = /^[A-Za-z0-9_-]{1,64}$/`.
- **Invariant 6.** Compose only installed primitives:
  - `SettingsDetailRow` (which wraps `Sheet`), `Badge`, `Button`
  - `Field`/`FieldLabel`, `InputGroup`/`InputGroupAddon`/`InputGroupInput`
  - `Alert`/`AlertDescription`, `Empty`/`EmptyHeader`/`EmptyTitle`/`EmptyDescription`/`EmptyContent`
  - `Skeleton`, `Spinner`, and lucide icons

  Use semantic tokens only. No new shadcn component is needed. Invoke the `shadcn` skill before writing UI, and the `ux-design` skill if any copy has to change from the table below.
- **Untrusted text.** Every registry field (title, description, publisher, version, url, keyHeader) renders as React text nodes. Never use `dangerouslySetInnerHTML`, and never put a registry value in an `href` or `src`. The URL is shown only as its host (`directoryHost`).
- **Admin only.** The directory exists only in `components/settings/ConnectorsTab.tsx`, which is mounted only for admins (`AdminShell.tsx:165`). `components/workspace/AddConnector.tsx` stays untouched.
- **No full reads in list view.** The list view must still make **zero** `getConnector` calls (test `reads no credential presence and no full connector records`, `ConnectorsTab.test.tsx:627-635`). Full records are read only while `ConnectorDirectory` is mounted.
- **Save path unchanged.** Saving still runs `createConnector` → `POST /admin/connectors`. The body keeps exactly today's keys: `capabilities, connectorId, keyMode, name, usageNote` (`RemoteMcpConnectorForm.tsx:569-575`).
- **Copy.** Use the exact strings in **Copy**, with the typographic `’` `“` `”` the existing UI uses. Tests assert the same characters.
- **Type-check tests too.** channel-web's `tsconfig.json` includes all of `src`, so test files are type-checked. Strictness is on (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), so a fixture override can't set an optional field to `undefined`. After each task run `pnpm --filter @ax/channel-web exec tsc --build`.
- **Test commands** go filter first: `pnpm --filter @ax/channel-web exec vitest run <file>` and `pnpm --filter @ax/channel-web test`.
- **Test patterns:**
  - Spy on lib namespaces with `vi.spyOn`, e.g. `import * as directoryLib from '@/lib/connector-directory'`, as `ConnectorsTab.test.tsx` does with `connectorsLib`.
  - Drive the UI with `fireEvent`.
  - Use real timers with `findBy*`/`waitFor`, unless a step says otherwise.

## Copy (exact strings)

| Key | Where | String |
|---|---|---|
| `find` | ConnectorsTab header action (`variant="outline"`, placed before New connector) | `Find in directory` |
| `back` | subview back button (`variant="ghost"`, `ChevronLeft`, `aria-label="Back to connectors"`) | `Connectors` |
| `heading` | subview `h2` | `Find a connector` |
| `intro` | under the heading, muted | `Search a public directory of services that work with agents. Anyone can publish to it, so each result shows who published it.` |
| `searchLabel` / `placeholder` | visible `FieldLabel` / input placeholder | `Search the directory` / `Search by service, like Notion or Stripe` |
| `fresh` | muted status line | `` `List updated ${timeAgo(syncedAt)}` `` (`timeAgo` from `@/lib/workspace-time`: "List updated 12 min ago"). Omitted when `timeAgo` returns null. |
| `stale` | `Alert role="note"`, `data-testid="directory-stale"`, replaces `fresh` | `` `We couldn’t refresh the directory, so this is the list from ${timeAgo(syncedAt)}. New servers may be missing. We’ll keep trying.` ``. If `timeAgo` is null: `We couldn’t refresh the directory, so this list may be out of date. New servers may be missing. We’ll keep trying.` |
| `verifiedOnly` | muted status line | `Only listings from verified publishers are shown in this workspace.` |
| `notYet` | `Empty` when `enabled && syncedAt === null` | Title `The directory isn’t available yet`. Description `We haven’t been able to load it since this workspace started, so there’s nothing to search yet. The first load takes a few minutes. If it never finishes, your network may be blocking outside sites. You can still set up a connector by hand.` Buttons `Try again` (outline) and `New connector`. |
| `off` | `Empty` when `enabled === false` | Title `The directory is turned off in this workspace`. Description `You can still set up a connector by hand.` Button `New connector`. |
| `loadFailed` | `Alert` (default role) + outline button | `We couldn’t load the directory just now.` / `Try again` |
| `searching` | `p role="status"` + `Spinner` | `Searching…` |
| `searchFailed` | `Alert` + outline button | `We couldn’t search the directory just now.` / `Try again` |
| `count` | `p role="status"` above the rows | No `nextCursor`: `1 server matches` or `` `${n} servers match` ``. With `nextCursor`: `` `More than ${n} servers match` `` (the route sends 20 rows and no total). |
| `noMatch` | `Empty` | Title `` `Nothing matches “${query}”` ``. Description `Try the service’s name rather than what it does. Not every service is listed yet. If you know its address, you can set it up by hand.` Button `New connector`. |
| `more` / `moreFailed` | outline button / muted line | `Show more` / `We couldn’t load more just now.` |
| `localOnly` | footnote, muted | `Only servers on the web are listed. Ones that run on someone’s own computer can’t be reached by agents, so we leave them out.` |
| `proofDomain` | row, `data-testid="directory-proof-domain"` | `ShieldCheck` icon (`aria-hidden`, `text-primary`), then `` `Published by ${publisher}` ``, then an `sr-only` ` (verified)` |
| `proofAccount` | row, `data-testid="directory-proof-account"` | `` `Community · ${publisher}` `` |
| chips | row `value` (`Badge size="compact"`) | `key` → `API key`; `signin` → `Sign-in`; `none` → **no chip**. Also `Added` (`variant="accent"`) and `Deprecated` (`variant="warning"`). |
| sheet description | `SheetDescription` | the listing's description, or `The publisher didn’t add a description.` when it's empty |
| sheet labels | `dl` | `Published by`, `Connects to`, `How people connect`, `Listing` |
| `noteDomain` / `noteAccount` | under Published by | `` `The publisher proved they control ${publisher}.` `` / `A community listing. It isn’t checked against any company.` |
| `howSignin` | How people connect | `Each person signs in from their agent’s Connectors tab.` |
| `howKeyHeader` | 〃 | `` `Needs an API key, sent in the ${keyHeader} header. You choose whether each agent brings its own key or everyone shares one.` `` |
| `howKey` | 〃 (key, no `keyHeader`) | `Needs an API key. You’ll add the request header it goes in when you set it up.` |
| `howNone` | 〃 | `The listing doesn’t mention a key. When you set it up, we’ll check whether people need to sign in.` |
| `listing` | Listing | `` `Version ${version}` ``, plus `` ` · updated ${monthDay(updatedAt)}` `` when `monthDay` (`@/lib/workspace-time`) returns non-empty |
| `deprecatedNote` | sheet, muted | `This listing is marked deprecated, so it may stop working.` |
| `trust` | sheet `Alert role="note"` with `Info` icon | `The directory checks who published a server, not what it does. An agent with this connector can send it whatever the agent is working on, so only add servers you’d trust with that.` |
| sheet buttons | sheet footer | `Set it up`, or a disabled `Already in your connectors` |
| `editorDescription` | `RemoteMcpConnectorForm` DialogDescription (directory prefill) | `Filled in from the directory. Check it over before you add it.` |
| `usageNoteHelp` | "How to use it" FieldDescription (directory prefill) | `Every assistant that uses this connector reads this note. The listing’s publisher wrote it, so rewrite it in your own words.` |

## Review Focus

1. **Answers arriving out of order while the admin types.** Example: "no" is answered after "notion". Only the newest query's rows should show. Test: Task 4, `a slow answer for an older query never replaces a newer one`.
2. **A query with `&`, `#`, `%`, `+` or spaces.** It should go to the route as one `q` value, never split. Test: Task 1, `encodes the query and cursor as single values`.
3. **The same server written differently, or a nearby one.**
   - An upper-case host, `:443` or a trailing `/` is the same server, so the listing shows as "Added".
   - The same host with another path (`/sse` vs `/mcp`) is a different server, so it does not.

   Tests: Task 1, `serverAddressKey treats one server written differently as one`; Task 4, `marks a listing whose address a connector already uses`.
4. **Titles that make bad ids**, such as `com.stripe/mcp`, `日本語`, 120 characters, or `Directory`. Each should still give a server-valid id, and a new one on every click. Test: Task 1, `connectorId is a fresh id the server accepts`.
5. **A pasted query longer than the route's limit.** The input stops at 200 characters, so the route never answers 400. Test: Task 4, `caps the query at the route's limit`.

## File map

| File | Change |
|---|---|
| `packages/channel-web/src/lib/connector-directory.ts` | **Create.** Wire types, `searchDirectory`, `normalizeDirectoryPage`, `prefillFromDirectoryEntry`, `directoryHost`, `serverAddressKey`, `connectorServerAddresses`. |
| `packages/channel-web/src/lib/__tests__/directory-fixtures.ts` | **Create.** `directoryEntry()` and `directoryPage()` test helpers (not a test file; `routine-fixture.ts` is the precedent). |
| `packages/channel-web/src/lib/__tests__/connector-directory.test.ts` | **Create.** |
| `packages/channel-web/src/lib/connectors.ts` | Modify `ConnectorPrefill` (lines 482-496): add `fromDirectory`. |
| `packages/channel-web/src/lib/connector-request-prefill.ts` | Header comment only (lines 11-16). |
| `packages/channel-web/src/components/settings/RemoteMcpConnectorForm.tsx` | Directory-aware copy (around lines 662-665, 765-770 and 799-801). |
| `packages/channel-web/src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx` | New `describe` block, plus one assertion in an existing test. |
| `packages/channel-web/src/components/settings/DirectoryListingRow.tsx` | **Create,** with `__tests__/DirectoryListingRow.test.tsx`. |
| `packages/channel-web/src/components/settings/ConnectorDirectory.tsx` | **Create,** with `__tests__/ConnectorDirectory.test.tsx`. |
| `packages/channel-web/src/components/settings/ConnectorsTab.tsx` | Modify, plus `__tests__/ConnectorsTab.test.tsx`. |
| `packages/channel-web/src/components/workspace/__tests__/AddConnector.test.tsx` | One negative test. |
| `docs/plans/2026-11-09-mcp-directory-connectors-design.md` | Lines 47-48: the stale copy line. |
| `.changeset/connector-directory-ui.md` | **Create.** |

---

### Task 1: Directory client, normalizer and listing → prefill mapping [tier: sensitive]

> **security-checklist:** this task normalizes untrusted registry data. It also builds the prefill — name, usage note, server URL and key header — that the admin is about to save.

**Files:**
- Create: `packages/channel-web/src/lib/connector-directory.ts`
- Create: `packages/channel-web/src/lib/__tests__/directory-fixtures.ts`
- Create: `packages/channel-web/src/lib/__tests__/connector-directory.test.ts`
- Modify: `packages/channel-web/src/lib/connectors.ts:482-496` (`ConnectorPrefill`)
- Modify: `packages/channel-web/src/lib/connector-request-prefill.ts:11-16` (comment)

**Interfaces:**
- Consumes:
  - `ConnectorPrefill`, `Connector` from `@/lib/connectors`
  - `newHeaderSlot(): string` from `@/lib/connector-credential-slots`
  - `headerNamePattern` from `@/lib/remote-mcp-form`
- Produces, in `lib/connector-directory.ts`:
  ```ts
  export type DirectoryAuth = 'signin' | 'key' | 'none';
  export type PublisherProof = 'domain' | 'account';
  export interface DirectoryEntry {
    id: string; title: string; description: string; publisher: string;
    publisherProof: PublisherProof; url: string; auth: DirectoryAuth;
    keyHeader?: string; version: string; updatedAt: string; deprecated?: true;
  }
  export interface DirectoryPage {
    enabled: boolean; entries: DirectoryEntry[]; syncedAt: string | null;
    stale: boolean; verifiedOnly: boolean; nextCursor?: string;
  }
  export const DIRECTORY_QUERY_MAX = 200;
  export function directoryOffPage(): DirectoryPage;
  export async function searchDirectory(
    query: string, options?: { cursor?: string; signal?: AbortSignal },
  ): Promise<DirectoryPage>;
  export function normalizeDirectoryPage(raw: unknown): DirectoryPage;
  export function prefillFromDirectoryEntry(entry: DirectoryEntry): ConnectorPrefill;
  export function directoryHost(url: string): string;
  export function serverAddressKey(url: string): string | null;
  export function connectorServerAddresses(connectors: readonly Connector[]): Set<string>;
  ```
- Produces, in `lib/connectors.ts`: `ConnectorPrefill.fromDirectory?: { directoryId: string; version: string }`.
- Produces, in `lib/__tests__/directory-fixtures.ts`:
  - `directoryEntry(overrides?: Partial<DirectoryEntry>): DirectoryEntry`. Defaults: `{ id: 'app.linear/linear', title: 'Linear', description: 'Find, create and update Linear issues.', publisher: 'linear.app', publisherProof: 'domain', url: 'https://mcp.linear.app/mcp', auth: 'none', version: '1.4.0', updatedAt: '2026-11-03T12:00:00.000Z' }`. There is **no** `keyHeader` and **no** `deprecated`, because `exactOptionalPropertyTypes` means a test adds optional fields rather than removing them. A key listing is `directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })`.
  - `directoryPage(overrides?: Partial<DirectoryPage>): DirectoryPage`. Defaults: `{ enabled: true, entries: [], syncedAt: new Date(Date.now() - 12 * 60_000).toISOString(), stale: false, verifiedOnly: false }`.

- [ ] **Step 1: Write the fixtures file, then the failing tests** in `connector-directory.test.ts` (`// @vitest-environment` stays the default jsdom). Stub fetch with `vi.spyOn(globalThis, 'fetch')` returning `new Response(JSON.stringify(...), { status })`, and call `vi.restoreAllMocks()` in `afterEach`.
  - `describe('searchDirectory')`:
    - `asks the admin route with the query, credentials and signal`: given `searchDirectory('notion', { signal })`, the first fetch argument is `'/admin/connectors/directory?q=notion'` and the second `toMatchObject({ credentials: 'include', signal })`. The result's `entries[0]` equals `directoryEntry()`.
    - `encodes the query and cursor as single values`: given `searchDirectory('a&b #c%+d', { cursor: 'eyJvIjoyMH0' })`, the URL is `'/admin/connectors/directory?q=a%26b+%23c%25%2Bd&cursor=eyJvIjoyMH0'`. Without a cursor there is no `cursor=` in the URL.
    - `reads a 404 as the directory being off`: the result equals `{ enabled: false, entries: [], syncedAt: null, stale: false, verifiedOnly: false }`.
    - `throws on any other failure`: a 500 rejects with `/search directory: 500/`.
  - `describe('normalizeDirectoryPage')`:
    - `never upgrades trust`: `publisherProof` values `'Domain'`, `'verified'` and missing all become `'account'`. `auth` values `'oauth'`, `'Key'` and missing all become `'none'`.
    - `drops listings it can't use`: entries with no `id`, no `url`, an `http://` url, or a url of `'not a url'` are dropped, and a valid one in the same list is kept.
    - `falls back to the id when the title is empty`. Non-string `description`/`publisher`/`version`/`updatedAt` become `''`.
    - `keeps keyHeader only when it is a valid header name`: `'X-API-Key'` is kept. `'Bad Header'` and a 65-character name are removed (no `keyHeader` key).
    - `marks deprecated only when exactly true`: `true` gives `deprecated: true`. `'yes'` and `false` give no key.
    - `keeps nextCursor only in the route's alphabet`: `'abc_-1'` is kept. `'a b'` and a 65-character cursor are removed.
    - `reads flags only when exactly true`: `enabled`, `stale` and `verifiedOnly` are true only for `true`. `syncedAt` is kept only as a string, otherwise `null`. `null`, `'x'` and `[]` bodies give `directoryOffPage()`.
  - `describe('prefillFromDirectoryEntry')`, with `const key = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })`:
    - `a key listing with a header: one header slot on the leading server`: `p.capabilities` equals:
      ```ts
      {
        allowedHosts: [],
        credentials: [{ slot: expect.stringMatching(/^HEADER_[0-9A-F]{32}$/), kind: 'api-key', headerName: 'X-API-Key', server: p.connectorId }],
        mcpServers: [{ name: p.connectorId, transport: 'http', url: 'https://mcp.linear.app/mcp', allowedHosts: [], credentials: [] }],
        packages: { npm: [], pypi: [] },
      }
      ```
      Also `p.name === 'Linear'`, `p.usageNote === key.description`, `p.keyMode === 'personal'`, `p.fromDirectory` equals `{ directoryId: 'app.linear/linear', version: '1.4.0' }`, and `p` has no `leftOut` property.
    - `a key listing without a header gets no slot`: given `directoryEntry({ auth: 'key' })`, `credentials` is `[]`.
    - `a sign-in listing gets one OAuth slot naming the server`: `credentials` is `[{ slot: 'MCP_OAUTH', kind: 'oauth', server: p.connectorId }]`.
    - `a listing with no declared key gets no slot and still starts personal`.
    - `connectorId is a fresh id the server accepts`: for each title in `['Linear MCP', 'com.stripe/mcp', '日本語', 'x'.repeat(120), 'Directory', '  --Weird__Name--  ']`, the id
      - matches `/^[a-z0-9][a-z0-9_-]*$/` (the server rule, `packages/connectors/src/store.ts:28`),
      - is at most 128 characters,
      - ends with `/-[0-9a-f]{8}$/`,
      - and is not `'directory'` or `'authored'`.

      Exact cases:
      - `'Linear MCP'` → `/^linear-mcp-[0-9a-f]{8}$/`
      - `'com.stripe/mcp'` → `/^com-stripe-mcp-[0-9a-f]{8}$/`
      - `'日本語'` → `/^connector-[0-9a-f]{8}$/`
      - `'  --Weird__Name--  '` → `/^weird-name-[0-9a-f]{8}$/`
      - the 120-character title → a slug part of 48 characters

      Two calls on one entry give different ids.
    - `lands in the remote editor exactly as mapped`: this is the contract with `ConnectorEditDialog`. For each of the key, signin and none prefills `p`, let `const r = prefillForRemoteForm(p)`. Then:
      - `r.leftOut` equals `[]`
      - `r.capabilities.credentials` equals `p.capabilities.credentials`
      - `r.capabilities.mcpServers[0]?.url === p.capabilities.mcpServers[0]?.url`
      - `r.fromDirectory` equals `p.fromDirectory`

      And `remoteDraftFromProposal(r.name, r.capabilities)` gives:
      - key: `headers` equals `[{ slot: expect.any(String), name: 'X-API-Key', value: '', saved: false }]` and `useKey: true`
      - signin: `signIn: 'oauth'`
      - none: `headers: []`, `signIn: 'none'`
  - `describe('server addresses')`:
    - `directoryHost shows only the host`:
      - `'https://mcp.linear.app/mcp'` → `'mcp.linear.app'`
      - `'https://bücher.example/mcp'` → `'xn--bcher-kva.example'`
      - `'https://mcp.example.com:8443/x'` → `'mcp.example.com:8443'`
      - `'not a url'` → `''`
    - `serverAddressKey treats one server written differently as one`:
      - `'https://MCP.Linear.app:443/mcp/'` and `' https://mcp.linear.app/mcp '` give equal keys.
      - `…/mcp` vs `…/sse` give different keys, as do `?tenant=a` vs `?tenant=b`.
      - `'nope'` → `null`.
    - `connectorServerAddresses collects every server of every connector`: there are two connectors. One has two servers with URLs. The other has one server with no `url`. The result is a Set of exactly the two keys.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/connector-directory.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `lib/connector-directory.ts`.** Start with a header comment: where the wire shape comes from (`packages/connectors/src/directory-route.ts`, mirrored under invariant 2), that every field is untrusted, and that the normalizer never upgrades trust.
  - `searchDirectory`:
    1. Build `new URLSearchParams({ q: query })`, plus `cursor` when given.
    2. Call `fetch(`/admin/connectors/directory?${params}`, { credentials: 'include', signal })`.
    3. A 404 returns `directoryOffPage()`. Any other non-ok response throws `new Error(`search directory: ${res.status}`)`.
    4. Otherwise return `normalizeDirectoryPage(await res.json())`.
  - `normalizeDirectoryPage`: the rules are exactly those the Step 1 tests pin. The cursor regex mirrors `DIRECTORY_CURSOR_RE`.
  - `prefillFromDirectoryEntry`: build exactly the shape the tests pin. The id slug is:
    1. lowercase the title
    2. replace every run outside `[a-z0-9]` with one `-`
    3. trim `-` from both ends
    4. take the first 48 characters
    5. trim a trailing `-`
    6. use `connector` if empty
    7. append `` `-${crypto.randomUUID().slice(0, 8)}` ``

    Put a comment over the slug citing `packages/connectors/src/store.ts:28`.
  - `directoryHost`: `new URL(url).host`, or `''` if that throws.
  - `serverAddressKey`: `new URL(url.trim())` gives `` `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}` ``, or `null` if it throws.
  - `connectorServerAddresses`: every `capabilities.mcpServers[].url` that has a key.

- [ ] **Step 4: Add `fromDirectory` to `ConnectorPrefill`, and fix the comment that made the card's shape look right.**
  - JSDoc for `fromDirectory`: "Set only by `prefillFromDirectoryEntry`: the directory listing this editor was filled from. Its presence switches the editor's copy from a request's to the directory's. Opaque: never shown or edited, and not part of the connector, so the create body doesn't carry it."
  - In `connector-request-prefill.ts`, extend the remote-server bullet (lines 12-13) with: "It carries a key or sign-in only from the TOP-LEVEL `capabilities.credentials` whose `server` names that server. A server's own `allowedHosts` / `credentials` are listed in `leftOut`, not carried."

- [ ] **Step 5: Run the tests and confirm they pass, then type-check.** Run `pnpm --filter @ax/channel-web exec vitest run src/lib/__tests__/connector-directory.test.ts`, then `pnpm --filter @ax/channel-web exec tsc --build`. Expected: PASS, and no tsc errors.

- [ ] **Step 6: Commit.** Run `git add packages/channel-web/src/lib/connector-directory.ts packages/channel-web/src/lib/__tests__/directory-fixtures.ts packages/channel-web/src/lib/__tests__/connector-directory.test.ts packages/channel-web/src/lib/connectors.ts packages/channel-web/src/lib/connector-request-prefill.ts`, then `git commit -m "[TASK-1101] directory client, normalizer and listing prefill"`.

---

### Task 2: Directory-aware copy in the create editor [tier: mechanical]

**Files:**
- Modify: `packages/channel-web/src/components/settings/RemoteMcpConnectorForm.tsx`:
  - DialogDescription, around lines 765-770
  - the "How to use it" FieldDescription, around lines 799-801
  - the id-taken branch, around lines 662-665
- Test: `packages/channel-web/src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx`. Add a new `describe('directory prefill (TASK-1101)')` after the request-prefill tests (around lines 428-561). Reuse that file's `props()`, `writes`, `discovery`, `writeResponse` and `finishAdding()`.

**Interfaces:**
- Consumes: `prefillFromDirectoryEntry` (Task 1) and `directoryEntry` (Task 1 fixtures).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests.** Use `const key = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })`.
  - `says it was filled in from the directory and asks for the note to be rewritten`:
    1. Set `discovery = { hosts: ['mcp.linear.app'], auth: 'other' }`.
    2. Render `<ConnectorEditDialog {...props()} target="new" prefill={prefillFromDirectoryEntry(key)} />`.
    3. Expect the `editorDescription` and `usageNoteHelp` strings.
    4. Expect `getByLabelText('Name')` → `'Linear'`, `getByLabelText('Server URL')` → `'https://mcp.linear.app/mcp'`, and `getByLabelText('How to use it')` → `key.description`.
    5. Expect `queryByText(/Filled in from the request/)` and `queryByTestId('request-left-out')` to be null.
  - `a key listing opens with its header named and each agent bringing its own key`: after `await screen.findByLabelText('Each agent adds its own key')`:
    - that radio `toBeChecked()`;
    - `getByLabelText('Header name')` has value `'X-API-Key'` (the section auto-opens on `auth: 'other'`);
    - `queryByLabelText('Value')` is null.
  - `nothing is written until Add connector, and the create body is the ordinary one`:
    1. Expect `writes` to equal `[]`.
    2. Wait until the `Add connector` button is enabled, click it, then call `finishAdding()`.
    3. Find `create = writes.find((w) => w.url === '/admin/connectors')!`.
    4. `create.body` `toMatchObject` `{ connectorId: expect.stringMatching(/^linear-[0-9a-f]{8}$/), name: 'Linear', usageNote: key.description, keyMode: 'personal', capabilities: { mcpServers: [expect.objectContaining({ url: 'https://mcp.linear.app/mcp' })], credentials: [expect.objectContaining({ kind: 'api-key', headerName: 'X-API-Key' })] } }`.
    5. `Object.keys(create.body).sort()` equals `['capabilities', 'connectorId', 'keyMode', 'name', 'usageNote']`. This pins "no `fromDirectory` on the wire"; TASK-1102 changes this line on purpose.
  - `an id clash on a directory prefill gets the plain message`:
    1. Set `discovery = { hosts: ['mcp.linear.app'], auth: 'none' }` and `writeResponse` → 409 `{ error: 'connector-id-taken' }`.
    2. Use the prefill from `directoryEntry()` (no key).
    3. Click `Add connector`.
    4. Expect `await findByText('A connector with this id already exists.')`, and `queryByText(/Dismiss this request/)` to be null.
  - In the existing test `Set it up starts from the request and creates it shared, under the requested id`, add `expect(screen.getByText('Filled in from the request. Check each field before you add it.')).toBeInTheDocument()`. It pins the request branch the new condition sits beside.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/RemoteMcpConnectorForm.test.tsx`. Expected: the four new tests FAIL; the request-copy assertion passes.

- [ ] **Step 3: Implement.** Add `const fromDirectory = prefill?.fromDirectory !== undefined;`. Then:
  - When `prefill` is set, the description is `fromDirectory ? editorDescription : <existing request copy>`.
  - The "How to use it" FieldDescription is `fromDirectory ? usageNoteHelp : <existing sentence>`.
  - In the id-taken branch, `prefill` becomes `prefill && !fromDirectory`.

  Change nothing else (the save body stays as it is).

- [ ] **Step 4: Run the tests and confirm they pass, then type-check.** Run the same vitest command, then `pnpm --filter @ax/channel-web exec tsc --build`. Expected: PASS, and no errors.

- [ ] **Step 5: Commit.** Run `git add` on the two files, then `git commit -m "[TASK-1101] editor copy for a directory prefill"`.

---

### Task 3: Listing row and detail sheet, plus the design-doc stale line [tier: sensitive]

> **security-checklist:** this task renders untrusted registry text and the publisher-trust claims, which are the defense against lookalike listings.

**Files:**
- Create: `packages/channel-web/src/components/settings/DirectoryListingRow.tsx`
- Create: `packages/channel-web/src/components/settings/__tests__/DirectoryListingRow.test.tsx`
- Modify: `docs/plans/2026-11-09-mcp-directory-connectors-design.md:47-48`

**Interfaces:**
- Consumes:
  - `DirectoryEntry` and `directoryHost` (Task 1)
  - `SettingsDetailRow` from `./SettingsLayout`. It takes `label: string`, `detail`, `value` and `description`, and `children` as `(close) => ReactNode`. The row's accessible name is `Details for ${label}`.
  - `monthDay` from `@/lib/workspace-time`
- Produces: `export function DirectoryListingRow(props: { entry: DirectoryEntry; added: boolean; onSetUp: (entry: DirectoryEntry) => void }): JSX.Element`

- [ ] **Step 1: Write the failing tests.** Render the row standalone, then open the sheet with `fireEvent.click(screen.getByRole('button', { name: 'Details for Linear' }))` and `await screen.findByRole('dialog', { name: 'Linear' })`.
  - `a verified listing shows its domain with a shield, and the sheet says what was proved`:
    - `getByTestId('directory-proof-domain')` has text containing `Published by linear.app`.
    - The sheet shows `Published by`, `The publisher proved they control linear.app.`, `Connects to` with `mcp.linear.app`, and `` `Version 1.4.0 · updated ${monthDay('2026-11-03T12:00:00.000Z')}` ``. Compute the date with `monthDay` itself, so the test doesn't depend on locale.
    - The sheet shows the `trust` string.
  - `a community listing never claims a company or GitHub`. Use `publisherProof: 'account'` and `publisher: 'quickmcp-dev'`.
    - The row: `getByTestId('directory-proof-account')` has text `Community · quickmcp-dev`, and there is no `directory-proof-domain`.
    - The sheet shows `noteAccount`.
    - `document.body.textContent` matches neither `/GitHub/` nor `/proved they control/`.
  - `auth chips: API key, Sign-in, and nothing for a listing that declares no key`. Render three rows: key, signin and none. Each row's `within(...)` shows `API key`, `Sign-in` or neither. `queryByText(/no sign-in/i)` is null.
  - `How people connect says only what the listing says`. Covers the four strings `howKeyHeader` (with `X-API-Key`), `howKey`, `howSignin` and `howNone`.
  - `listing text with markup renders as literal text`. This is the card's HTML acceptance test. Use:
    - title `'<img src=x onerror=alert(1)>Evil'`
    - description `'<b>bold</b><script>alert(1)</script>'`
    - publisher `'<i>pub</i>'`
    - version `'<u>1</u>'`

    Expect:
    - `getByText('<b>bold</b><script>alert(1)</script>')` is in the document.
    - The row button's accessible name is `Details for <img src=x onerror=alert(1)>Evil`.
    - After opening the sheet, the dialog has that literal title as its name, and `document.querySelector('b, script, img, i, u')` is null.
    - `screen.queryAllByRole('link')` is empty.
  - `an added listing offers no Set it up`: the row shows `Added`. In the sheet, `getByRole('button', { name: 'Already in your connectors' })` is disabled, and `queryByRole('button', { name: 'Set it up' })` is null.
  - `Set it up closes the sheet and hands the listing up`: `onSetUp` is called once with the entry, and `await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())`.
  - `a deprecated listing says so and can still be set up`: the row shows `Deprecated`, and the sheet shows `deprecatedNote` and `Set it up`.
  - `a listing without a description says so in the sheet`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/DirectoryListingRow.test.tsx`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `DirectoryListingRow`.** Pass these props to `SettingsDetailRow`:
  - `label={entry.title}`
  - `detail`: the proof line, then the description in a `block truncate` span
  - `value`: a `flex items-center gap-1.5` span holding `Added`, `Deprecated` and the auth chip, in that order
  - `description`: the full description, or the fallback sentence
  - `children={(close) => …}`: a `dl` (the four rows, with each proof note under Published by), then `deprecatedNote` when deprecated, then the `trust` Alert, then the buttons. Set it up calls `close()` and then `onSetUp(entry)`.

  Every value renders as a React text child. Start the file with a header comment saying so: "registry text is untrusted: text nodes only, the URL shown only as its host, never a link". Invoke the `shadcn` skill first.

- [ ] **Step 4: Fix the stale design line.** In `docs/plans/2026-11-09-mcp-directory-connectors-design.md`, find the sentence `GitHub-namespace entries say "Community · GitHub user X" and, in detail, "It isn't checked against any company."` and replace it with:

  `Account-proven entries (every io.github… namespace, and any namespace that isn't a clean domain) say "Community · X" and, in detail, "It isn't checked against any company." The UI never says "GitHub": 'account' doesn't promise a GitHub account, and a subregistry or curated list can have other kinds.`

  Keep the line wrapping and backticks consistent with the rest of the paragraph. This is the rule-5 fix: that line is what made the card ask for "GitHub user X".

- [ ] **Step 5: Run the tests and confirm they pass, then type-check.** Run the same vitest command, then `pnpm --filter @ax/channel-web exec tsc --build`. Expected: PASS.

- [ ] **Step 6: Commit.** Run `git add` on the component, its test and the design doc, then `git commit -m "[TASK-1101] directory listing row and detail sheet"`.

---

### Task 4: The directory subview [tier: sensitive]

> **security-checklist:** this task renders untrusted listings (through Task 3) and reads every connector's full record. It also handles out-of-order async answers.

**Files:**
- Create: `packages/channel-web/src/components/settings/ConnectorDirectory.tsx`
- Create: `packages/channel-web/src/components/settings/__tests__/ConnectorDirectory.test.tsx`

**Interfaces:**
- Consumes:
  - `searchDirectory`, `serverAddressKey`, `connectorServerAddresses`, `DIRECTORY_QUERY_MAX`, `DirectoryEntry` and `DirectoryPage` (Task 1)
  - `DirectoryListingRow` (Task 3)
  - `getConnector` and `ConnectorSummary` from `@/lib/connectors`
  - `timeAgo` from `@/lib/workspace-time`
- Produces:
  ```ts
  export const SEARCH_DEBOUNCE_MS = 300;
  export function ConnectorDirectory(props: {
    connectors: readonly ConnectorSummary[];
    onBack: () => void;
    onSetUp: (entry: DirectoryEntry) => void;
    onNewConnector: () => void;
  }): JSX.Element;
  ```

**Behavior.** These are the rules the tests pin.
1. **On mount, and on Try again** (in the `loadFailed` or `notYet` state), call `searchDirectory('', { signal })`. The answer replaces the stored page. A failure shows `loadFailed`. An abort on unmount is ignored.
2. **Layout, top to bottom:** `back`, `heading`, `intro`. Then the state for the latest page:
   - Loading: two `Skeleton` lines.
   - `loadFailed`.
   - `off`, when `!enabled`.
   - `notYet`, when `syncedAt === null`.
   - Otherwise, the search UI:
     1. `Field` with `searchLabel`
     2. `InputGroup` with the `Search` icon and `InputGroupInput type="search"`, plus `maxLength={DIRECTORY_QUERY_MAX}` and `autoFocus`
     3. `stale` or `fresh`
     4. `verifiedOnly` when set
     5. the results area
     6. `localOnly`
3. **Searching.** Let `q = query.trim()`.
   - **Empty `q`:** abort any request in flight, clear results and the search error, and show no list.
   - **Non-empty `q`:**
     1. After `SEARCH_DEBOUNCE_MS`, abort the previous controller.
     2. Take `seq = ++latest.current`.
     3. Call `searchDirectory(q, { signal })`.
     4. Apply the answer only if `seq === latest.current`. Store `{ query: q, entries, nextCursor }`, and the page as the new freshness.
     5. A non-abort failure shows `searchFailed`, and its Try again re-runs `q`.
   - **Results area:** `searching` while `results?.query !== q`, then `noMatch` or `count` + rows + `more`.
4. **Show more** calls `searchDirectory(results.query, { cursor: results.nextCursor, signal })` under the same `latest` guard. It appends the entries whose `id` isn't shown yet and replaces `nextCursor`. A failure shows `moreFailed` and keeps the button.
5. **Added detection.** An effect keyed on `connectors.map((c) => `${c.id}@${c.updatedAt}`).join('|')` runs `Promise.allSettled(connectors.map((c) => getConnector(c.id, '/admin/connectors')))`. It stores `connectorServerAddresses` of the fulfilled results. Rejected ones are skipped (fail open). A row is added when `serverAddressKey(entry.url)` is in that set.
6. **Wiring.** `New connector` calls `onNewConnector`, `back` calls `onBack`, and a row's Set it up calls `onSetUp(entry)`.

- [ ] **Step 1: Write the failing tests.**
  - **Setup:**
    - `vi.spyOn(directoryLib, 'searchDirectory').mockImplementation(async (q) => q === '' ? directoryPage() : directoryPage({ entries: [linear, community] }))`. Here `linear = directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })`, and `community` is an `'account'` listing with `auth: 'none'`.
    - `vi.spyOn(connectorsLib, 'getConnector')`, resolving a connector with no servers.
    - A `renderDirectory(connectors = [])` helper that returns `{ onBack, onSetUp, onNewConnector }` mocks.
    - `afterEach(() => vi.restoreAllMocks())`.
    - Type with `fireEvent.change(screen.getByLabelText('Search the directory'), { target: { value } })`.
  - `opens on the search box and freshness only: no list until the admin types`:
    - `List updated 12 min ago` is shown.
    - `queryAllByRole('button', { name: /^Details for/ })` is empty.
    - `searchDirectory` has been called exactly once, with `''`.
    - `localOnly` is shown.
  - `typing shows each listing's title, publisher proof, description and auth chip`. It shows two rows, `2 servers match`, the proof test ids and the descriptions. `API key` appears only in Linear's row.
  - `debounces typing into one search for the newest text`. Change to `'n'`, `'no'`, `'notion'` back to back. After the row appears, the queries in `searchDirectory.mock.calls` equal `['', 'notion']`.
  - `a slow answer for an older query never replaces a newer one`. This is Review Focus 1.
    1. The `'linear'` call returns a deferred promise. Type `'linear'` and wait until it's called.
    2. Type `'notion'`, which resolves right away with a Notion entry. Wait for `Details for Notion`.
    3. Resolve the deferred promise with Linear.
    4. `queryByRole('button', { name: 'Details for Linear' })` stays null.
  - `clearing the box goes back to no list`.
  - `whitespace only never searches`. Type `'   '` and wait `SEARCH_DEBOUNCE_MS + 100` ms with real timers. `searchDirectory` was still called once.
  - `caps the query at the route's limit`. This is Review Focus 5: the input has attribute `maxLength` = `'200'`. jsdom doesn't enforce `maxLength`, so assert the attribute.
  - `a stale list says how old it is`. Use `directoryPage({ stale: true, syncedAt: <6 h ago> })`. `getByTestId('directory-stale')` has the exact `stale` text with `6 hr ago`, and `queryByText(/^List updated/)` is null.
  - `says when only verified publishers are shown`. With `verifiedOnly: true` the line is present; with `false` it is absent.
  - `never synced: explains, offers Try again and New connector, and has no search box`. Use `syncedAt: null`. The `notYet` title and description are shown and `queryByLabelText('Search the directory')` is null. Try again calls `searchDirectory('')` a second time. New connector calls `onNewConnector`.
  - `turned off: says so and offers New connector, with no search box`.
  - `no matches: names the query and offers New connector`. The search returns `[]`, the page shows `Nothing matches “zzz”`, and New connector calls `onNewConnector`.
  - `Show more appends the next page and disappears at the end`:
    1. The first page is 2 entries with `nextCursor: 'cur2'`, so the count reads `More than 2 servers match`.
    2. Click `Show more`. The last call is `('linear', expect.objectContaining({ cursor: 'cur2' }))`.
    3. There are now 3 rows, `3 servers match`, and no `Show more`.
  - `Show more skips a listing it already shows`. The second page repeats one id, and that row appears once.
  - `marks a listing whose address a connector already uses`. This is Review Focus 3.
    - Use `connectors = [summary]`, where `getConnector` resolves `mcpServers: [{ name: 'x', transport: 'http', url: 'https://MCP.linear.app:443/mcp/', allowedHosts: [], credentials: [] }]`.
    - Linear's row shows `Added`.
    - Its sheet shows the disabled `Already in your connectors`.
    - `getConnector` was called with `(summary.id, '/admin/connectors')`.
    - A second listing on the same host with path `/sse` is not marked.
  - `still offers Set it up when a connector's details won't load`. `getConnector` rejects, and `Set it up` is present in the sheet.
  - `could not load: says so and tries again`. The first `''` call rejects and shows `loadFailed`. Try again resolves, and the search box appears.
  - `could not search: says so and tries the same query again`.
  - `Back and Set it up go to the parent`. `back` calls `onBack`. Opening Linear's sheet and pressing Set it up calls `onSetUp(linear)`.
  - `headings step down from the page title`. `headingOutlineProblems(document.body, 2)` equals `[]` and `headingOutline()` equals `['h2: Find a connector']`. Import both from `@/test-utils/heading-outline`, as `ConnectorsTab.test.tsx` does.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/ConnectorDirectory.test.tsx`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `ConnectorDirectory`** to the Behavior rules, composing the primitives in Global Constraints. Copy the debounce shape (`setTimeout` + `AbortController` in a `useEffect`) from `RemoteMcpConnectorForm.tsx:400-423`, and the subview header shape (ghost back button, heading, intro, `InputGroup` search) from `components/workspace/AddConnector.tsx:304-332`. Use settings-pane typography (`text-sm`/`text-xs`), not the rail's pixel sizes. Invoke the `shadcn` skill first.

- [ ] **Step 4: Run the tests and confirm they pass, then type-check.** Run the same vitest command, then `pnpm --filter @ax/channel-web exec tsc --build`. Expected: PASS.

- [ ] **Step 5: Commit.** Run `git add` on the component and its test, then `git commit -m "[TASK-1101] directory subview: search, states, show more, already-added"`.

---

### Task 5: Wire it into Admin › Connectors [tier: integration]

**Files:**
- Modify: `packages/channel-web/src/components/settings/ConnectorsTab.tsx`:
  - the header comment
  - the mount effect (lines 174-197)
  - `SettingsActions` (line 267)
  - the body, and `onSaved` (lines 375-379)
- Modify: `packages/channel-web/src/components/settings/__tests__/ConnectorsTab.test.tsx`
- Modify: `packages/channel-web/src/components/workspace/__tests__/AddConnector.test.tsx`
- Create: `.changeset/connector-directory-ui.md`

**Interfaces:**
- Consumes:
  - `searchDirectory`, `prefillFromDirectoryEntry` and `DirectoryEntry` (Task 1)
  - `ConnectorDirectory` (Task 4)
  - the existing `setPrefill` / `setEditing` / `ConnectorEditDialog`
- Produces: no new exports.

**Behavior:**
- Add state `view: 'list' | 'directory'` (default `'list'`) and `directoryOffered: boolean | null` (default `null`).
- The mount effect also runs `searchDirectory('')`, under the same `cancelled` guard. It sets `directoryOffered` to `page.enabled`, or to `true` on rejection (fail open).
- In list view, `SettingsActions` renders `{directoryOffered && <Button variant="outline" onClick={() => setView('directory')}>Find in directory</Button>}` before New connector.
- In directory view, the tab renders **only** `<ConnectorDirectory connectors={connectors ?? []} … />` (no `SettingsActions`, error Alert, request shelf or tiles), with:
  - `onBack` → `setView('list')`
  - `onSetUp(e)` → `setPrefill(prefillFromDirectoryEntry(e)); setEditing('new')`
  - `onNewConnector` → `setPrefill(null); setEditing('new')`
- The editor and the confirm dialogs render in both views.
- `onSaved` adds `setView('list')`.
- Add one paragraph to the header comment: what the directory subview is, that its listing text is untrusted, and that the list view still reads no full records.

- [ ] **Step 1: Write the failing tests.**
  - In `ConnectorsTab.test.tsx`:
    - Import `* as directoryLib from '@/lib/connector-directory'` and `* as oauthLib from '@/lib/connectors-oauth'`.
    - In the shared `beforeEach`, add `vi.spyOn(directoryLib, 'searchDirectory').mockResolvedValue(directoryPage())`.
    - Add a `describe('Find in directory (TASK-1101)')` with:
      - `offers Find in directory beside New connector`: `findByRole('button', { name: 'Find in directory' })`, and New connector is present.
      - `hides it when the directory is turned off`:
        1. Mock `directoryPage({ enabled: false, syncedAt: null })`.
        2. Wait for `My Notion`, then for `searchDirectory` to have been called with `''`.
        3. `queryByRole('button', { name: 'Find in directory' })` is null.
      - `still offers it when the check fails`: a rejection, and the button is found.
      - `opens the directory in place of the list, and Back returns`:
        1. Click the button. `findByRole('heading', { name: 'Find a connector' })`.
        2. In directory view: `queryByTestId('connector-tile-my-notion')` is null, and no button is named `New connector` (the synced state has none).
        3. Click `Back to connectors`. The tile is back.
      - `Set it up from a listing opens the create editor prefilled, and nothing is saved before Add`:
        1. `searchDirectory` answers `'linear'` with `[directoryEntry({ auth: 'key', keyHeader: 'X-API-Key' })]`.
        2. Spy `oauthLib.discoverOAuthHosts` → `{ hosts: ['mcp.linear.app'], auth: 'other' }`.
        3. `const create = vi.spyOn(connectorsLib, 'createConnector')`.
        4. Open the directory, type `linear`, click `Details for Linear`, then `Set it up`.
        5. `const dialog = await screen.findByRole('dialog', { name: 'Add connector' })`.
        6. In the dialog: the `editorDescription` text, `Name` = `Linear`, `Server URL` = `https://mcp.linear.app/mcp`, and `How to use it` = the description.
        7. `create` was not called.
      - `cancelling the editor returns to the directory with the search intact`: click `Cancel` in the dialog. The dialog is gone, `getByLabelText('Search the directory')` has value `linear`, and `Details for Linear` is present.
      - `saving from the directory returns to the connectors list`. Use `directoryEntry()` (`auth: 'none'`, so `onSaved` fires straight after create).
        1. Discovery → `{ hosts: ['mcp.linear.app'], auth: 'oauth', clientRegistration: { cimd: false, dcr: true } }`.
        2. `create` resolves a `Connector` fixture.
        3. Wait for `Add connector` to be enabled, then click it.
        4. `await screen.findByRole('button', { name: 'Find in directory' })`, and `queryByRole('heading', { name: 'Find a connector' })` is null.
        5. `listConnectors` was called at least twice.
    - The existing tests `reads no credential presence and no full connector records` and `opens at h2 and steps down one level to the Awaiting approval shelf` must stay green unchanged. They guard the list view.
  - In `AddConnector.test.tsx`, in `describe('what it shows')`, add `never offers the directory, even to an admin`: `renderAdd('admin'); await ready();`, then `queryByRole('button', { name: /find in directory/i })` and `queryByText('Find a connector')` are both null. Also note in the PR that `AdminShell.test.tsx` `never opens Connectors for someone who is not an admin, and never asks /admin/connectors` already proves a non-admin never reaches the directory route.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @ax/channel-web exec vitest run src/components/settings/__tests__/ConnectorsTab.test.tsx src/components/workspace/__tests__/AddConnector.test.tsx`. Expected: the new ConnectorsTab tests FAIL. The AddConnector test passes from the start, because it is a regression pin.

- [ ] **Step 3: Implement** the Behavior above in `ConnectorsTab.tsx`.

- [ ] **Step 4: Add the changeset.** Create `.changeset/connector-directory-ui.md` with frontmatter `'@ax/channel-web': minor`. Body:

  `Admins can now find connectors in the MCP directory from Admin > Connectors: search, check who published a listing, and open the new-connector editor already filled in. Nothing is saved until you add it, and the description is yours to rewrite, because every agent that uses the connector reads it.`

- [ ] **Step 5: Run the tests and confirm they pass, then type-check.** Run `pnpm --filter @ax/channel-web test`, then `pnpm --filter @ax/channel-web exec tsc --build`. Expected: all channel-web tests pass, and tsc has no errors.

- [ ] **Step 6: Commit.** Run `git add` on the three files and the changeset, then `git commit -m "[TASK-1101] Find in directory in Admin › Connectors"`.

---

## Finish (yolo-ship's verification and review phases)

- **Gates:**
  1. `pnpm build`
  2. `pnpm lint`
  3. `pnpm --filter @ax/channel-web test`
  4. `pnpm --filter @ax/channel-web build` (`tsc --build` + vite)

  Only channel-web and one doc change. Per CLAUDE.md, a repo-wide verdict needs `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`.
- **Security checklist** (Tasks 1, 3 and 4 are flagged). Run the `security-checklist` skill and put its note in the PR. The items to answer:
  1. Registry fields are rendered only as text: no `dangerouslySetInnerHTML`, no `href`/`src`, and the URL shown only as its punycode host. Tests: Task 3 markup test.
  2. The verified shield appears only for an exact `'domain'` value, never upgraded client-side. Test: Task 1, `never upgrades trust`.
  3. The publisher's description reaches the model only after the admin saves it in an editor that says who wrote it and asks for a rewrite. Nothing is written before Add, and Save is the unchanged `POST /admin/connectors` validation. Tests: Task 2.
  4. A prefilled URL goes through the same discovery and connect-time SSRF guards as a typed one.
  5. The browser makes no new egress: only same-origin admin routes.
  6. There is no new dependency.
- **Boundary review: not needed.** No hook, IPC action or route changes. The PR says so, lists the "departs from the card" items above, and names the TASK-1102 seam: add `fromDirectory` to `input` in `RemoteMcpConnectorForm.tsx` `submit()`, and update the create-body-keys assertion from Task 2.
- **Optional browser check.** The SPA-only kind loop (`make dev-fast`, always with `--context kind-ax-next-dev`) works, because this change is dist-web only.
