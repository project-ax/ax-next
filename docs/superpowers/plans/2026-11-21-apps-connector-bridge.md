# Apps Connector Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved external apps platform calls connector tools through AX, as the linked agent ("builder's access") or as the viewing person after they approve ("viewer's access"), using sign-ins AX already holds. No credential, header or connector URL ever leaves AX; only a successful tool result does.

**Architecture:** `@ax/mcp-client` factors the access checks of `connectors:call-tool` into one shared core and adds the sibling service hook `connectors:call-tool-result`, which returns the reply's content blocks. A new plugin, `@ax/apps-bridge`, owns app links, grants and viewer approvals (three Postgres tables). It serves the external contract on a dedicated `node:http` listener (default port 9092, never on the Ingress) that accepts only an operator-configured OIDC caller, and it serves the cookie-authenticated settings and approve routes on the public `@ax/http-server`. A new zod-only package, `@ax/apps-bridge-contract`, holds the wire shapes. channel-web adds an Apps section to agent settings and a standalone approve page.

**Tech Stack:** TypeScript ESM. Kysely 0.28.17 on Postgres (tests: `@testcontainers/postgresql` 11.14.0, image `postgres:16-alpine`). zod 3. `jose` 6.2.8 (exact; already the only version in `pnpm-lock.yaml`, zero dependencies). `@modelcontextprotocol/sdk` 1.32.1 (unchanged). `node:http`, `node:crypto`. React 19 + shadcn (channel-web). vitest 5. Helm.

**Spec:** `docs/superpowers/specs/2026-11-21-apps-connector-bridge-design.md` (approved 2026-11-21). Context only: `/Users/vpulim/dev/ai/canopy-apps/docs/superpowers/specs/2026-11-21-canopy-apps-design.md` §4a. Decisions shard: `.claude/memory/decisions/2026-11-21-APPSBRIDGE-20261121.md`.

**Shipping shape:** one branch, one PR, one squash merge. Each task is one commit, and every commit builds and passes its package's tests. Nothing is reachable half-built at merge (invariant 3; the sign-ins epic precedent #978).

---

## Plan vs. reality

Where the code contradicts the spec or the spec is silent, the plan follows the code and says so here. No approved design decision is changed. Task 14 writes these into the spec.

1. **"A listener the operator can keep off the public ingress": `@ax/http-server` can't provide one.** It runs one listener and can't be loaded twice (`duplicate-plugin`), and the chart's Ingress maps all of `/` on 9090 to it (`templates/host/ingress.yaml:30-46`) with no way to exclude a prefix. → `@ax/apps-bridge` owns a dedicated `node:http` listener, as `@ax/attachments`' content origin does (`packages/attachments/src/artifacts/content-origin.ts`). The cookie routes (Apps section, approve page) stay on 9090.
2. **The refusal table has no code for a malformed request or for AX's own transient faults, and none for a `deny` verdict.** → `invalid_request` (400) and `unavailable` (503) join the closed set. `tool_not_allowed` also covers a tool the agent's policy denies.
3. **A viewer approval stores only the agent.** A grant widened later (a write tool added) would ride the old consent. → Each approval stores a snapshot of the grant's tool keys. A tool outside the snapshot answers `viewer_approval_required`.
4. **`approveUrl` with a query string doesn't survive sign-in.** `LoginPage.tsx:77` passes only `pathname`, and `signInWithGoogle` (`lib/auth.ts:90-91`) keeps only share-page paths. → The approve link is path-only, `/apps/approve/<platformId>/<appId>/<connectorId>`, and its parser joins the callback allowlist.
5. **Connector tools default to Ask first.** `implicitMcpCeiling` (`packages/tool-policy/src/verdicts.ts:207-216`) caps a connector tool with no admin default at `hold`. So a granted tool is refused (`approval_required`) until an admin's default and the agent's own choice are both Allow. → The Apps section shows each tool's verdict and lets only Allow tools be granted.
6. **"The presets that serve HTTP" are k8s and memory, and memory is the production host.** `serve` boots `createMemoryPlugins`, which reuses `createK8sPlugins` (`packages/cli/src/commands/serve.ts:28-31`), so one push in `presets/k8s/src/index.ts` reaches both. The invariant-3 canary is `presets/memory/src/__tests__/canary.test.ts` (`.claude/memory/decisions/2026-11-13-TASK-1093.md:26`). The CLI preset has no Postgres and no http-server, so the bridge isn't loaded there.
7. **"Who can link": the spec names `agents:can-manage-connectors`.** That hook says yes to any workspace admin when `actor.isAdmin` is true. Lending an agent's sign-in is the agent owners' call (TASK-813; channel-slack asks as a non-admin too). → The bridge always asks it with `isAdmin: false`: a personal agent's owner, or an admin of a team agent's team.
8. **Connector identity is `(row owner, id)`** (`packages/connectors/src/tool-namespace.ts:12-17`). But every connector is shared since SIGNINS-9, and credential reads require a sole live id (`packages/connectors/src/scope.ts:39-46`). So a connector id names one record for builder and viewer alike, and its tool keys (`mcp.<namespace>.<tool>`) are the same for both.

## Builder calls made in this plan

| Spec "left to the builder" / dispatch | Decision | Why (one line) |
|---|---|---|
| Listener placement | Dedicated `node:http` listener in `@ax/apps-bridge`, default port 9092, bound on `AX_HTTP_HOST`. Own container port and Service port. Never on the Ingress. A NetworkPolicy rule admits the operator's `appsBridge.allowFrom` peers | Plan vs. reality 1. Authenticating from headers before reading the body is only possible on our own listener |
| OIDC config shape | Env `AX_APPS_BRIDGE_PLATFORM_ID`, `_PORT`, `_CALLER_{ISSUER,JWKS_URL,AUDIENCE,SUBJECT}`, `_VIEWER_{ISSUER,JWKS_URL,AUDIENCE,MAX_AGE_SECONDS}`. Chart `appsBridge.*`, `host.ports.appsBridge`, `host.appsBridgeServicePort`. Off unless the platform id is set | Same literal-env + chart-stamp pattern as the content origin. The env-shape gate needs every read stamped |
| Content size cap | The transport's per-reply cap, `CALL_LIMITS.maxResponseBytes` (2 MiB). Over it the answer is `unknown/interrupted`, as today. No second cap | The spec says the cap is inherited from the connector call limits. Content is a subset of the reply |
| Table layout | `apps_bridge_v1_links`, `apps_bridge_v1_grants`, `apps_bridge_v1_viewer_approvals`, with cascading FKs inside the plugin (Task 4 DDL) | Postgres only, like every plugin that owns tables. No cross-plugin FK |
| Wire contract location | New zod-only package `@ax/apps-bridge-contract` (`wire.ts` external v1, `settings.ts` internal UI shapes) | `@ax/routines-contract` is the precedent for one schema shared by a plugin and the browser. `@ax/ipc-protocol` is the runner↔host boundary and is Node-only at its entry |
| JWT library | `jose` 6.2.8, exact, direct dependency of `@ax/apps-bridge` | Already resolved in the lockfile, zero deps, no install scripts. No AX code verifies a JWKS-signed JWT today, and a hand-rolled verifier is how alg confusion ships |
| Viewer's agents | Only the viewer's personal agents (`ownerType: 'user'`, `ownerId` = viewer) | "One of that person's own agents". A team agent's sign-in is the team's account, not the viewer's |
| Rate limits | 120 calls/min per app, 600/min per platform, 32 calls in flight per platform. In memory | The host is pinned to one replica (`ax-next.validateHostReplicas`). In-flight bounds memory: each call can hold a 2 MiB reply |
| App id grammar | A DNS label: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` | The platform's apps are subdomains (`expenses.canopyapps.ai`) |

## Global Constraints

- **External base path:** `/api/apps-bridge/v1`. Routes: `POST /call`, `GET /apps/:appId/grants`. Nothing else is served on the bridge listener (unknown path 404, wrong method 405, no CORS headers).
- **Bridge listener:** default port **9092**, host = `AX_HTTP_HOST`. `headersTimeout` 10 s, `requestTimeout` 90 s, `keepAliveTimeout` 5 s. `POST /call` body cap **1 MiB** (1,048,576 bytes), read only after the caller is authenticated. Bearer token and `viewerAssertion` each at most **8192** characters.
- **Caller authentication (every request):** `Authorization: Bearer <OIDC ID token>`, verified against `issuer`, `jwksUrl`, `audience` and an exact `subject`. Maps to one `platformId`. No other auth is accepted.
- **Viewer assertion (viewer mode only):** verified against `issuer`, `jwksUrl`, `audience` and a max age (default **600 s**, allowed 30–3600). Its `email` claim maps to an AX user through `auth:find-user-by-email`.
- **JWT rules:** algorithms `RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, ES512, EdDSA` only (never `HS*`, never `none`). Clock tolerance **30 s**. `exp` required on both. Viewer needs `iat` and `email` too, and an `email_verified` claim, when present, must be `true`. `jwksUrl` must be `https:`, or `http:` on `127.0.0.1` / `localhost` / `[::1]`, with no credentials.
- **Refusal codes (closed):** body `{ "code": <code> }`, plus `approveUrl` for `viewer_approval_required` only.

  | code | status | | code | status |
  |---|---|---|---|---|
  | `invalid_request` | 400 | | `viewer_invalid` | 403 |
  | `unauthenticated` | 401 | | `viewer_approval_required` | 403 |
  | `app_not_linked` | 404 | | `agent_unavailable` | 403 |
  | `not_granted` | 403 | | `rate_limited` | 429 (`Retry-After: 60`, or `1` for the in-flight cap) |
  | `tool_not_allowed` | 403 | | `unavailable` | 503 (`Retry-After: 5`) |
  | `approval_required` | 403 | | | |

- **Outcomes (200):** `{ outcome: 'succeeded', content: [...] }`, `{ outcome: 'failed', reason }` with reason in `invalid-call | not-connected | needs-auth | unavailable | unreachable | rejected | tool-error`, `{ outcome: 'unknown', reason }` with reason in `timeout | interrupted`. No upstream text except `content` on success. A `tool-error` carries no content.
- **Call limits (inherited, unchanged):** `CALL_LIMITS` in `packages/mcp-client/src/connector-inventory/call-server-tool.ts`: 10 s connect, 30 s per request, **45 s** budget from handler entry, **2 MiB** per reply. `MIN_SEND_BUDGET_MS` 15 s. One `tools/call`, never retried.
- **Policy:** before each call, `tool-policy:evaluate` for `(agent, toolKey)`. Only `allow` proceeds. `hold` → `approval_required`. `deny` → `tool_not_allowed`. A throw or unreadable answer → `unavailable`.
- **Rate limits:** 120/min per `(platform, app)`, 600/min per platform, 32 in flight per platform, sliding 60 s window, at most 10,000 tracked keys.
- **Ids:** platform and app ids `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. Connector id `^[a-z0-9][a-z0-9_-]{0,127}$`. Tool name `^[\x21-\x7e]{1,128}$`. Tool key `^mcp\.(c[0-9a-f]{10})\.([\x21-\x7e]{1,128})$` (the same literal as mcp-client's `CONNECTOR_TOOL_KEY_RE`). At most **200** tool keys per grant, and tool names unique within a grant.
- **Logging:** one line per external request: `apps_bridge_call` (or `apps_bridge_grants`) with `platformId`, `appId`, `connectorId`, `tool`, `mode`, `outcome` (a refusal code, `succeeded`, `failed` or `unknown`) and `reason`. Request fields are logged only after they pass their grammar. Never logged: input, content, tokens, the assertion, the email, headers, URLs.
- **Approve link:** `${publicOrigin}/apps/approve/<platformId>/<appId>/<connectorId>`, where `publicOrigin` is `presetPublicOrigin(config)`.
- **Approve-page copy (fixed by the spec):** headline "*{appId}* wants to use {connector name} as you". The agent choice is auto-picked when only one of the person's agents has the connector.
- **Invariants:** I1 no backend vocabulary in hook payloads. I2 hooks only: no cross-plugin runtime imports (type-only imports and local structural views are fine). I3 nothing half-wired at merge. I4 `@ax/apps-bridge` alone owns links, grants and approvals. I5 `input`, `viewerAssertion`, `content` and every platform-supplied string are untrusted at every hop. I6 shadcn primitives and semantic tokens only.
- **Skills:** every task tagged `security-checklist` invokes that skill before its commit. Tasks 12 and 13 invoke the `shadcn` skill first, and add a missing primitive only with `pnpm dlx shadcn@latest add <name> -c packages/channel-web`, run from the repo root.
- **Boundary review:** in the PR description for `connectors:call-tool-result` (Task 15). `@ax/apps-bridge` registers no service hook.
- **Test commands:**
  - First run in the worktree: `pnpm install --frozen-lockfile && pnpm build`. After a task adds a package or dependency: `pnpm install`, then prove it with `pnpm install --frozen-lockfile`.
  - Package tests: `pnpm --filter @ax/<pkg> test <path>`. The filter goes before the script, with no `--`.
  - Type-check: `pnpm --filter @ax/<pkg> build`. vitest tolerates type errors, and most packages' tsc excludes their tests (channel-web is the exception: its tsc checks `src/**/__tests__`).
  - Container tests need an explicit `DOCKER_HOST` (CLAUDE.md, "Docker-backed tests").
  - Chart tests: `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test`, with helm on PATH.
  - Full gate before the PR: `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`. `pnpm -r run test` alone bails at the first red package and silently skips the rest.
- **Escape text:** write test strings that hold control, bidi or non-ASCII code points as `\uXXXX` escapes, and verify them with the code-point scan in `.claude/memory/mistakes/2026-10-20-TASK-904.md` (the Write/Edit tools turn escapes into raw characters).

## Review Focus

1. **Token time edges.** A caller token 29 s past `exp` passes and one 31 s past fails. A viewer assertion 629 s old passes and one 631 s old fails (600 s max age plus 30 s tolerance). → Task 5, `verify-token.test.ts`.
2. **Two managers link the same app id at the same moment.** Exactly one link is made, and the other person gets `409 app-already-linked`, never a second link or a 500. → Task 4 (store race) and Task 8 (route).
3. **A builder widens a viewer-mode grant after viewers approved.** The new tool answers `viewer_approval_required` for them while tools they approved keep working, and a tool removed from the grant answers `tool_not_allowed`. → Task 6, `bridge-call.test.ts`.
4. **The platform hangs up mid-call.** The in-flight slot is still released and the request still logs exactly one line, so a flaky client can't exhaust the 32 slots. → Task 7, `listener.test.ts`.
5. **Hostile JSON.** `__proto__` and `constructor` keys in `input` reach the connector byte-faithfully and touch no prototype, and a body over 1 MiB is refused before parsing. → Task 6 and Task 7.

---

### Task 1: mcp-client — factor the access checks out of `connectors:call-tool`, behavior unchanged [tier: sensitive]

`security-checklist`: required (refactors a credentialed host path).

**Files:**
- Create: `packages/mcp-client/src/connector-inventory/connector-call.ts`
- Modify: `packages/mcp-client/src/connector-inventory/call-tool.ts` (becomes a thin binding; keep its header comment, which still describes the checks)
- Modify: `packages/mcp-client/src/connector-inventory/call-server-tool.ts`
- Regression net, not edited: `packages/mcp-client/src/__tests__/connector-call-tool.test.ts`, `packages/mcp-client/src/__tests__/connector-call-server-tool.test.ts`

**Interfaces:**
- Produces (`connector-call.ts`):
  ```ts
  export const MIN_SEND_BUDGET_MS = 15_000; // moved here; call-tool.ts re-exports it
  export interface ConnectorCallBus {
    call<I, O>(hookName: string, ctx: AgentContext, input: I): Promise<O>;
    hasService(hookName: string): boolean;
  }
  export interface ReadySend {
    url: string; headers: Record<string, string>; tool: string;
    input: Record<string, unknown>; limits: { budgetMs: number };
  }
  export type ConnectorCallFailure =
    | { outcome: 'failed'; reason: ConnectorCallFailedReason }
    | { outcome: 'unknown'; reason: ConnectorCallUnknownReason };
  export function createConnectorCallHandler<S extends { outcome: 'succeeded' }>(opts: {
    bus: ConnectorCallBus;
    now?: () => number;
    logEvent: 'connector_call_tool' | 'connector_call_tool_result';
    send: (s: ReadySend) => Promise<S | ConnectorCallFailure>;
  }): (callerCtx: AgentContext, rawInput: unknown) => Promise<S | ConnectorCallFailure>;
  ```
- Produces (`call-server-tool.ts`):
  ```ts
  export type ServerCallFailed = { outcome: 'failed'; reason: 'needs-auth' | 'unreachable' | 'rejected' | 'tool-error' };
  export type ServerCallUnknown = { outcome: 'unknown'; reason: 'timeout' | 'interrupted' };
  export type ServerCallOutcome = { outcome: 'succeeded' } | ServerCallFailed | ServerCallUnknown; // same union as today
  export function sendOneCall<S>(
    opts: CallServerToolOptions,
    onReply: (reply: { isError?: boolean } & Record<string, unknown>) => S | ServerCallFailed | ServerCallUnknown,
  ): Promise<S | ServerCallFailed | ServerCallUnknown>;
  export function callServerTool(opts: CallServerToolOptions): Promise<ServerCallOutcome>; // unchanged contract
  ```
- Unchanged exports the tests import: `createCallTool`, `CallToolDeps`, `MIN_SEND_BUDGET_MS` (from `call-tool.js`); `callServerTool`, `CALL_LIMITS`, `CallServerToolOptions`, `ServerCallOutcome` (from `call-server-tool.js`).

- [ ] **Step 1: Record the baseline**

Run: `pnpm --filter @ax/mcp-client test src/__tests__/connector-call-tool.test.ts src/__tests__/connector-call-server-tool.test.ts`
Expected: PASS. Note the test count.

- [ ] **Step 2: Move steps 1–9 and the handler envelope into `createConnectorCallHandler`**

Move the body of `call-tool.ts` (`attempt()` steps 1–9, the deadline, the `state`, the catch-all, `loggableCode`, and the one log line) into `connector-call.ts` verbatim, comments included. Only two things become parameters: the log event name, and the final send. Step 9 still computes `left` and calls `opts.send({ url, headers: auth.headers, tool, input, limits: { budgetMs: left } })`. That is the exact object `callServer` receives today, so `toEqual` assertions on `sent` keep passing. `createCallTool(deps)` becomes `createConnectorCallHandler({ bus: deps.bus, now: deps.now, logEvent: 'connector_call_tool', send: (s) => (deps.callServer ?? callServerTool)(…the same five fields…) })`.

- [ ] **Step 3: Extract `sendOneCall` in the transport**

`sendOneCall` keeps everything `callServerTool` does today: guarded fetch, budget signal, connect, the pre-send `budget.aborted` check, `client.request` with the same `CallResultView`, oversize-first classification, and `close()` in `finally`. The success line becomes `return onReply(reply)`. `callServerTool(opts)` is `sendOneCall(opts, (r) => r.isError === true ? { outcome: 'failed', reason: 'tool-error' } : { outcome: 'succeeded' })`. `CallResultView` is unchanged, so the call still never validates content blocks.

- [ ] **Step 4: Prove nothing moved**

Run: `pnpm --filter @ax/mcp-client test src/__tests__/connector-call-tool.test.ts src/__tests__/connector-call-server-tool.test.ts`
Expected: PASS, the same count as Step 1.
Run: `git diff --exit-code -- packages/mcp-client/src/__tests__/connector-call-tool.test.ts packages/mcp-client/src/__tests__/connector-call-server-tool.test.ts`
Expected: exit 0 (both test files untouched).

- [ ] **Step 5: Type-check and the whole package**

Run: `pnpm --filter @ax/mcp-client build && pnpm --filter @ax/mcp-client test`
Expected: tsc clean, all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-client/src/connector-inventory/
git commit -m "refactor(mcp-client): share connectors:call-tool's access checks and one-shot transport"
```

---

### Task 2: mcp-client — `connectors:call-tool-result` [tier: sensitive]

`security-checklist`: required (credentialed host path; untrusted server output now returned to a caller).

**Files:**
- Create: `packages/mcp-client/src/connector-inventory/call-tool-result.ts`
- Modify: `packages/mcp-client/src/connector-inventory/call-server-tool.ts` (add `callServerToolWithContent`)
- Modify: `packages/mcp-client/src/connector-inventory/types.ts` (new types, schemas and the hook's boundary-review comment block, beside `connectors:call-tool`'s)
- Modify: `packages/mcp-client/src/plugin.ts` (register the hook, add to `registers`, add the test seam, add item 4 to the header comment)
- Modify: `packages/mcp-client/SECURITY.md`
- Test (create): `packages/mcp-client/src/__tests__/connector-call-tool-result.test.ts`
- Test (additions only): `connector-call-server-tool.test.ts` (a new `describe` at the end that reuses its `fakeMcpServer`), `connector-inventory-wiring.test.ts`, `return-schemas.test.ts`, and the `registers` pins in `plugin.test.ts` and `connector-inventory-store.test.ts` (~line 351)

**Interfaces:**
- Consumes: Task 1's `createConnectorCallHandler`, `ReadySend`, `sendOneCall`, `ConnectorCallBus`.
- Produces (`types.ts`):
  ```ts
  export type ConnectorResultContentBlock = { type: string } & Record<string, unknown>;
  export type ConnectorCallToolResultOutput =
    | { outcome: 'succeeded'; content: ConnectorResultContentBlock[] }
    | { outcome: 'failed'; reason: ConnectorCallFailedReason }
    | { outcome: 'unknown'; reason: ConnectorCallUnknownReason };
  export const ConnectorResultContentBlockSchema = z.object({ type: z.string().min(1).max(64) }).passthrough();
  export const ConnectorCallToolResultOutputSchema: z.ZodType<ConnectorCallToolResultOutput>;
  // succeeded: { outcome, content: z.array(ConnectorResultContentBlockSchema) }.strict(); failed/unknown arms as ConnectorCallToolOutputSchema's
  ```
- Produces (`call-server-tool.ts`):
  ```ts
  export type ServerCallResultOutcome =
    | { outcome: 'succeeded'; content: ConnectorResultContentBlock[] } | ServerCallFailed | ServerCallUnknown;
  export function callServerToolWithContent(opts: CallServerToolOptions): Promise<ServerCallResultOutcome>;
  ```
- Produces (`call-tool-result.ts`):
  ```ts
  export interface CallToolResultDeps {
    bus: ConnectorCallBus;
    callServerWithContent?: (opts: CallServerToolOptions) => Promise<ServerCallResultOutcome>;
    now?: () => number;
  }
  export function createCallToolResult(deps: CallToolResultDeps):
    (callerCtx: AgentContext, rawInput: unknown) => Promise<ConnectorCallToolResultOutput>;
  ```
- Produces (the hook, consumed by Task 6): `connectors:call-tool-result`, input `{ userId, agentId, toolKey, input }` (validated by the existing `ConnectorCallToolInputSchema`), output `ConnectorCallToolResultOutput`. Registered only when `connectorToolInventory: true`, with `{ returns: ConnectorCallToolResultOutputSchema }` and the bus's default timeout. The caller's ctx must name the same `userId` and `agentId`.
- Produces (plugin option): `connectorCallServerToolWithContent?: (opts: CallServerToolOptions) => Promise<ServerCallResultOutcome>` (test seam, consumed by Task 11).

- [ ] **Step 1: Write the failing transport tests** (new `describe('callServerToolWithContent')` at the end of `connector-call-server-tool.test.ts`; existing cases untouched)

```ts
it('returns the reply content blocks as the server sent them', async () => {
  // tools/call answers { content: [{type:'text',text:'ENG-1 open'},{type:'image',data:'aGk=',mimeType:'image/png'}], structuredContent:{x:1} }
  expect(await callServerToolWithContent(opts)).toEqual({ outcome: 'succeeded', content: [
    { type: 'text', text: 'ENG-1 open' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' } ] });
});
it('a reply with no content is success with no blocks');            // → { outcome: 'succeeded', content: [] }
it('content that is not an array of typed blocks is unknown');      // 'oops', [{text:'x'}], a 65-char type → each { outcome: 'unknown', reason: 'interrupted' }
it('isError drops the content: tool-error');                         // toEqual({ outcome: 'failed', reason: 'tool-error' }) — no content key
it('an oversize reply is unknown, never truncated content');         // limits.maxResponseBytes small → { outcome: 'unknown', reason: 'interrupted' }
it('sends one tools/call and never retries');                        // a 500 → unknown; tools/call POST count === 1
```

- [ ] **Step 2: Write the failing hook tests** in `connector-call-tool-result.test.ts`. Copy the `linear()`, `effective()`, `EFFECTIVE`, `AGENT_ROW`, `CREDENTIALS` fixtures and the fake bus from `connector-call-tool.test.ts`.

```ts
it('succeeds with the content the server returned, after the same reads');
// hooks() === ['agents:resolve','connectors:list-effective','connectors:resolve','credentials:get'];
// sent[0] toEqual the same { url, headers, tool, input, limits } call-tool sends; answer content toEqual the seam's
it.each(SHARED_REFUSALS)('refuses exactly where connectors:call-tool refuses: %s');
// run each case through BOTH createCallTool and createCallToolResult; outcomes equal; sent.length === 0 for both.
// Cases at least: ctx user/agent mismatch → invalid-call; ownerless user → not-connected; agents:resolve forbidden →
// not-connected; namespace outside the effective set → not-connected; host not in allowedHosts → unreachable;
// credential absent → needs-auth; under 15 s of budget left → unavailable
it('logs connector_call_tool_result with codes only');               // JSON of all log lines contains no content text, input value or header
it('a throw after the send is unknown, before it is unavailable');
```

- [ ] **Step 3: Write the failing wiring and schema tests**

In `connector-inventory-wiring.test.ts`, add `it('connectors:call-tool-result is registered with its returns schema')`. A seam answering `{ outcome: 'succeeded', content: [{ type: 'text', text: 'x' }], extra: 1 }` makes the bus throw `invalid-return`. So does `{ outcome: 'failed', reason: 'rejected', content: [] }`. A well-formed answer passes through `toEqual`. In `return-schemas.test.ts`, the schema keeps extra block keys, rejects a block with no `type`, and rejects `{ outcome: 'unknown', reason: 'tool-error' }`. In `plugin.test.ts` and `connector-inventory-store.test.ts`, `'connectors:call-tool-result'` goes into the pinned `registers` list after `'connectors:call-tool'`.

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @ax/mcp-client test src/__tests__/connector-call-tool-result.test.ts src/__tests__/connector-call-server-tool.test.ts src/__tests__/connector-inventory-wiring.test.ts`
Expected: FAIL (`callServerToolWithContent` / `createCallToolResult` not exported; hook not registered).

- [ ] **Step 5: Implement**

`callServerToolWithContent = (opts) => sendOneCall(opts, onReply)`. `onReply` returns `tool-error` when `isError === true`, and `{ outcome: 'succeeded', content: [] }` when `content` is absent. Otherwise it `safeParse`s `reply.content` with `z.array(ConnectorResultContentBlockSchema)`: a failure is `{ outcome: 'unknown', reason: 'interrupted' }` (an unreadable reply after the send), and a success returns the reply's own array (validate, but never hand back zod's copy). `createCallToolResult` is `createConnectorCallHandler({ bus, now, logEvent: 'connector_call_tool_result', send: (s) => (deps.callServerWithContent ?? callServerToolWithContent)(s) })`. Register it in `plugin.ts` right after `connectors:call-tool`, in the same flag block, with `{ returns: ConnectorCallToolResultOutputSchema }`.

- [ ] **Step 6: Update the prose**

- `types.ts`: a boundary-review block for the new hook. Alternate impl: a non-MCP connector runtime (a REST/OpenAPI adapter) answering the same toolKey with `{ outcome, content }`. Leaky fields: none (`content` is opaque typed blocks; `toolKey` is the canonical permission key). Subscriber risk: none (service hook, one implementer). Wire surface: none (not an IPC action, not `tool:execute:*`).
- `plugin.ts` header: item 4, "Connector results for apps: `connectors:call-tool-result` runs the same checks as item 3 and returns the reply's content blocks. Its intended caller is `@ax/apps-bridge`."
- `SECURITY.md`: a new section, "Connector results for apps (`connectors:call-tool-result`)". It says what differs from `connectors:call-tool`: content comes back (untrusted, at most 2 MiB per reply, read through a local schema, never `CallToolResultSchema` or `callTool`); `isError` returns no content; the intended caller is `@ax/apps-bridge`, which checks tool policy (`allow` only) and its own grants first; the same supply-chain residual (any host plugin can call it). Fix the intro ("Two of them…" → three) and line 8 ("The inventory and approved calls are the only places this package opens network connections" → the inventory, approved calls and connector results). Scope "The reply's content is dropped unread" to `connectors:call-tool`.

- [ ] **Step 7: Run the tests and the type-check**

Run: `pnpm --filter @ax/mcp-client build && pnpm --filter @ax/mcp-client test`
Expected: tsc clean, all PASS.
Run: `git diff -U0 -- packages/mcp-client/src/__tests__/connector-call-tool.test.ts packages/mcp-client/src/__tests__/connector-call-server-tool.test.ts | grep -c '^-[^-]'`
Expected: `0` (additions only).

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-client
git commit -m "feat(mcp-client): connectors:call-tool-result — the same checks, and the reply's content"
```

---

### Task 3: `@ax/apps-bridge-contract` — the wire shapes [tier: integration]

**Files:**
- Create: `packages/apps-bridge-contract/package.json` (private, ESM, `exports: { ".": … }`, `files: ["dist"]`; dependencies `zod: ^3.23.8` only; dev `@types/node`, `typescript`, `vitest`)
- Create: `packages/apps-bridge-contract/tsconfig.json` (copy `packages/routines-contract/tsconfig.json`: `lib: ["ES2023","DOM"], types: []`; no references)
- Create: `packages/apps-bridge-contract/vitest.config.ts`
- Create: `packages/apps-bridge-contract/src/index.ts` (re-exports both modules)
- Create: `packages/apps-bridge-contract/src/wire.ts` (external v1; imports only `zod`, so the platform can vendor this one file verbatim)
- Create: `packages/apps-bridge-contract/src/settings.ts` (AX-internal settings and approve-page shapes; imports `zod` and `./wire.js`)
- Test: `packages/apps-bridge-contract/src/__tests__/wire.test.ts`, `settings.test.ts`, `browser-safe.test.ts`
- Modify: root `tsconfig.json` (reference), `eslint.config.mjs` (`'!@ax/apps-bridge-contract'` in the `crossPluginImports.group` allow-list ~lines 123-137, its message ~line 140, and the header list ~lines 6-77), `pnpm-lock.yaml` (one importer block)

**Interfaces — Produces (exact; Tasks 6–8 and 12–13 import these):**

```ts
// wire.ts
export const APPS_BRIDGE_V1_BASE_PATH = '/api/apps-bridge/v1';
export const PLATFORM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const APP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const TOOL_NAME_RE = /^[\x21-\x7e]{1,128}$/;
export const MAX_TOKEN_CHARS = 8192;
export const APP_MODES = ['builder', 'viewer'] as const;              export type AppMode = (typeof APP_MODES)[number];
export const FAILED_REASONS = ['invalid-call','not-connected','needs-auth','unavailable','unreachable','rejected','tool-error'] as const;
export const UNKNOWN_REASONS = ['timeout', 'interrupted'] as const;
export const REFUSAL_STATUS = { invalid_request: 400, unauthenticated: 401, app_not_linked: 404, not_granted: 403,
  tool_not_allowed: 403, approval_required: 403, viewer_invalid: 403, viewer_approval_required: 403,
  agent_unavailable: 403, rate_limited: 429, unavailable: 503 } as const;
export type RefusalCode = keyof typeof REFUSAL_STATUS;
// CallRequestSchema: discriminatedUnion('mode', [
//   { appId, connectorId, tool, input: z.record(z.unknown()), mode: 'builder' }.strict(),
//   { …same, mode: 'viewer', viewerAssertion: z.string().min(1).max(MAX_TOKEN_CHARS) }.strict() ])
// ContentBlockSchema: z.object({ type: z.string().min(1).max(64) }).passthrough()
// CallResponseSchema: discriminatedUnion('outcome', [ succeeded {content: ContentBlock[]}.strict(),
//   failed {reason: enum(FAILED_REASONS)}.strict(), unknown {reason: enum(UNKNOWN_REASONS)}.strict() ])
// RefusalSchema: union([ {code:'viewer_approval_required', approveUrl: z.string().url().max(2048)}.strict(),
//   {code: enum(every other code)}.strict() ])
// GrantsResponseSchema: { appId, grants: [{ connectorId, name: z.string(), mode: enum(APP_MODES), tools: ToolName[] }.strict()] }.strict()
// Types: CallRequest, CallResponse, Refusal, GrantsResponse (z.infer)

// settings.ts
export const TOOL_KEY_RE = /^mcp\.(c[0-9a-f]{10})\.([\x21-\x7e]{1,128})$/;
export const MAX_GRANT_TOOLS = 200;
export const SETTINGS_BODY_MAX_BYTES = 16_384;
export const APPS_SETTINGS_ROUTES = {
  read: '/settings/apps/:agentId', link: '/settings/apps/:agentId/link', unlink: '/settings/apps/:agentId/unlink',
  grant: '/settings/apps/:agentId/grant', ungrant: '/settings/apps/:agentId/ungrant',
  revoke: '/settings/apps/:agentId/revoke', approval: '/settings/app-approval/:platformId/:appId/:connectorId',
} as const;
export const SETTINGS_ERRORS = { unauthenticated: 401, internal: 500, 'agent-not-found': 404, forbidden: 403,
  'bridge-off': 409, 'invalid-body': 400, 'app-already-linked': 409, 'not-linked': 404,
  'connector-not-on-agent': 400, 'tool-not-on-connector': 400, 'duplicate-tool-name': 400,
  'not-found': 404, 'agent-not-eligible': 400, unavailable: 503 } as const;   // body: { error: <key> }
// AppToolSchema { toolKey: TOOL_KEY_RE, name: TOOL_NAME_RE }.strict()
// AppGrantSchema { connectorId, connectorName: z.string(), mode, tools: AppTool[] (max MAX_GRANT_TOOLS) }.strict()
// AppLinkSchema { appId, createdAt: z.string().datetime(), grants: AppGrant[] }.strict()
// ViewerApprovalSchema { appId, connectorId, connectorName: z.string(), createdAt: z.string().datetime() }.strict()
// AgentAppsReadSchema: discriminatedUnion('enabled', [ {enabled:false}.strict(),
//   {enabled:true, canManage: boolean, links: AppLink[], approvals: ViewerApproval[]}.strict() ])
// LinkAppBodySchema { appId }.strict()  (link and unlink)        → link answers { link: AppLink }
// SaveGrantBodySchema { appId, connectorId, mode, toolKeys: TOOL_KEY_RE[] min 1 max MAX_GRANT_TOOLS }.strict() → { grant: AppGrant }
// AppConnectorBodySchema { appId, connectorId }.strict()  (ungrant and revoke) → {}
// ApprovalPromptSchema { platformId, appId, connectorId, connectorName: z.string(), tools: ToolName[],
//   agents: [{ agentId: z.string().min(1).max(256), displayName: z.string() }.strict()], approvedAgentId: z.string().nullable() }.strict()
// ApproveBodySchema { agentId: z.string().min(1).max(256) }.strict()  → {}
export const APPROVE_PAGE_PREFIX = '/apps/approve/';
export function approvePagePath(platformId: string, appId: string, connectorId: string): string;
export function parseApprovePagePath(pathname: string): { platformId: string; appId: string; connectorId: string } | null;
```

`parseApprovePagePath` accepts exactly `/apps/approve/<p>/<a>/<c>`. Each segment must match its regex; there is no trailing slash, no extra segment, no percent-encoding, and nothing after the path. `approvePagePath` throws on an id that fails its regex.

- [ ] **Step 1: Write the failing tests**

```ts
// wire.test.ts
it('ids follow their grammar');  // APP_ID: 'expenses','a','a-1' ok; 'Expenses','-x','x-','a_b', 64 chars → no. CONNECTOR_ID: 'linear','gh_2' ok; '_x', 129 chars → no. TOOL_NAME: 'list_issues' ok; 'list issues', '' → no
it('a builder call may not carry a viewer assertion, and a viewer call must');   // strict union
it('a call body with an unknown key or a non-object input is refused');          // input: [] → fails
it('responses are closed shapes');   // succeeded keeps extra block keys; failed with content fails; unknown/tool-error fails
it('approveUrl rides only on viewer_approval_required');
it('REFUSAL_STATUS is the contract table');   // toEqual the literal table in Global Constraints
// settings.test.ts
it('TOOL_KEY_RE is the same literal as mcp-client CONNECTOR_TOOL_KEY_RE');
// expect(TOOL_KEY_RE.source).toBe('^mcp\\.(c[0-9a-f]{10})\\.([\\x21-\\x7e]{1,128})$'); expect(TOOL_KEY_RE.flags).toBe('')
it('approve page paths round-trip and reject everything else');  // trailing '/', 4 segments, '%2F', '?x=1', bad id → null
it('a grant body needs 1..200 tool keys of the canonical shape');
it('settings bodies are strict');                                 // an extra key fails each body schema
// browser-safe.test.ts — copy routines-contract's 'bundles the public entry for browsers…' (definition.test.ts ~274-277)
it('bundles for browsers with no node: or @ax/ imports');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/apps-bridge-contract test`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `wire.ts`, `settings.ts`, `index.ts`** with the exact values above. Add the package to the root `tsconfig.json` references and the eslint allow-list. Run `pnpm install`, then `pnpm install --frozen-lockfile`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ax/apps-bridge-contract build && pnpm --filter @ax/apps-bridge-contract test && pnpm test:eslint-rules && pnpm test:scripts`
Expected: PASS. `git diff pnpm-lock.yaml` shows only the new importer block.

- [ ] **Step 5: Commit**

```bash
git add packages/apps-bridge-contract tsconfig.json eslint.config.mjs pnpm-lock.yaml
git commit -m "feat(apps-bridge-contract): the apps bridge wire v1 and settings shapes"
```

---

### Task 4: `@ax/apps-bridge` — package, tables, store, cleanup subscribers [tier: sensitive]

`security-checklist`: required (new tables holding credential-lending grants; migration).

**Files:**
- Create: `packages/apps-bridge/package.json`. Dependencies: `@ax/core` and `@ax/apps-bridge-contract` (`workspace:*`), `kysely: 0.28.17`, `zod: ^3.23.8`. Dev: `@ax/database-postgres`, `@ax/test-harness`, `@testcontainers/postgresql: 11.14.0`, `pg: 8.20.0`, `@types/pg: 8.20.0`, `@types/node`, `typescript`, `vitest`. `files: ["dist","SECURITY.md"]`.
- Create: `packages/apps-bridge/tsconfig.json` (references `../core`, `../apps-bridge-contract`), `packages/apps-bridge/vitest.config.ts` (copy `packages/channel-slack/vitest.config.ts`: `testTimeout: 60_000`, `hookTimeout: 120_000`)
- Create: `packages/apps-bridge/src/migrations.ts`, `src/store.ts`, `src/cleanup.ts`, `src/plugin.ts` (skeleton), `src/config.ts` (types only in this task), `src/index.ts`
- Modify: root `tsconfig.json`, `pnpm-lock.yaml`, `eslint-rules/no-bare-tenant-tables.js` (add `'apps_bridge_v1_'` to `TENANT_TABLE_PREFIXES`, with a comment: "App links, grants and viewer approvals (APPSBRIDGE): only packages/apps-bridge/src/store.ts queries these")
- Test: `packages/apps-bridge/src/__tests__/store.test.ts`, `src/__tests__/cleanup.test.ts`

**Interfaces:**
- Produces (`migrations.ts`): `runAppsBridgeMigration(db: Kysely<AppsBridgeDatabase>): Promise<void>` and `AppsBridgeDatabase`. The DDL, run idempotently on every boot:

```sql
CREATE TABLE IF NOT EXISTS apps_bridge_v1_links (
  platform_id TEXT NOT NULL, app_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, linked_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, app_id));
CREATE INDEX IF NOT EXISTS apps_bridge_v1_links_agent_idx ON apps_bridge_v1_links (agent_id);
CREATE TABLE IF NOT EXISTS apps_bridge_v1_grants (
  platform_id TEXT NOT NULL, app_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('builder','viewer')),
  tool_keys TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform_id, app_id, connector_id),
  FOREIGN KEY (platform_id, app_id) REFERENCES apps_bridge_v1_links (platform_id, app_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS apps_bridge_v1_grants_connector_idx ON apps_bridge_v1_grants (connector_id);
CREATE TABLE IF NOT EXISTS apps_bridge_v1_viewer_approvals (
  viewer_user_id TEXT NOT NULL, platform_id TEXT NOT NULL, app_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, tool_keys TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_user_id, platform_id, app_id, connector_id),
  FOREIGN KEY (platform_id, app_id, connector_id)
    REFERENCES apps_bridge_v1_grants (platform_id, app_id, connector_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS apps_bridge_v1_viewer_approvals_agent_idx ON apps_bridge_v1_viewer_approvals (agent_id);
```

- Produces (`store.ts`):
  ```ts
  export interface AppLink { platformId: string; appId: string; agentId: string; linkedByUserId: string; createdAt: Date }
  export interface AppGrant { platformId: string; appId: string; connectorId: string; mode: AppMode; toolKeys: string[]; createdAt: Date; updatedAt: Date }
  export interface ViewerApproval { viewerUserId: string; platformId: string; appId: string; connectorId: string; agentId: string; toolKeys: string[]; createdAt: Date }
  export interface AppsBridgeStore {
    getLink(platformId: string, appId: string): Promise<AppLink | null>;
    listLinksForAgent(platformId: string, agentId: string): Promise<AppLink[]>;
    createLink(l: Omit<AppLink, 'createdAt'>): Promise<'created' | 'taken'>;   // INSERT … ON CONFLICT DO NOTHING RETURNING
    deleteLink(platformId: string, appId: string, agentId: string): Promise<boolean>; // only a link to that agent
    getGrant(platformId: string, appId: string, connectorId: string): Promise<AppGrant | null>;
    listGrants(platformId: string, appId: string): Promise<AppGrant[]>;           // ordered by connector_id
    putGrant(g: Pick<AppGrant, 'platformId'|'appId'|'connectorId'|'mode'|'toolKeys'>): Promise<AppGrant | 'no-link'>; // upsert; FK 23503 → 'no-link'
    deleteGrant(platformId: string, appId: string, connectorId: string): Promise<boolean>;
    getApproval(viewerUserId: string, platformId: string, appId: string, connectorId: string): Promise<ViewerApproval | null>;
    listApprovalsForViewerAgent(viewerUserId: string, platformId: string, agentId: string): Promise<ViewerApproval[]>;
    putApproval(a: Omit<ViewerApproval, 'createdAt'>): Promise<'saved' | 'no-grant'>;  // upsert; FK 23503 → 'no-grant'
    deleteApproval(viewerUserId: string, platformId: string, appId: string, connectorId: string, agentId: string): Promise<boolean>;
    deleteForAgent(agentId: string): Promise<{ links: number; approvals: number }>;
    deleteGrantsForConnector(connectorId: string): Promise<number>;
  }
  export function createAppsBridgeStore(db: Kysely<AppsBridgeDatabase>): AppsBridgeStore;
  ```
- Produces (`cleanup.ts`): `subscribeCleanup(bus, store): void`.
  - `agents:deleted` → `store.deleteForAgent(agentId)` removes links to the agent (cascading grants and approvals) and approvals that borrow it.
  - `connectors:deleted` with `idStillLive === false` → `store.deleteGrantsForConnector(connectorId)` (cascading approvals). `idStillLive === true` → nothing.
  - Both validate the payload, log a code-only line, and never throw.
- Produces (`config.ts`, types only here): `AppsBridgeConfig` and `AppsBridgeDeployConfig`, exactly as Task 7 lists them. Task 7 adds the validation.
- Produces (`plugin.ts` skeleton): `createAppsBridgePlugin(config: AppsBridgeConfig): Plugin` (Task 7 widens the return type to `AppsBridgePlugin`). Manifest `{ name: '@ax/apps-bridge', registers: [], calls: ['database:get-instance'], subscribes: ['agents:deleted','connectors:deleted'] }`. `init` runs the migration, builds the store and subscribes. Later tasks grow `calls`.

- [ ] **Step 1: Write the failing store tests** (`createSharedPostgres(() => startTestContainer(new PostgreSqlContainer('postgres:16-alpine')))`, a fresh database per test)

```ts
it('migrations are idempotent');                     // run twice; to_regclass for all three tables is non-null
it('the first link of an app id wins; a second is taken');
// await Promise.all([createLink({…agentId:'a1'}), createLink({…agentId:'a2'})]) → sorted ['created','taken']; getLink(...).agentId is the 'created' one
it('deleteLink only removes a link to that agent');  // deleteLink(p,a,'other') === false; getLink still set
it('putGrant upserts one grant per connector');      // second put replaces mode and toolKeys (order kept); listGrants length 1; updatedAt moves
it('putGrant without a link is no-link');            // → 'no-link', nothing written
it('unlinking cascades grants and approvals; removing a grant cascades its approvals');
it('putApproval upserts the agent and the tool snapshot; without a grant it is no-grant');
it('deleteForAgent removes links to the agent and approvals that borrow it, nothing else');  // returns exact counts
it('deleteGrantsForConnector removes that connector\'s grants on every app');
```

- [ ] **Step 2: Write the failing cleanup tests**

Boot `createTestHarness({ plugins: [createDatabasePostgresPlugin({ connectionString }), createAppsBridgePlugin({ publicOrigin: 'http://ax.test' })] })`. Later tasks extend `services` with stubs for each new `calls` entry, so this test keeps booting.

```ts
it('agents:deleted purges the agent\'s links and the approvals that borrow it');
it('connectors:deleted removes grants only when the id is no longer live');
it('a malformed payload is logged and ignored, never thrown');   // fire with {} and with { agentId: 7 }; rows unchanged
```

- [ ] **Step 3: Run to verify they fail**

Run: `DOCKER_HOST=<your socket> pnpm --filter @ax/apps-bridge test`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement** `migrations.ts` (the DDL above, one `sql\`…\`.execute(db)` per statement), `store.ts` (every query in this file; `Postgres error code 23503` → `'no-link'` / `'no-grant'`), `cleanup.ts`, the plugin skeleton, and `index.ts`. Add the eslint prefix. Run `pnpm install`, then `pnpm install --frozen-lockfile`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @ax/apps-bridge build && DOCKER_HOST=<your socket> pnpm --filter @ax/apps-bridge test && pnpm test:eslint-rules && pnpm test:scripts`
Expected: PASS. `scripts/__tests__/agent-keyed-tables-are-cleaned.test.js` stays green: both agent-keyed tables are deleted from in `store.ts`, and the package names `'agents:deleted'`.

- [ ] **Step 6: Commit**

```bash
git add packages/apps-bridge tsconfig.json pnpm-lock.yaml eslint-rules/no-bare-tenant-tables.js
git commit -m "feat(apps-bridge): app links, grants and viewer approvals, cleaned up with their agent and connector"
```

---

### Task 5: OIDC verification for the caller and the viewer [tier: sensitive]

`security-checklist`: required (new dependency `jose`; untrusted tokens across a trust boundary).

**Files:**
- Create: `packages/apps-bridge/src/verify-token.ts`
- Create: `packages/test-harness/src/fake-oidc-issuer.ts` (exported from `packages/test-harness/src/index.ts`; `node:crypto` and `node:http` only, so no new dependency for test-harness)
- Modify: `packages/apps-bridge/package.json` (`"jose": "6.2.8"`, exact), `pnpm-lock.yaml` (importer entry only; `jose@6.2.8` is already resolved)
- Test: `packages/apps-bridge/src/__tests__/verify-token.test.ts`, `packages/test-harness/src/__tests__/fake-oidc-issuer.test.ts`

**Interfaces:**
- Produces (`verify-token.ts`):
  ```ts
  export const ALLOWED_JWS_ALGS = ['RS256','RS384','RS512','PS256','PS384','PS512','ES256','ES384','ES512','EdDSA'] as const;
  export const CLOCK_TOLERANCE_SECONDS = 30;
  export type VerifyFailure = 'malformed' | 'bad-signature' | 'expired' | 'not-yet-valid' | 'too-old'
    | 'wrong-issuer' | 'wrong-audience' | 'wrong-subject' | 'bad-claims' | 'keys-unavailable';
  export type CallerVerdict = { ok: true } | { ok: false; reason: VerifyFailure };
  export type ViewerVerdict = { ok: true; email: string } | { ok: false; reason: VerifyFailure };
  export interface CallerVerifierConfig { issuer: string; jwksUrl: string; audience: string; subject: string }
  export interface ViewerVerifierConfig { issuer: string; jwksUrl: string; audience: string; maxAgeSeconds: number }
  export function assertJwksUrl(raw: string): URL;   // throws Error naming the rule
  export function createCallerVerifier(cfg: CallerVerifierConfig, opts?: { now?: () => number }): (token: string) => Promise<CallerVerdict>;
  export function createViewerVerifier(cfg: ViewerVerifierConfig, opts?: { now?: () => number }): (token: string) => Promise<ViewerVerdict>;
  ```
- Produces (`@ax/test-harness`, used by Tasks 6, 7 and 11):
  ```ts
  export interface FakeOidcIssuer {
    issuer: string; jwksUrl: string; kid: string;
    mint(claims: Record<string, unknown>, opts?: { alg?: 'RS256' | 'ES256' | 'HS256' | 'none'; kid?: string }): string;
    setJwksStatus(status: number): void;   // the JWKS route answers this status from now on (default 200)
    jwksRequests(): number;
    close(): Promise<void>;
  }
  export function startFakeOidcIssuer(opts?: { alg?: 'RS256' | 'ES256' }): Promise<FakeOidcIssuer>;
  // serves { keys: [publicJwk + kid + alg + use:'sig'] } at http://127.0.0.1:<port>/jwks;
  // 'HS256' signs with the public key's DER bytes as the HMAC secret (the alg-confusion probe); 'none' leaves the signature empty
  ```

Verification algorithm (the part the signatures don't determine):
1. A token over `MAX_TOKEN_CHARS`, or not three dot-separated base64url parts → `malformed`, without touching the JWKS.
2. Keys come from `createRemoteJWKSet(assertJwksUrl(cfg.jwksUrl))` (jose defaults: 5 s timeout, 30 s cooldown, 10 min cache), wrapped. `JWKSNoMatchingKey` and `JWKSMultipleMatchingKeys` rethrow as they are. Any other error from the key set becomes a local `KeysUnavailable` error.
3. `jwtVerify(token, keys, { issuer, audience, algorithms: [...ALLOWED_JWS_ALGS], clockTolerance: 30, currentDate: new Date(now()), requiredClaims })`. The caller adds `subject` and `requiredClaims: ['exp']`. The viewer adds `maxTokenAge: cfg.maxAgeSeconds` and `requiredClaims: ['exp','iat','email']`.
4. Map errors:
   - `KeysUnavailable` → `keys-unavailable`.
   - `ERR_JWT_EXPIRED`: claim `iat` → `too-old`; otherwise `expired`.
   - `ERR_JWT_CLAIM_VALIDATION_FAILED`: claim `iss` → `wrong-issuer`, `aud` → `wrong-audience`, `sub` → `wrong-subject`, `nbf` → `not-yet-valid`; anything else → `bad-claims`.
   - `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWKS_NO_MATCHING_KEY`, `ERR_JWKS_MULTIPLE_MATCHING_KEYS`, `ERR_JOSE_ALG_NOT_ALLOWED` → `bad-signature`.
   - Everything else → `malformed`.
5. Viewer only, after a pass:
   - `email` must be a string of 3–320 printable-ASCII characters with exactly one `@`, else `bad-claims`.
   - An `email_verified` claim that is present and not `true` → `bad-claims`.

- [ ] **Step 1: Write the failing tests**

```ts
// fake-oidc-issuer.test.ts
it('serves its public key and mints tokens a JWKS-verifying client accepts');
// verify one minted RS256 and one ES256 token with node:crypto against the served JWK
// verify-token.test.ts — clock seam: now = () => T (ms)
it('caller: accepts the configured issuer, audience and subject');
it('caller: each mismatched claim has its own reason');       // iss → wrong-issuer, aud → wrong-audience, sub → wrong-subject, no sub → wrong-subject
it('caller: exp is checked with 30 s tolerance');            // exp = T/1000 - 29 → ok; exp = T/1000 - 31 → expired
it('caller: a token without exp is refused');                 // bad-claims
it('caller: nbf in the future beyond tolerance is refused');  // nbf = T/1000 + 31 → not-yet-valid
it('alg none and an HS256 token signed with the public key are refused');  // bad-signature or malformed; never ok
it('a token from another key or an unknown kid is refused');  // bad-signature
it('an overlong token is malformed and never fetches keys');  // 8193 chars; jwksRequests() unchanged
it('a JWKS outage is keys-unavailable, not a bad token');     // setJwksStatus(500) → keys-unavailable
it('viewer: returns the email of a fresh assertion (ES256, as IAP signs)');
it('viewer: max age is iat plus tolerance');                  // iat = T/1000 - 629 → ok; -631 → too-old (maxAgeSeconds 600)
it('viewer: a missing, non-string or overlong email is bad-claims');
it('viewer: email_verified false is bad-claims; absent is fine');
it('assertJwksUrl: https or loopback http only, no credentials');  // http://example.com, https://u:p@x.test throw; http://127.0.0.1:1/jwks ok
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/test-harness test src/__tests__/fake-oidc-issuer.test.ts && pnpm --filter @ax/apps-bridge test src/__tests__/verify-token.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** both files. Add `jose` at exactly `6.2.8`. Run `pnpm install`, then `pnpm install --frozen-lockfile`. Run `pnpm audit --audit-level moderate`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ax/test-harness build && pnpm --filter @ax/test-harness test src/__tests__/fake-oidc-issuer.test.ts && pnpm --filter @ax/apps-bridge build && pnpm --filter @ax/apps-bridge test src/__tests__/verify-token.test.ts`
Expected: PASS. `git diff pnpm-lock.yaml` adds `jose: 6.2.8` under `packages/apps-bridge` only, with no new snapshot entry.

- [ ] **Step 5: Commit**

```bash
git add packages/apps-bridge packages/test-harness pnpm-lock.yaml
git commit -m "feat(apps-bridge): verify the platform's OIDC token and the viewer's assertion"
```

---

### Task 6: The call and grants logic [tier: sensitive]

`security-checklist`: required (authorization of credential use; untrusted input).

**Files:**
- Create: `packages/apps-bridge/src/access.ts` (shared rights and reads)
- Create: `packages/apps-bridge/src/limits.ts`
- Create: `packages/apps-bridge/src/bridge-call.ts`
- Create: `packages/apps-bridge/src/log-code.ts` (a five-line `loggableCode`, copied per I2 from `packages/mcp-client/src/connector-inventory/loggable-code.ts`)
- Create: `packages/apps-bridge/src/__tests__/support/fake-store.ts` (an in-memory `AppsBridgeStore` with the same cascade and `no-link`/`no-grant` rules)
- Test: `packages/apps-bridge/src/__tests__/bridge-call.test.ts`, `src/__tests__/limits.test.ts`

**Interfaces:**
- Consumes: Task 2's hook; Task 3's `CallRequestSchema`, `GrantsResponse`, `Refusal`, `REFUSAL_STATUS`, `TOOL_KEY_RE`, `approvePagePath`; Task 4's `AppsBridgeStore`; Task 5's `ViewerVerdict`.
- Produces (`access.ts`). It declares local structural views of the agent and connector shapes (as `call-tool.ts` does), with no runtime import of `@ax/agents` or `@ax/connectors`.
  ```ts
  export interface AgentView { id: string; ownerId: string; ownerType: 'user' | 'team'; displayName: string; connectorAttachments: string[]; connectorExclusions: string[] }
  export function bridgeCtx(userId: string, agentId: string, logger: Logger): AgentContext; // makeAgentContext({ sessionId: 'apps-bridge', … })
  export function resolveAgent(bus: Bus, ctx: AgentContext, agentId: string, userId: string): Promise<AgentView | null>;  // not-found/forbidden → null; others throw
  export function effectiveConnectors(bus: Bus, ctx: AgentContext, userId: string, agent: AgentView):
    Promise<Array<{ id: string; name: string; toolNamespaces: string[] }>>;                 // connectors:list-effective
  export function connectorNames(bus: Bus, ctx: AgentContext, userId: string): Promise<Map<string, string>>; // connectors:list
  export function canManageAgent(bus: Bus, ctx: AgentContext, agentId: string, userId: string): Promise<boolean>;
  // agents:can-manage-connectors { agentId, actor: { userId, isAdmin: false } }
  ```
- Produces (`limits.ts`):
  ```ts
  export const APPS_BRIDGE_LIMITS = { perAppPerMinute: 120, perPlatformPerMinute: 600, maxInFlightPerPlatform: 32, windowMs: 60_000, maxTrackedKeys: 10_000 } as const;
  export interface BridgeLimiter {
    takePlatform(platformId: string): boolean;
    takeApp(platformId: string, appId: string): boolean;
    acquire(platformId: string): (() => void) | null;   // the release is idempotent
  }
  export function createBridgeLimiter(opts?: { now?: () => number; limits?: Partial<typeof APPS_BRIDGE_LIMITS> }): BridgeLimiter;
  ```
  The windows are sliding, in the shape of `packages/channel-web/src/server/per-user-rate-limit.ts` (copied, not imported). A full key map sweeps expired keys first and then refuses new keys.
- Produces (`bridge-call.ts`):
  ```ts
  export interface BridgeLog { appId?: string; connectorId?: string; tool?: string; mode?: AppMode; outcome: string; reason?: string }
  export interface BridgeAnswer { status: number; body: CallResponse | Refusal | GrantsResponse; retryAfterSeconds?: number; log: BridgeLog }
  export interface BridgeDeps {
    bus: { call<I, O>(hook: string, ctx: AgentContext, input: I): Promise<O> };
    store: AppsBridgeStore; platformId: string;
    publicOrigin: string;   // an origin with no trailing slash: the plugin passes new URL(config.publicOrigin).origin
    verifyViewer: (assertion: string) => Promise<ViewerVerdict>;
    limiter: Pick<BridgeLimiter, 'takeApp'>; logger: Logger;
  }
  export function answerCall(deps: BridgeDeps, body: unknown): Promise<BridgeAnswer>;      // body = the JSON.parse result
  export function answerGrants(deps: BridgeDeps, appId: string): Promise<BridgeAnswer>;
  ```

`answerCall`, in this order. The first failure answers, and nothing after it runs:
1. `CallRequestSchema.safeParse(body)` fails → `invalid_request`. From here on, `input` means `(body as { input: unknown }).input`, the parsed JSON's own object and never zod's copy.
2. `limiter.takeApp(platformId, appId)` false → `rate_limited` (`retryAfterSeconds: 60`).
3. `store.getLink` null → `app_not_linked`.
4. `store.getGrant(…connectorId)` null, or `grant.mode !== mode` → `not_granted`.
5. `toolKey` = the grant's one key whose `TOOL_KEY_RE` group 2 equals `tool`. None → `tool_not_allowed`.
6. Identity.
   - Builder: `(userId, agentId) = (link.linkedByUserId, link.agentId)`.
   - Viewer:
     - Verify the assertion: `keys-unavailable` → `unavailable` (`retryAfterSeconds: 5`); any other failure → `viewer_invalid`.
     - `auth:find-user-by-email { email }` null → `viewer_invalid` (log `reason: 'no-account'`).
     - `store.getApproval(viewer, …)` null, or `toolKey` not in `approval.toolKeys` → `viewer_approval_required` with `approveUrl = publicOrigin + approvePagePath(platformId, appId, connectorId)`.
     - `(userId, agentId) = (viewer, approval.agentId)`.
7. `resolveAgent(…agentId, userId)` null → `agent_unavailable`. In viewer mode, also `agent_unavailable` unless `ownerType === 'user' && ownerId === userId`.
8. `tool-policy:evaluate { call: { name: toolKey, input }, agentId }`, read through a local `z.object({ verdict: z.enum(['allow','hold','deny']) }).passthrough()`. `hold` → `approval_required`. `deny` → `tool_not_allowed`. A throw or unreadable answer → `unavailable`.
9. `connectors:call-tool-result { userId, agentId, toolKey, input }` under `bridgeCtx(userId, agentId)`. The answer is the body of a 200, verbatim. A throw from the bus (its timeout, `invalid-return`) → 200 `{ outcome: 'unknown', reason: 'interrupted' }`, because the call may have gone out.
10. Any throw from the store or a read before step 9 → `unavailable` (`retryAfterSeconds: 5`).

Every answer carries `log`. Request fields go into it only once they have passed step 1.

`answerGrants`: `APP_ID_RE` fails → `invalid_request`. No link → `app_not_linked`. Otherwise 200 `{ appId, grants }`, one entry per grant in `connector_id` order. `name` comes from `connectorNames(…link.linkedByUserId)`, or the connector id when the map lacks it. `tools` are the tool names (`TOOL_KEY_RE` group 2), in grant order.

- [ ] **Step 1: Write the failing tests** (`bridge-call.test.ts`; a fake bus records `{ hook, ctx, input }`; the fake store; a `verifyViewer` stub)

```ts
it('builder: runs as the linker and the linked agent, and sends the request\'s own input object');
// bus hooks in order: ['agents:resolve','tool-policy:evaluate','connectors:call-tool-result'];
// call-tool-result input.userId === LINKER, .agentId === AGENT, ctx.userId === LINKER, ctx.agentId === AGENT;
// expect(sentInput).toBe(body.input); answer { status: 200, body: { outcome: 'succeeded', content } }
it.each(REFUSALS_IN_ORDER)('%s', …);  // each asserts status, body.code, and that connectors:call-tool-result was never called:
// bad body → 400 invalid_request; app over limit → 429 rate_limited (retryAfterSeconds 60); no link → 404 app_not_linked;
// no grant → 403 not_granted; grant mode differs → 403 not_granted; tool not on grant → 403 tool_not_allowed;
// resolve not-found / forbidden → 403 agent_unavailable; policy hold → 403 approval_required; policy deny → 403 tool_not_allowed;
// policy throws / answers {verdict:'maybe'} → 503 unavailable (retryAfterSeconds 5); store throws → 503 unavailable
it('viewer: no approval answers viewer_approval_required with the path-only approve link');
// body.approveUrl === 'https://ax.test/apps/approve/canopy/expenses/linear'
it('viewer: a bad assertion is viewer_invalid; a JWKS outage is unavailable; an email with no account is viewer_invalid');
it('viewer: runs as the viewer and the agent they approved');
it('viewer: an approved agent that is no longer the viewer\'s personal agent is agent_unavailable');
it('viewer: a tool added after approval needs approval again; approved tools still work; a removed tool is not allowed'); // Review Focus 3
it('outcomes pass through verbatim; a bus throw after dispatch is unknown/interrupted');
it('input keys like __proto__ reach the hook byte-faithfully and pollute nothing');   // Review Focus 5
// body = JSON.parse('{"appId":"expenses","connectorId":"linear","tool":"list_issues","mode":"builder","input":{"__proto__":{"polluted":1},"constructor":"x"}}');
// Object.hasOwn(sentInput, '__proto__') === true; ({} as Record<string, unknown>).polluted === undefined
it('log fields carry codes and validated ids only');   // JSON of every answer.log: no input value, assertion, email or content
it('grants: lists the app\'s grants with connector names and tool names');
it('grants: an unknown app is app_not_linked; a malformed app id is invalid_request; an unknown connector name falls back to its id');
// limits.test.ts
it('per-app and per-platform windows slide');           // 120 takes ok, 121st refused, refused again until 60 s after the first
it('in-flight slots are capped and released once');    // 32 acquire ok, 33rd null; release() twice frees one slot
it('tracked keys are bounded');                         // maxTrackedKeys 2: a third app is refused until the window passes
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/apps-bridge test src/__tests__/bridge-call.test.ts src/__tests__/limits.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `access.ts`, `limits.ts`, `log-code.ts` and `bridge-call.ts`, following the order above.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ax/apps-bridge build && pnpm --filter @ax/apps-bridge test src/__tests__/bridge-call.test.ts src/__tests__/limits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/apps-bridge
git commit -m "feat(apps-bridge): grant, approval and policy checks before a connector call"
```

---

### Task 7: The bridge listener and plugin lifecycle [tier: sensitive]

`security-checklist`: required (new inbound network listener; untrusted bytes before authentication).

**Files:**
- Create: `packages/apps-bridge/src/listener.ts`
- Modify: `packages/apps-bridge/src/config.ts` (validation), `src/plugin.ts` (start, stop, `bridgeBoundPort`, grown manifest), `src/index.ts`
- Create: `packages/apps-bridge/SECURITY.md`
- Test: `packages/apps-bridge/src/__tests__/listener.test.ts`, `src/__tests__/plugin.test.ts`, `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: Task 5's verifiers, Task 6's `answerCall`/`answerGrants`/`createBridgeLimiter`, Task 3's `APPS_BRIDGE_V1_BASE_PATH`, `REFUSAL_STATUS`, `MAX_TOKEN_CHARS`.
- Produces (`config.ts`; consumed by Task 9):
  ```ts
  export interface AppsBridgeDeployConfig {
    platformId: string; host: string; port: number;
    caller: { issuer: string; jwksUrl: string; audience: string; subject: string };
    viewer: { issuer: string; jwksUrl: string; audience: string; maxAgeSeconds: number };
  }
  export interface AppsBridgeConfig {
    publicOrigin: string;              // where approve links point
    bridge?: AppsBridgeDeployConfig;   // absent: no listener; settings routes answer { enabled: false }
    now?: () => number;                // test seam
  }
  export const DEFAULT_APPS_BRIDGE_PORT = 9092;
  export const DEFAULT_VIEWER_MAX_AGE_SECONDS = 600;
  export interface AppsBridgeEnv {     // raw strings; index.ts reads each env var literally
    platformId?: string; port?: string;
    callerIssuer?: string; callerJwksUrl?: string; callerAudience?: string; callerSubject?: string;
    viewerIssuer?: string; viewerJwksUrl?: string; viewerAudience?: string; viewerMaxAgeSeconds?: string;
    bindHost: string;
  }
  export function parseAppsBridgeEnv(e: AppsBridgeEnv): AppsBridgeDeployConfig | undefined;
  export function assertAppsBridgeConfig(c: AppsBridgeConfig): void;
  ```
  - `parseAppsBridgeEnv` trims every value.
    - All empty → `undefined`.
    - A platform id with any caller or viewer value missing → throws an `Error` naming the env var.
    - Any value set without a platform id → throws `AX_APPS_BRIDGE_PLATFORM_ID is required when any AX_APPS_BRIDGE_* is set`.
    - Port must be `^\d{1,5}$` in 0–65535 (empty → 9092). Max age must be an integer 30–3600 (empty → 600).
    - Finally it calls `assertAppsBridgeConfig`.
  - `assertAppsBridgeConfig` checks: `PLATFORM_ID_RE`; `assertJwksUrl` on both URLs; issuer, audience and subject non-empty and at most 512 characters; `publicOrigin` parses as an http(s) URL. The plugin builds approve links from `new URL(publicOrigin).origin`, so a trailing slash in `AX_PUBLIC_BASE_URL` can't fail the boot or double a slash.
- Produces (`listener.ts`):
  ```ts
  export const BRIDGE_LISTENER_LIMITS = { maxCallBodyBytes: 1_048_576, headersTimeoutMs: 10_000, requestTimeoutMs: 90_000, keepAliveTimeoutMs: 5_000 } as const;
  export interface BridgeListenerOptions {
    host: string; port: number; platformId: string;
    verifyCaller: (token: string) => Promise<CallerVerdict>;
    limiter: BridgeLimiter;
    call: (body: unknown) => Promise<BridgeAnswer>;
    grants: (appId: string) => Promise<BridgeAnswer>;
    logger: Logger;
  }
  export interface BridgeListener { port(): number; stopAccepting(): Promise<void>; close(): Promise<void> }
  export function startBridgeListener(o: BridgeListenerOptions): Promise<BridgeListener>;
  ```
- Produces (`plugin.ts`):
  - `export interface AppsBridgePlugin extends Plugin { bridgeBoundPort(): number | undefined }`.
  - The listener binds in `startAdmission()` (only with `config.bridge`). `stopAdmission()` calls `stopAccepting()`. `shutdown()` calls `close()`: idempotent, waits for in-flight calls up to the kernel's per-plugin timeout, then `closeAllConnections()`.
  - Manifest `calls` grows by `auth:find-user-by-email`, `agents:resolve`, `connectors:list`, `tool-policy:evaluate` and `connectors:call-tool-result`.

Listener request flow (copy `content-origin.ts`'s server setup: `clientError` handling, the three timeouts, nothing logged from the error):
1. `POST /api/apps-bridge/v1/call` and `GET /api/apps-bridge/v1/apps/:appId/grants`. Any other path → 404 with no body. A known path with another method (OPTIONS and HEAD included) → 405 with `Allow`. No CORS headers.
2. `Authorization` must be `Bearer <token>` (the scheme case-insensitive), with a token of at most 8192 characters, else `unauthenticated`. `verifyCaller`: `keys-unavailable` → `unavailable` (`Retry-After: 5`); any other failure → `unauthenticated`. The body has not been read yet.
3. `limiter.takePlatform` false → `rate_limited` (`Retry-After: 60`).
4. POST only:
   - `acquire(platformId)` null → `rate_limited` (`Retry-After: 1`).
   - The content type must be `application/json` (parameters allowed), else `invalid_request`.
   - `Content-Length` over the cap → `invalid_request` without reading. Otherwise read, counting bytes; over the cap → stop reading and answer `invalid_request`.
   - `JSON.parse` failure → `invalid_request`.
   - `call(body)`. The slot is released in `finally`, whether the client stays or hangs up.
5. GET: `grants(appId)`. The raw `:appId` segment goes in as is; `answerGrants` validates it.
6. Every response is JSON with `cache-control: no-store`, `x-content-type-options: nosniff`, and `retry-after` when the answer has one. Exactly one `apps_bridge_call` or `apps_bridge_grants` info line per request: `platformId` once authenticated, plus the answer's `log` fields, or `{ outcome, reason }` for a refusal decided in steps 2–4. Never the path, a header or the body.

- [ ] **Step 1: Write the failing tests**

```ts
// listener.test.ts — real sockets on 127.0.0.1, port 0; fakes for verifyCaller, call, grants and the limiter
it('no Authorization is 401 unauthenticated and the body is never read');   // call() not invoked; verifyCaller not invoked
it('an overlong or non-Bearer token is 401 without verifying');              // 8193 chars; 'Basic x'
it('keys-unavailable is 503 unavailable with Retry-After 5');
it('a platform over its window is 429 with Retry-After 60');
it('the in-flight cap is 429 with Retry-After 1, and a hung-up client still frees its slot');  // Review Focus 4
// maxInFlight 1: request A's call() waits on a deferred; destroy A's socket; resolve the deferred;
// request B then reaches call(); exactly one log line for A
it('wrong content type, bad JSON, and a body over 1 MiB are 400 invalid_request, and call() never runs');  // Review Focus 5
it('GET grants passes the app id segment through');
it('unknown path 404; OPTIONS and wrong method 405 with Allow and no access-control-* headers');
it('every answer is JSON, no-store and nosniff');
it('one log line per request; the token never appears in it');
// config.test.ts
it('no AX_APPS_BRIDGE_* values means the bridge is off');                    // parseAppsBridgeEnv({ bindHost }) === undefined
it('a platform id needs every caller and viewer value');                     // throws naming AX_APPS_BRIDGE_CALLER_SUBJECT
it('a value without a platform id is refused');
it('defaults: port 9092, max age 600; bad port or max age is refused');      // '65536', '29', '3601', '1.5'
it('jwks urls must be https or loopback http');
// plugin.test.ts
it('with the bridge off nothing listens and bridgeBoundPort() is undefined');
it('startAdmission binds, stopAdmission refuses new connections, shutdown closes and is idempotent');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/apps-bridge test src/__tests__/listener.test.ts src/__tests__/config.test.ts src/__tests__/plugin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `config.ts`, `listener.ts` and the plugin lifecycle. The plugin wires `createCallerVerifier(bridge.caller)` and `createViewerVerifier(bridge.viewer)` into `answerCall`/`answerGrants` and the listener. Update the Task 4 cleanup test's `services` stubs for the new `calls`.

- [ ] **Step 4: Write `packages/apps-bridge/SECURITY.md`.** Use the same headings as `packages/mcp-client/SECURITY.md`: what it does; reach (the listener, its limits, never on the Ingress, a NetworkPolicy allow-list); authentication (the caller and viewer rules, no cookies, no CORS); authorization (link, grant, approval, policy, then the hook's own checks); untrusted input; credentials (never leave AX; only `content` on success); logging; residuals (app-id squatting, replay of an assertion within its max age, other host plugins calling `connectors:call-tool-result`); security contact.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @ax/apps-bridge build && DOCKER_HOST=<your socket> pnpm --filter @ax/apps-bridge test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/apps-bridge
git commit -m "feat(apps-bridge): the bridge's own listener: authenticate first, then read, limit and answer"
```

---

### Task 8: Settings and approve routes on the public listener [tier: sensitive]

`security-checklist`: required (who may lend an agent's sign-in; consent capture).

**Files:**
- Create: `packages/apps-bridge/src/user-auth.ts` (copy the shape of `packages/channel-slack/src/user-auth.ts`: `auth:require-user` → `{ ok: true; userId } | { ok: false; status: 401 | 500 }`; the admin flag is never read)
- Create: `packages/apps-bridge/src/settings-routes.ts`
- Modify: `packages/apps-bridge/src/plugin.ts` (register the routes in `init`, unregister them in `shutdown`; `calls` grows by `http:register-route`, `auth:require-user`, `agents:can-manage-connectors`, `agents:list-for-user`, `connectors:list-effective`)
- Test: `packages/apps-bridge/src/__tests__/settings-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's `APPS_SETTINGS_ROUTES`, body and response schemas, `SETTINGS_ERRORS`, `SETTINGS_BODY_MAX_BYTES`, `TOOL_KEY_RE`, `APP_ID_RE`; Task 4's store; Task 6's `access.ts`.
- Produces: `registerSettingsRoutes(bus: HookBus, deps: { store: AppsBridgeStore; platformId: string | undefined; logger: Logger }): Promise<Array<() => void>>`. Every POST registers with `maxBodyBytes: SETTINGS_BODY_MAX_BYTES` and keeps CSRF (no `bypassCsrf` anywhere). Errors are `{ error: <SETTINGS_ERRORS key> }` with that key's status. Consumed by Tasks 11, 12 and 13.

The order on every `/settings/apps/:agentId…` route (channel-slack `agent-routes.ts` order):
1. 401 signed out.
2. The same `404 agent-not-found` for a malformed agent id (`^[A-Za-z0-9_-]{1,256}$`), an unknown agent, and one `agents:resolve` refuses.
3. Rights.
4. The body (unknown key → `400 invalid-body`).
5. The domain.

With the bridge off, GET answers `{ enabled: false }` and every POST answers `409 bridge-off`. `canManage` = `canManageAgent(…)`, asked with `isAdmin: false`.

| Route | Who | Does |
|---|---|---|
| `GET read` | anyone who can resolve the agent | `{ enabled: true, canManage, links, approvals }`. `links`: this agent's links, with grants and connector names (`connectorNames` as the caller) and each tool's `{ toolKey, name }`. `approvals`: the caller's own approvals on this agent only |
| `POST link {appId}` | manager | `createLink({ …, linkedByUserId: caller })`. `'taken'` → `409 app-already-linked`. Answers `{ link }` |
| `POST unlink {appId}` | manager | `deleteLink(p, appId, agentId)`. False → `404 not-linked` |
| `POST grant {appId, connectorId, mode, toolKeys}` | manager | The link must be to this agent, else `404 not-linked`. The connector must be in the agent's effective set (`effectiveConnectors` as the caller), else `400 connector-not-on-agent`. Every key's namespace must be one of that connector's `toolNamespaces`, else `400 tool-not-on-connector`. Tool names must be unique, else `400 duplicate-tool-name`. `putGrant` `'no-link'` → `404 not-linked`. Answers `{ grant }` |
| `POST ungrant {appId, connectorId}` | manager | The link must be to this agent. `deleteGrant` false → `404 not-found` |
| `POST revoke {appId, connectorId}` | the viewer | `deleteApproval(caller, p, appId, connectorId, agentId)`. False → `404 not-found` |
| `GET approval/:platformId/:appId/:connectorId` | any signed-in person | `404 not-found` unless the platform id is the configured one, the app is linked, and the connector's grant is in `viewer` mode. Candidates: `agents:list-for-user { userId: caller }` (no `teamIds`: personal agents only) whose effective set contains the connector. Answers `ApprovalPrompt` (`tools` = the grant's tool names; `approvedAgentId` = the existing approval's agent or null) |
| `POST approval/… {agentId}` | any signed-in person | The same 404 rules. `agentId` must be one of the candidates, else `400 agent-not-eligible`. `putApproval({ viewerUserId: caller, …, agentId, toolKeys: grant.toolKeys })`; `'no-grant'` → `404 not-found`. Answers `{}` |

- [ ] **Step 1: Write the failing tests.** A stubbed `http:register-route` captures each `{ method, path, handler, bypassCsrf, maxBodyBytes }` and the tests call handlers directly; `auth:require-user` returns the test's chosen actor; agents and connectors are fakes on the bus; the store is the fake store.

```ts
it('every agent route: 401 signed out; one 404 for unknown, invisible and malformed agents');
it('GET: enabled false with the bridge off; POSTs answer 409 bridge-off');
it('GET: links with grants and names, and only the caller\'s own approvals on this agent');
it('rights come from agents:can-manage-connectors asked as a non-admin');   // stub records actor.isAdmin === false although require-user says isAdmin: true
it('link: 403 without manage rights; creates; a taken app id is 409 app-already-linked');   // Review Focus 2 (route side)
it('link: an unknown body key or a non-DNS-label app id is 400 invalid-body');
it('grant: refuses a connector off the agent, a key under another connector, duplicate names, an app linked elsewhere');
it('unlink and ungrant: managers only; an app linked to another agent is 404 not-linked');
it('revoke: removes only the caller\'s own approval on this agent');
it('approval GET: 404 unless linked and granted in viewer mode; lists only the caller\'s personal agents that have the connector');
it('approval POST: an ineligible agent is 400 agent-not-eligible; a good choice stores the grant\'s tool keys');
it('no settings route bypasses CSRF, and every POST is capped at 16 KiB');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/apps-bridge test src/__tests__/settings-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `user-auth.ts`, `settings-routes.ts` and the plugin registration. Hook failures other than the access misses named above answer `503 unavailable`, logged code-only (`loggableCode`). Add stubs for the five new `calls` to the `services` of the Task 4 cleanup test and the Task 7 plugin test, so both still boot.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ax/apps-bridge build && DOCKER_HOST=<your socket> pnpm --filter @ax/apps-bridge test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/apps-bridge
git commit -m "feat(apps-bridge): settings routes to link apps and grant connectors, and the viewer's approval"
```

---

### Task 9: Wire `@ax/apps-bridge` into the k8s preset (and so the memory preset) [tier: integration]

**Files:**
- Modify: `presets/k8s/src/index.ts`:
  - import `createAppsBridgePlugin`, `parseAppsBridgeEnv`, `AppsBridgeDeployConfig`;
  - `K8sPresetConfig.appsBridge?: AppsBridgeDeployConfig`, documented like `contentOrigin`;
  - push after channel-slack, as block `10c`: `createAppsBridgePlugin({ publicOrigin: presetPublicOrigin(config), ...(config.appsBridge !== undefined ? { bridge: config.appsBridge } : {}) })`;
  - in `loadK8sConfigFromEnv`, read each `env.AX_APPS_BRIDGE_*` literally (the env-shape scan needs literal reads in this file) into `parseAppsBridgeEnv({ …, bindHost: httpHost })`, beside the content-origin block (~line 1978);
  - the env doc comment block (~lines 1676-1713).
- Modify: `presets/k8s/package.json` (`"@ax/apps-bridge": "workspace:*"`), `presets/k8s/tsconfig.json` (reference), `pnpm-lock.yaml` (the `link:` entry under `presets/k8s`)
- Modify (tests):
  - `presets/k8s/src/__tests__/preset.test.ts`:
    - add `'@ax/apps-bridge'` to the expected production plugin set (~lines 307-368);
    - a manifest pin in the shape of channel-slack's (~line 1287);
    - `loadK8sConfigFromEnv` cases in the `describe` at ~line 1963.
  - Add `'@ax/apps-bridge'` to the drop lists in `acceptance.test.ts` (`PLUGINS_TO_DROP`, ~lines 130-308), `multi-tenant-acceptance.test.ts` (~112-237), `usage-limits-acceptance.test.ts` (~81-135) and `disk-quota-acceptance.test.ts` (~84-140). Give each a one-line reason: it needs Postgres, and it mounts routes those tests pin.
  - `prod-bootstrap.test.ts`: `REQUIRED_PROD_PLUGINS` (~207-263), and a `to_regclass` probe for each of the three tables beside channel-slack's (~360-365).
- Create: `.changeset/apps-connector-bridge.md` (`@ax/apps-bridge`, `@ax/apps-bridge-contract` and `@ax/mcp-client`: minor; `@ax/preset-k8s`, `@ax/test-harness` and `@ax/channel-web`: patch)

**Interfaces:**
- Consumes: Task 7's `createAppsBridgePlugin`, `AppsBridgeDeployConfig`, `parseAppsBridgeEnv`.
- Produces: `K8sPresetConfig.appsBridge` (consumed by Task 11's canary config).

- [ ] **Step 1: Write the failing preset tests**

```ts
it('loads @ax/apps-bridge: no hooks of its own, every call satisfied');
// registers toEqual([]); calls toEqual(the exact list from Tasks 4, 7 and 8, in manifest order); subscribes ['agents:deleted','connectors:deleted']
it('the bridge is off unless AX_APPS_BRIDGE_PLATFORM_ID is set');        // loadK8sConfigFromEnv(baseEnv).appsBridge === undefined
it('a full AX_APPS_BRIDGE_* set becomes appsBridge, bound on AX_HTTP_HOST');
it('a partial AX_APPS_BRIDGE_* set fails the boot config, naming the missing variable');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/preset-k8s test src/__tests__/preset.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the wiring. Run `pnpm install`, then `pnpm install --frozen-lockfile`.

- [ ] **Step 4: Run the whole preset suite** (a new default-on plugin breaks every preset-booting test whose drop list misses it)

Run: `pnpm --filter @ax/preset-k8s build && DOCKER_HOST=<your socket> pnpm --filter @ax/preset-k8s test && pnpm --filter @ax/preset-memory test src/__tests__/boot-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add presets/k8s pnpm-lock.yaml .changeset/apps-connector-bridge.md
git commit -m "feat(preset-k8s): load @ax/apps-bridge; AX_APPS_BRIDGE_* turns the bridge on"
```

---

### Task 10: Helm chart — env, port, Service, NetworkPolicy, docs [tier: sensitive]

`security-checklist`: required (admits outside traffic to the host pod).

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml`:
  - `host.ports.appsBridge: 9092` and `host.appsBridgeServicePort: 9092`, beside `content`;
  - a commented `appsBridge:` block: `enabled: false`, `platformId: ""`, `caller.{issuer,jwksUrl,audience,subject}: ""`, `viewer.{issuer,jwksUrl,audience}: ""`, `viewer.maxAgeSeconds: 600`, `allowFrom: []` (NetworkPolicy peers, rendered verbatim).
- Modify: `deploy/charts/ax-next/values.schema.json` (`appsBridge.enabled` typed `boolean`)
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`. Under `{{- if (include "ax-next.bool" .Values.appsBridge.enabled) }}`:
  - the ten env vars `AX_APPS_BRIDGE_PLATFORM_ID`, `_PORT`, `_CALLER_ISSUER`, `_CALLER_JWKS_URL`, `_CALLER_AUDIENCE`, `_CALLER_SUBJECT`, `_VIEWER_ISSUER`, `_VIEWER_JWKS_URL`, `_VIEWER_AUDIENCE`, `_VIEWER_MAX_AGE_SECONDS`;
  - the container port `apps-bridge`.
- Modify: `templates/host/service.yaml` (port `apps-bridge`, when enabled)
- Modify: `templates/networkpolicies/agent-runtime-network.yaml`. When enabled, add an ingress rule for the bridge port from the host's own namespace plus each `appsBridge.allowFrom` peer. The bridge port is NOT added to the LB health-check rule.
- Modify: `templates/_helpers.tpl`. Two changes:
  - a fail-with-`--set` guard: enabled with any required value blank fails the render;
  - a bullet in the `validateHostReplicas` comment (~382-404): the bridge's rate limits and in-flight counts are in memory.
- Do not touch: `templates/host/ingress.yaml`. The bridge never goes on the Ingress.
- Modify: `deploy/GKE.md`. A short "Apps connector bridge (optional)" section covering:
  - what it is;
  - the values to set;
  - that it stays off the Ingress, and exposure is the operator's: an internal LoadBalancer Service selecting the host pod, plus `appsBridge.allowFrom` for its source ranges;
  - that the caller token's audience and subject come from the platform's workload identity.
- Test: `deploy/charts/ax-next/__tests__/render.test.ts` (a block in the shape of the connector-directory one, ~1499-1538)

- [ ] **Step 1: Write the failing render tests**

```ts
it('apps bridge off by default: no AX_APPS_BRIDGE_* env, no apps-bridge port anywhere');
it('apps bridge on: stamps all ten vars verbatim, the container port, the Service port and the NetworkPolicy rule with allowFrom');
it('apps bridge on with a blank required value fails the render and names the --set key');   // e.g. appsBridge.caller.subject
it('the Ingress never targets the apps-bridge port');
```

- [ ] **Step 2: Run to verify they fail**

Run: `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test __tests__/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the chart changes and the GKE.md section.

- [ ] **Step 4: Run the chart suite**

Run: `AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test`
Expected: PASS. `env-shape.test.ts` passes with no edit: every `env.AX_APPS_BRIDGE_*` read in `presets/k8s/src/index.ts` is stamped by `deployment.yaml`.

- [ ] **Step 5: Commit**

```bash
git add deploy
git commit -m "feat(chart): optional apps bridge — env, port, Service and a NetworkPolicy allow-list; never on the Ingress"
```

---

### Task 11: Canary reach and the end-to-end composition test [tier: integration]

**Files:**
- Modify: `presets/memory/src/__tests__/canary.test.ts`:
  - start a `startFakeOidcIssuer()` for the caller and one for the viewer;
  - add `appsBridge: { platformId: 'canary-apps', host: '127.0.0.1', port: 0, caller: {…}, viewer: {…} }` to the boot config (~lines 271-318);
  - a `describe('apps bridge (invariant 3)')` block in the shape of the Slack one (~743-968).
- Create: `presets/k8s/src/__tests__/apps-bridge-composition.test.ts`. Copy the setup of `channel-slack-composition.test.ts` (a KEEP set from `createK8sPlugins` on one Postgres) and the connector seeding of `connector-delete-composition.test.ts` (`connectors:upsert`, `credentials:set` at agent scope).

**Interfaces:**
- Consumes: everything above. The composition test replaces the preset's `@ax/mcp-client` with `createMcpClientPlugin({ connectorToolInventory: true, connectorCallServerToolWithContent: fake })`, the one transport seam, and says so in its header. The fake records `{ url, headers, tool, input }` and answers `{ outcome: 'succeeded', content: [{ type: 'text', text: 'ENG-1 open' }] }`.
- Both tests read the bridge's port from the booted plugin's `bridgeBoundPort()`, the way the canary reads `httpPlugin.boundPort()` (~lines 339-346), and call it with the global `fetch`.
- Don't copy the Slack composition's `vi.stubGlobal('fetch', () => { throw … })` (~line 824) as it is: `jose` fetches the fake issuers' JWKS over loopback with the global `fetch`. If you want the guard, let `http://127.0.0.1:` URLs through to the real `fetch`.

- [ ] **Step 1: Write the canary block (reachability through the real preset, Postgres and http-server)**

```ts
it('settings routes are mounted: 401 signed out, 404 for an unknown agent, CSRF still enforced on POST');
it('approve route is mounted: 404 for an app that is not linked');
it('the bridge listener answers 401 with no token and with a token from an unknown key');
it('a valid platform token reaches the store: unknown app is 404 app_not_linked');   // GET …/apps/expenses/grants
```

- [ ] **Step 2: Write the composition scenario**

KEEP: `@ax/database-postgres`, `@ax/storage-postgres`, `@ax/credentials`, `@ax/credentials-store-db`, `@ax/agents`, `@ax/teams`, `@ax/connectors`, `@ax/tool-policy`, `@ax/apps-bridge`, plus the replaced mcp-client.

Stubs: `http:register-route` (capture the handlers), `auth:require-user` (the test picks the actor), `auth:get-user`, `auth:find-user-by-email` (`viewer@example.com` → the viewer), and whatever else the boot names as missing. List every stub in the header.

Seed:
- an admin upserts connector `linear` (one http server, an `allowedHosts` entry, an api-key slot);
- the builder's personal agent and the viewer's personal agent each get it attached, plus an agent-scope key;
- tool policy is Allow for `list_issues` on both agents (`tool-policy:set-connector-defaults` as the admin, `tool-policy:set-agent-override` per agent).

```ts
it('builder: link, grant, call — the connector gets the builder agent\'s key and the exact input, and the platform gets the content');
it('a tool the agent asks first about is approval_required, and nothing is sent');
it('viewer: approval required with the approve link; the viewer approves; the call uses the viewer agent\'s key');
it('GET grants lists the connector by name, its mode and its tool names');
it('unlink makes the app app_not_linked; deleting the viewer\'s agent removes their approval');
```

- [ ] **Step 3: Run both** (they should pass at once: Tasks 1–10 built everything they touch. A failure here is a wiring bug in those tasks; fix it there.)

Run: `DOCKER_HOST=<your socket> pnpm --filter @ax/preset-memory test src/__tests__/canary.test.ts && DOCKER_HOST=<your socket> pnpm --filter @ax/preset-k8s test src/__tests__/apps-bridge-composition.test.ts`
Expected: PASS.

- [ ] **Step 4: Prove the canary sees the plugin**

Remove `createAppsBridgePlugin` from the k8s push temporarily. Expected: the canary block and the composition test go red. Restore with `git checkout -- presets/k8s/src/index.ts`, and leave the tree clean.

- [ ] **Step 5: Commit**

```bash
git add presets/memory/src/__tests__/canary.test.ts presets/k8s/src/__tests__/apps-bridge-composition.test.ts
git commit -m "test(apps-bridge): canary reach and an end-to-end platform call through the real preset"
```

---

### Task 12: channel-web — the Apps section in agent settings [tier: integration]

Invoke the `shadcn` skill first. Optional: `ux-design` for the copy.

**Files:**
- Create: `packages/channel-web/src/lib/agent-apps.ts`. Shape it like `lib/agent-slack.ts`: `httpFetch`, `x-requested-with: ax-admin` on writes, every answer parsed with `@ax/apps-bridge-contract` schemas, and a 404 or non-JSON answer meaning "unavailable".
- Create: `packages/channel-web/src/components/workspace/AgentApps.tsx`, and `AppGrantEditor.tsx` if `AgentApps.tsx` passes ~300 lines
- Modify: `packages/channel-web/src/lib/workspace-route.ts` (`'apps'` right after `'slack'` in `AGENT_SETTINGS_SECTIONS`, ~36-44)
- Modify: `packages/channel-web/src/components/workspace/AgentSettings.tsx` (a `SETTINGS_SECTIONS.apps` entry with lucide `AppWindow` and a `SectionBody` case)
- Modify: `packages/channel-web/package.json` (`"@ax/apps-bridge-contract": "workspace:*"`) and `tsconfig.json` (reference), `pnpm-lock.yaml`
- Test: `src/lib/__tests__/agent-apps.test.ts`, `src/components/workspace/__tests__/AgentApps.test.tsx`. Update `AgentSettings.test.tsx` (nav order ~90-107, count ~200, `vi.mock('@/lib/agent-apps', …)`) and `src/lib/__tests__/workspace-route.test.ts`.

**Interfaces:**
- Consumes: Task 8's routes. Existing hooks: `useAgentConnectors(agentId)` (`lib/agent-connectors.ts:68`) for the connector list and `manageable`, and `useConnectorTools(agentId, connectorId)` (`lib/agent-connector-tools.ts:113`) for tools. Each tool's `verdict` is already the effective verdict (`workspace-types.ts:1253-1266`).
- Produces: `fetchAgentApps(agentId): Promise<AgentAppsRead | 'unavailable'>`, `linkApp`, `unlinkApp`, `saveGrant`, `removeGrant` and `revokeApproval` (each resolving to the parsed answer or throwing `AgentAppsError { code }`), and `fetchApprovalPrompt` and `approveApp` (used by Task 13).

What the section shows (shadcn `Card`, `Button`, `Dialog`, `Field`/`FieldGroup`, `Input`, `RadioGroup`, `Checkbox`, `Badge`, `Alert`, `Empty`, `Skeleton`; semantic tokens only):
- **Bridge off:** an `Empty` that says the apps platform isn't set up on this AX. No controls.
- **Apps that use this agent:** one row per link, with its grants (connector name, a mode `Badge`, tool names). For managers: Link an app, Edit, Remove grant, Unlink (confirmed). Non-managers see the list read-only.
- **Link dialog:** an App id `Input`, checked against `APP_ID_RE` before any request. `409` → "Another agent already uses this app id."
- **Grant editor:**
  - a connector `Select` from `useAgentConnectors`;
  - a mode `RadioGroup`: "This agent's sign-in", or "Each viewer's own sign-in, after they say yes";
  - one tool `Checkbox` per `useConnectorTools` tool. Only tools whose `verdict === 'allow'` can be ticked. The rest say why: "Asks first, so apps can't use it. Set it to Allow under Connectors." (Plan vs. reality 5.)
  - A granted tool the connector no longer lists is marked "No longer offered".
- **Apps using this agent's sign-ins as you:** the caller's own approvals, each with Revoke.

- [ ] **Step 1: Write the failing tests**

```ts
// agent-apps.test.ts
it('fetchAgentApps GETs /settings/apps/<id> and parses the answer');
it('a 404 or a non-JSON answer is unavailable');
it('writes send x-requested-with: ax-admin and a JSON body; error bodies become codes');
// AgentApps.test.tsx — vi.mock('@/lib/agent-apps') and the two connector hooks
it('bridge off: an honest empty state and no controls');
it('lists linked apps with each grant\'s connector, mode and tools');
it('a person who cannot manage sees the list read-only');
it('Link refuses a malformed app id before any request, and shows the taken-id message on 409');
it('only Allow tools can be granted; Ask first and Deny tools say why');
it('a granted tool the connector no longer offers is marked');
it('shows only the person\'s own approvals, each with Revoke');
it('uses no raw colours');   // copy the guard in src/components/credentials/__tests__/ConnectorAccessNotice.test.tsx (~47-55)
// AgentSettings.test.tsx / workspace-route.test.ts
it('settings sections include apps right after slack');                 // update the pinned order and count
it('/workspace/agents/a1/settings/apps round-trips');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-web test src/lib/__tests__/agent-apps.test.ts src/components/workspace/__tests__/AgentApps.test.tsx src/components/workspace/__tests__/AgentSettings.test.tsx src/lib/__tests__/workspace-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, plus the repo-wide channel-web scanners**

Run: `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`
Expected: PASS, including `spinner-convention.test.ts`, `vocabulary.test.ts`, `connector-access-coverage.test.ts` and `workspace/__tests__/no-fixtures.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web pnpm-lock.yaml
git commit -m "feat(channel-web): Apps in agent settings — link apps, grant connectors, revoke your approvals"
```

---

### Task 13: channel-web — the standalone approve page [tier: sensitive]

`security-checklist`: required (changes the sign-in return allowlist, an open-redirect guard). Invoke the `shadcn` skill first.

**Files:**
- Create: `packages/channel-web/src/lib/apps-approve-route.ts` (`parseAppsApproveRoute(pathname)` wraps the contract's `parseApprovePagePath`)
- Create: `packages/channel-web/src/components/AppsApprovePage.tsx` (copy the frame of `SharedArtifactPage.tsx`: `min-h-screen bg-background`, `Skeleton` while loading, `Empty` for not found)
- Modify: `packages/channel-web/src/App.tsx`. Parse the route once, as `parseShareRoute` is (~line 96), and branch next to the share page (~256-277), before `WorkspaceShell`: signed out → `<LoginPage/>`; signed in → `<ErrorBoundary><AppsApprovePage …/></ErrorBoundary>` with no workspace.
- Modify: `packages/channel-web/src/lib/auth.ts` (~90-91): `const callbackURL = parseShareRoute(callbackPath) || parseAppsApproveRoute(callbackPath) ? callbackPath : '/';`, and the doc comment above it.
- Test: `src/lib/__tests__/apps-approve-route.test.ts`, `src/components/__tests__/AppsApprovePage.test.tsx`; additions to `src/__tests__/auth-signInWithGoogle.test.ts` and `src/__tests__/auth-gate.test.tsx`

**Interfaces:**
- Consumes: Task 12's `fetchApprovalPrompt(platformId, appId, connectorId)` and `approveApp(platformId, appId, connectorId, agentId)`; Task 3's `parseApprovePagePath`.

The page:
- `Card` headline: "**{appId}** wants to use {connectorName} as you".
- "It will be able to use:" and the tool names.
- An agent `RadioGroup`, pre-selected when there is one candidate or an existing choice. Allow stays disabled until an agent is chosen.
- Allow / Not now. Not now goes to `/workspace`.
- Done: "Done. You can close this tab and go back to the app."
- No candidates: "None of your agents has {connectorName} yet. Add it to one of your agents, then open this link again." No Allow.
- 404: a plain not-found `Empty`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps-approve-route.test.ts
it('parses /apps/approve/<p>/<a>/<c> exactly and nothing else');      // query, trailing slash, extra segment, bad id → null
// auth-signInWithGoogle.test.ts
it('an approve page path comes back after sign-in; anything else still lands on /');   // '/apps/approve/canopy/expenses/linear' kept; '/apps/approve/x' → '/'
// auth-gate.test.tsx
it('an approve link signed out shows the login page; signed in shows the approve page and no workspace');
// AppsApprovePage.test.tsx
it('says "<appId> wants to use <connector> as you" and lists the tools');
it('one eligible agent is pre-selected; with several, Allow waits for a choice');
it('no eligible agent explains how to get one and offers no Allow');
it('Allow sends the chosen agent with the CSRF header, then shows done');
it('a 404 shows a plain not-found state');
it('uses no raw colours');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ax/channel-web test src/lib/__tests__/apps-approve-route.test.ts src/components/__tests__/AppsApprovePage.test.tsx src/__tests__/auth-signInWithGoogle.test.ts src/__tests__/auth-gate.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ax/channel-web build && pnpm --filter @ax/channel-web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/channel-web
git commit -m "feat(channel-web): the apps approve page, reachable through sign-in"
```

---

### Task 14: Docs — the spec's contract and the architecture doc [tier: mechanical]

**Files:**
- Modify: `docs/superpowers/specs/2026-11-21-apps-connector-bridge-design.md`:
  - "Contract v1 (wire)" (~lines 62-98): the status per code; `invalid_request` and `unavailable`; `tool_not_allowed` also meaning a denied tool; `viewerAssertion` strict to viewer mode; the id grammars; the path-only `approveUrl`; `Retry-After`; "use a client timeout of at least 60 s"; "never retry a write on `unknown`"; the schema module `packages/apps-bridge-contract/src/wire.ts`.
  - "Viewer approvals" (~line 47): the tool snapshot.
  - "Design": viewer mode uses the viewer's personal agents; link rights are asked as a non-admin.
  - "Left to the builder" (~lines 116-120): resolved, pointing at this plan's "Builder calls" table.
- Modify: `docs/plans/2026-05-24-current-architecture.md`:
  - `:126` "One host-side exception (TASK-1046)" → two exceptions. The second is `@ax/apps-bridge` making connector calls for an external apps platform through `connectors:call-tool-result`.
  - `:129` the credentials row names that hook too.
  - Add a row for the bridge's external entry point: its own listener, OIDC caller, `apps_bridge_v1_*`.

- [ ] **Step 1: Make the edits.**

- [ ] **Step 2: Check them.** Run `grep -n "One host-side exception" docs/plans/2026-05-24-current-architecture.md`. Expected: no match. Run `grep -n "invalid_request\|unavailable" docs/superpowers/specs/2026-11-21-apps-connector-bridge-design.md`. Expected: the new rows. The table values equal `REFUSAL_STATUS` in `wire.ts`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-21-apps-connector-bridge-design.md docs/plans/2026-05-24-current-architecture.md
git commit -m "docs: the apps bridge contract as built, and the architecture doc's second host-side connector path"
```

---

### Task 15: Security review, boundary review, full gate, PR [tier: sensitive]

**Files:** none new (the PR description).

- [ ] **Step 1: Invoke the `security-checklist` skill over the whole branch** (`git diff origin/main...HEAD`). Answer every item, and give a reason for every N/A. The three threat models, each with at least these facts:
  - **Sandbox escape:** no IPC action and no `tool:execute:*`. `connectors:call-tool-result` is a named host service no runner can reach. The new listener is host-side, off the Ingress, and admitted by NetworkPolicy only from the host namespace and `appsBridge.allowFrom`.
  - **Prompt injection / untrusted content:**
    - `input` is forwarded byte-faithfully and never interpreted.
    - `content` is upstream data relayed to the platform and never shown to a model by AX.
    - Platform strings are grammar-checked before logging.
    - Approve-page names are server-supplied, rendered as text.
  - **Supply chain:** `jose@6.2.8` exact, zero dependencies, already in the lockfile, no install script. No other new dependency.
  - **Credentials:** never leave AX. Only `content` on success. Logs are code-only.
  - **Residuals, named:**
    - app-id squatting (first to link wins);
    - replay of a viewer assertion within its max age (accepted by the spec);
    - any host plugin can call `connectors:call-tool-result` (as with `connectors:call-tool`);
    - a viewer's agent's tool policy can differ from the builder's, so an approved app can still meet `approval_required`;
    - a connector server rename orphans grant tool keys (fails closed: `not-connected`; re-grant).
  Paste the note into the PR description as `## Security review`.

- [ ] **Step 2: Boundary review in the PR description** for `connectors:call-tool-result`, with the four answers from Task 2's `types.ts` block. State that `@ax/apps-bridge` registers no service hook. Its HTTP wire lives in `@ax/apps-bridge-contract`. Validation and dispatch live with `@ax/apps-bridge`. The bridge translates wire `{ tool }` to hook `{ toolKey }` through the grant's stored keys.

- [ ] **Step 3: Full gate**

Run: `pnpm build && DOCKER_HOST=<your socket> pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts && pnpm lint && AX_REQUIRE_HELM=1 pnpm --filter @ax/chart-tests test`
Expected: all PASS (`@ax/auth-better`'s Docker teardown timeout with every assertion passing is the known local artifact; re-run that package alone to confirm).

- [ ] **Step 4: Open the PR.** It carries the security note, the boundary review, this plan's "Plan vs. reality" list, and the open questions from the decisions shard. File a `(walk)` card for a kind walk of the Apps section and the approve page, driven by a scripted fake platform. Name it in the PR.

---

## Follow-ups (not in this plan)

- A 200 health path on the bridge listener, if an operator fronts it with an L7 load balancer.
- Retargeting grant tool keys on `connectors:tool-namespaces-changed` (today a server rename fails closed until re-granted).
- Telling a viewer on the approve page which granted tools their chosen agent would still ask about.
