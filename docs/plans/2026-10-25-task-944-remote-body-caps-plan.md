# TASK-944 "Cap remote response bodies" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three places that read a remote server's response body with no byte limit — `@ax/mcp-oauth` sign-in (`safeFetch`), `@ax/llm-openrouter` completions, and the AI-SDK runner's connector MCP traffic — stop reading as soon as a per-place cap is passed and fail with a plain error. In the runner, a body under the cap also can no longer blow up into hundreds of MB of zod issues.

**Architecture:** A new `@ax/core/response-cap` subpath holds one helper, `capResponseBody(res, limit, { onOversize })`. It rejects a declared `Content-Length` over the limit before reading, and otherwise counts the bytes as they stream, so a lying or missing `Content-Length`, or a gzip body, cannot get past it. Each place wraps its responses with it and its own cap. The runner also scopes each MCP operation with `AsyncLocalStorage`, so an over-cap event-stream answer aborts its own call at once (the MCP SDK would otherwise wait out the 5-minute call timeout). It also validates `tools/call` results with the SDK's loose `ResultSchema` instead of `CallToolResultSchema`, because its zod 4.6.7 has no issue cap.

**Tech Stack:** TypeScript 6, Node 24 (host, runner image and tests), web streams (`TransformStream`, `Response`), `node:async_hooks` `AsyncLocalStorage`, `@modelcontextprotocol/sdk` 1.32.1 (host copy on the patched zod 3.25.76, runner copy on zod 4.6.7), `undici` 6.29.1 (the runner's proxy fetch), vitest 5.

**Spec:** the TASK-944 card (`/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/TASK-944/card.md`), the Design section below, and `.claude/memory/decisions/2026-10-25-TASK-944.md` (read it before Task 1; every number marked MEASURED is from there, measured at 4718946da on node 24.19.0). Background: `.claude/memory/decisions/2026-10-23-TASK-938.md` and Appendix C of `docs/plans/2026-10-23-task-938-zod3-issue-bound-plan.md`.

## Global Constraints

- **Worktree:** every command runs in `/Users/vpulim/dev/ai/ax-next/.claude/worktrees/agent-abee8deaf4b2e902a`. Base is origin/main 4718946da. Building in parallel with TASK-945 (`.max()` on untrusted zod arrays; it may edit `packages/llm-openrouter/src/translate.ts`, which this plan does not touch) and TASK-957. If either merges first and touches these files, rebase and re-run the affected suites.
- **The caps, verbatim.** `@ax/mcp-oauth`: `MAX_OAUTH_RESPONSE_BYTES = 64 * 1024`. `@ax/llm-openrouter`: `COMPLETION_MAX_BYTES = 4 * 1024 * 1024`, `ERROR_BODY_MAX_BYTES = 64 * 1024`. Runner: `MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024` for `tools/call` answers, `MAX_CONNECTOR_RESPONSE_BYTES = 2 * 1024 * 1024` for everything else. Each constant's comment says why (copy the reason from the decisions shard's "Caps" row).
- **The error, verbatim.** `ResponseTooLargeError` (a plain `Error`, never a `TypeError`), `name === 'ResponseTooLargeError'`, `limit` = the cap, message `the response was larger than <size>, so we stopped reading it`, where `<size>` is `N MiB`, `N KiB` or `N bytes` (the largest unit that divides the limit exactly). It names only the cap: no URL, no header, no body bytes.
- **No new dependencies.** The only manifest change is a new `./response-cap` entry in `packages/core/package.json` `exports`. `pnpm-lock.yaml` must not change. `@ax/core/response-cap` is a subpath export only, not re-exported from the `@ax/core` root (the `@ax/core/surface-text` pattern).
- **Build before consumer tests.** Consumers resolve `@ax/core/response-cap` through `packages/core/dist`. After Task 1, run `pnpm --filter @ax/core build`. A `Failed to resolve import "@ax/core/response-cap"` error means core is not built.
- **Single-file test runs:** `pnpm --filter @ax/<pkg> exec vitest run <path relative to the package>`. `--filter` goes before the script. vitest tolerates type errors, so finish each task with `pnpm --filter @ax/<pkg> build`, which runs tsc.
- **Typecheck traps:** `exactOptionalPropertyTypes` is on (pass `{}` rather than `{ onOversize: undefined }`), and `noUncheckedIndexedAccess` is on.
- **No Docker for Tasks 1–5.** `@ax/mcp-oauth`'s `plugin.test.ts`, `store.test.ts`, `e2e.test.ts`, `admin-client-secret.e2e.test.ts`, `client-secret-ref.e2e.test.ts` and `dcr-client-binding.e2e.test.ts` start Postgres, so run them in the final gate. If OrbStack hangs (`DOCKER_HOST=unix:///Users/vpulim/.orbstack/run/docker.sock timeout 15 docker info`; check `pmset -g log` for sleep first, and don't restart it), use the local stand-in on localhost:55439 (config `/private/tmp/claude-501/-Users-vpulim-dev-ai-ax-next/386b12a8-02d6-45fd-a50d-1e78eb04cac6/scratchpad/pg/vitest.local-pg.config.mjs`), drop every database you create, and name each skipped suite in the handoff.
- **Memory:** shards only. Append build rows to `.claude/memory/decisions/2026-10-25-TASK-944.md`. Never touch a root `.claude/memory/*.md`, and never add a `Memory-Rewrite:` trailer. `scripts/__tests__/memory-cited-paths-exist.test.js` stays red until this plan file is committed (the shard cites it), so commit the plan and shard first.
- **Voice:** these comments and messages are about real resource-exhaustion risks. Keep them plain and direct, with no jokes.

## Design

**What was wrong.** Each place hands `fetch`'s `Response` to something that reads the whole body (`response.json()` / `.text()`, inside the MCP SDK or our own code), then validates it with zod. A hostile, compromised or broken server can send gigabytes, or a small gzip body that inflates to gigabytes. The host (1Gi pod by default, 2Gi on GKE) or the runner (1Gi, `packages/sandbox-k8s/src/config.ts`) then has to hold all of it.

**The existing pattern.** `capBody` in `packages/mcp-client/src/connector-inventory/safe-fetch.ts:179-205` (the host inventory's 2 MiB per `tools/list` page) does exactly the right thing, and `packages/llm-openrouter/src/__tests__/models-available.test.ts:33-48` is the test shape that proves "stopped reading" (a `highWaterMark: 0` stream that counts pulls and records `cancel`). Invariant 2 forbids importing mcp-client from the other packages, so the helper moves to `@ax/core`, which all three already depend on. The older local copies stay as they are (follow-up).

**Per place:**

| Place | Where the body is read | Cap | Failure the caller sees |
|---|---|---|---|
| `@ax/mcp-oauth` | `safeFetch` (`packages/mcp-oauth/src/ssrf.ts`) returns every response the MCP SDK's discovery, client-registration, token-exchange and refresh helpers read, including error bodies (`parseErrorResponse` reads `.text()`). | 64 KiB, the same constant the authoring preview (`host-discovery.ts`) already uses for the same documents | The SDK rejects with `ResponseTooLargeError`. The routes already log only `err.name` and show a fixed sentence, and the refresh resolver treats it as transient, so the stored token is kept. |
| `@ax/llm-openrouter` | `postCompletion` (`res.json()`), and `describeFailure` (an error body's `res.json()`) | 4 MiB per completion, 64 KiB per error body | `PluginError{code:'unknown'}` with message `OpenRouter API call failed: the response was larger than 4 MiB, so we stopped reading it`, and no retry. An oversize error body falls back to the status line, as unreadable bodies already do. |
| Runner connector MCP (`connector-tools.ts`) | The SDK's streamable-HTTP transport, through the fetch the runner hands it. Every answer passes through that one fetch. | 8 MiB per `tools/call` answer, 2 MiB per other answer | Call: `connector tool '<name>' failed: the response was larger than 8 MiB, so we stopped reading it`, immediately. Connect or list: the connector is dropped with one log line quoting the same sentence (2 MiB). |

**Two runner facts that change the shape of the fix (MEASURED):**

1. *An event-stream answer never fails its request.* When the cap errors a `text/event-stream` body (the SDK server's default framing, and what the in-process test server sends), the SDK reports the stream error to `onerror` and leaves the request pending until its timeout. In a probe that was "MCP error -32001: Request timed out" after 4 s; in production it is 300 s. A JSON answer fails in 4 ms. So the runner runs each operation inside an `AsyncLocalStorage` scope that carries the cap and an `onOversize` callback. For a tool call, the callback aborts that call's own `AbortController`, which the SDK turns into an immediate rejection. In the probe, both framings then failed in 4 ms. The SDK gives `fetch` no per-request signal, so the async context is the only link from an answer back to its call.
2. *A body under the cap can still exhaust memory.* The runner's SDK uses zod 4.6.7, which has no issue cap: a 400 KB `tools/call` body of junk content elements keeps 306 MB of issues, and reading the error's `message` builds a 224 MB string. An 8 MiB junk body under a 1 GiB heap is a heap OOM. So `tools/call` results are validated with the SDK's loose `ResultSchema` (8 MiB junk: +40 MB, 20 ms), `renderMcpResult` checks field types itself, and `errText` never reads a zod error's `message`. Without that, a 2 MiB junk `tools/list` page reached RSS 1.44 GB; with it, 700 MB.

**Refuted or corrected from the card:** "the zod patch caps the issue list" does not hold for place 3 (zod 4.6.7). Place 2 is the host plugin, which reads one JSON body with its own `fetch`. The runner's streamed OpenRouter turns go through the AI SDK and are out of scope. "Needs an image rebuild to check on kind" is true but not needed: the tests below run a real HTTP MCP server through the production-shaped undici v6 fetch.

**Out of scope (follow-up cards, in the decisions shard):** the runner's `tools/list` still parses through the SDK schema (about 376 MB of heap at worst under its new 2 MiB cap); the host inventory reports an over-cap event-stream page as `timeout`; `@ax/llm-anthropic`'s SDK reads completions uncapped; the runner's model stream has no per-event cap; migrating the older local copies.

**One PR.** Task-scoped commits, squash-merged as one. The core helper must ship with its consumers (half-wired policy).

## Review Focus

1. **A small `Content-Length` with a large body.** Over real HTTP this is a gzip body: `Content-Length` is the compressed size (MEASURED 16,329 bytes for 16 MiB), so only the streaming count can catch it. Pinned in Task 2 (`safeFetch`) and Task 4 (runner).
2. **An over-cap answer framed as an event stream.** It must fail the call at once, not after the call timeout. Pinned in Task 4, with both the global fetch and undici v6.
3. **An over-cap error that the MCP SDK would read as a CORS failure.** `fetchWithCorsRetry` swallows a `TypeError` thrown by `fetch` and moves on. Pinned in Task 1 (never a `TypeError`) and Task 2 (an over-cap protected-resource document fails discovery as `ResponseTooLargeError`).
4. **Junk under the cap.** Thousands of content elements of the wrong type must not become thousands of zod issues in the runner. Pinned in Task 5.
5. **Hostile part shapes now reach the renderer.** A `type` or `uri` that is an object whose `toString` is not callable must not throw. Pinned in Task 5.

---

### Task 1: `@ax/core/response-cap` [tier: sensitive]

Needs `security-checklist` (untrusted remote content; shared security primitive).

**Files:**
- Create: `packages/core/src/response-cap.ts`
- Modify: `packages/core/package.json` (`exports`: add `"./response-cap": { "types": "./dist/response-cap.d.ts", "default": "./dist/response-cap.js" }` after `./error-codes`)
- Test: `packages/core/src/__tests__/response-cap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (import from `@ax/core/response-cap`):
  ```ts
  export class ResponseTooLargeError extends Error {
    readonly limit: number;            // the cap, in bytes
    constructor(limit: number);        // sets name = 'ResponseTooLargeError'
  }
  export interface CapResponseBodyOptions {
    /** Called once, synchronously, when the cap is passed, before the error
     *  reaches the body's reader. A throw from it is swallowed. */
    onOversize?: (err: ResponseTooLargeError) => void;
  }
  export function capResponseBody(res: Response, limit: number, opts?: CapResponseBodyOptions): Response;
  ```

The test file and Tasks 2–4 use this helper. Copy it into each test file that needs it; packages don't share test code.

```ts
/** `total` bytes in `chunk`-byte pieces; records how far a reader pulled. */
function counted(total: number, chunk: number) {
  const stats = { pulled: 0, cancelled: false, reason: undefined as unknown };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (stats.pulled * chunk >= total) return controller.close();
        stats.pulled += 1;
        controller.enqueue(new Uint8Array(chunk).fill(0x61));
      },
      cancel(reason) {
        stats.cancelled = true;
        stats.reason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stats };
}
```

- [ ] **Step 1: Write the failing tests** in `packages/core/src/__tests__/response-cap.test.ts`, with `const LIMIT = 64 * 1024` and `const CHUNK = 4 * 1024`:
  - `passes a body at the cap, or under it, through whole`: `counted(LIMIT, CHUNK)` → `(await capResponseBody(new Response(stream), LIMIT).arrayBuffer()).byteLength === LIMIT`, `stats.cancelled === false`. And `capResponseBody(new Response(new Uint8Array(LIMIT - 1)), LIMIT)` reads `LIMIT - 1` bytes.
  - `errors the body as soon as it streams past the cap, and stops pulling`: `counted(16 * LIMIT, CHUNK)`, no `Content-Length` → `.text()` rejects with an error that `toBeInstanceOf(ResponseTooLargeError)` and `toMatchObject({ name: 'ResponseTooLargeError', limit: LIMIT })`; `stats.pulled <= LIMIT / CHUNK + 2`; `stats.cancelled === true`; `stats.reason` is that same error class.
  - `counts what streams, not what Content-Length claims`: the same body with `headers: { 'content-length': '10' }` → `.text()` rejects with `ResponseTooLargeError`.
  - `refuses a declared Content-Length over the cap before reading a byte`: `headers: { 'content-length': String(LIMIT + 1) }` → `expect(() => capResponseBody(res, LIMIT)).toThrow(ResponseTooLargeError)`, `stats.pulled === 0`, and, after `await new Promise((r) => setTimeout(r, 0))`, `stats.cancelled === true`.
  - `tells onOversize once, before the reader sees the error, on both paths`: a `vi.fn` records calls and pushes `'callback'` into an `order` array; the reader's catch pushes `'reader'`. Streaming path: `order` equals `['callback', 'reader']`, the callback is called once, and its argument `toBe` the rejection. Declared-length path: called once, with the thrown error.
  - `a throwing onOversize does not hide the cap`: `onOversize: () => { throw new Error('observer broke') }` → `.text()` still rejects with `ResponseTooLargeError`.
  - `returns a bodiless response as it is`: `const r = new Response(null, { status: 204 })` → `capResponseBody(r, LIMIT)` `toBe(r)`.
  - `keeps status, statusText and headers`: `new Response('ok', { status: 418, statusText: 'Teapot', headers: { 'x-a': '1' } })` → the wrapped response has `status 418`, `statusText 'Teapot'`, header `x-a` = `'1'`, and text `'ok'`.
  - `a reader's cancel reaches the source`: `await capResponseBody(new Response(stream), LIMIT).body!.cancel()` → `stats.cancelled === true`.
  - `ResponseTooLargeError is a plain named Error with a readable size`: `new ResponseTooLargeError(64 * 1024)` is `instanceof Error`, **not** `instanceof TypeError`, has `name 'ResponseTooLargeError'` and `limit 65536`, and message `'the response was larger than 64 KiB, so we stopped reading it'`. Messages for `2 * 1024 * 1024`, `4 * 1024 * 1024` and `8 * 1024 * 1024` say `2 MiB`, `4 MiB` and `8 MiB`; `1000` says `1000 bytes`.
  - `rejects a limit that would disable the cap`: for each of `NaN`, `-1`, `1.5` and `Infinity`, `capResponseBody(new Response('x'), limit)` throws `RangeError`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/core exec vitest run src/__tests__/response-cap.test.ts`
  Expected: FAIL, `Cannot find module '../response-cap.js'` (or a failed import).

- [ ] **Step 3: Implement `packages/core/src/response-cap.ts` and add the `exports` entry.**
  - Order of checks: validate `limit` (a non-negative safe integer, else `RangeError`; a `NaN` limit would silently disable `seen > limit`). Then the declared length: `Number(res.headers.get('content-length') ?? Number.NaN)`; if it is finite and `> limit`, call `onOversize`, `void res.body?.cancel(err).catch(() => {})`, and throw. Then `res.body === null` → return `res` itself. Otherwise pipe the body through a counting `TransformStream`, the same shape as `capBody` in `packages/mcp-client/src/connector-inventory/safe-fetch.ts:179-205`. On the chunk that takes the running total past `limit`, call `onOversize`, then `controller.error(err)`, and never enqueue that chunk. Return `new Response(counted, { status, statusText, headers })`.
  - Call `onOversize` in a `try { … } catch {}`.
  - The file imports nothing; web globals only, like `surface-text.ts`.
  - Header comment, plain and short: why (three places read remote bodies whole; give the MEASURED runner numbers); what is counted (bytes as the body yields them, after any `Content-Encoding` is undone, so a small, absent or lying `Content-Length` can't get past, and neither can a gzip body; the declared-length check only saves a read); what it is not (no time limit; the wrapped `Response` loses `url`, `redirected` and `type`, which nothing that calls it reads).

- [ ] **Step 4: Run the tests and build.**
  Run: `pnpm --filter @ax/core exec vitest run src/__tests__/response-cap.test.ts` → PASS (11 tests).
  Run: `pnpm --filter @ax/core build` → exit 0, and `packages/core/dist/response-cap.js` exists.

- [ ] **Step 5: Commit.**
  `git add packages/core/src/response-cap.ts packages/core/src/__tests__/response-cap.test.ts packages/core/package.json`
  `git commit -m "feat(core): response-cap cuts a remote body at a byte limit while it streams (TASK-944)"`

---

### Task 2: `@ax/mcp-oauth` caps every OAuth response at 64 KiB [tier: sensitive]

Needs `security-checklist` (SSRF-guarded fetch of untrusted third-party metadata and tokens).

**Files:**
- Modify: `packages/mcp-oauth/src/ssrf.ts:91-144` (constant, the two `return res` sites in `safeFetch`, a doc paragraph)
- Modify: `packages/mcp-oauth/src/host-discovery.ts:7-9,67` (use the shared constant; delete `MAX_METADATA_BYTES`)
- Test: `packages/mcp-oauth/src/__tests__/ssrf.test.ts`, `packages/mcp-oauth/src/__tests__/oauth-flow.test.ts`

**Interfaces:**
- Consumes: `capResponseBody`, `ResponseTooLargeError` (Task 1).
- Produces: `export const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;` in `ssrf.ts`.

- [ ] **Step 1: Write the failing tests.**
  In `ssrf.test.ts`, add `describe('safeFetch response size cap')`, using `counted` from Task 1, `const CAP = MAX_OAUTH_RESPONSE_BYTES`, `const allow = new Set(['good.example.com'])`, and `const resolver = async () => '93.184.216.34'`. `doFetch` is a stub returning the given `Response`. The URL is `https://good.example.com/x`.
  - `stops reading a body that streams past 64 KiB`: `counted(4 * CAP, 4096)` with no length → `(await safeFetch(url, allow, undefined, resolver, doFetch)).text()` rejects `toMatchObject({ name: 'ResponseTooLargeError', limit: CAP })`; `stats.pulled <= CAP / 4096 + 2`; `stats.cancelled`.
  - `refuses a declared Content-Length over 64 KiB before reading`: `content-length: String(CAP + 1)` → `safeFetch(...)` itself rejects `ResponseTooLargeError`; `stats.pulled === 0`.
  - `caps the redirect it does not follow, too`: status 302 with no `location`, over-cap body → `.text()` rejects `ResponseTooLargeError`.
  - `reads a body one byte under 64 KiB whole`: `(await res.text()).length === CAP - 1`.
  - `catches a gzip body whose Content-Length is small` (real HTTP): an in-process `createServer` answers with `gzipSync(Buffer.alloc(4 * CAP, 0x20))`, `content-encoding: gzip`, `content-length` = the gzip length and `content-type: application/json`. `doFetch` maps the URL onto it the way `localFetch` does in the existing redirect `describe` (`fetch(\`http://127.0.0.1:${port}${path}\`, init)`). Then `Number(res.headers.get('content-length')) < CAP`, and `res.text()` rejects with `ResponseTooLargeError`.

  In `oauth-flow.test.ts`, add `describe('response size cap through the MCP SDK')` with `afterEach(() => vi.unstubAllGlobals())`. Reuse the file's `resolver`, `allow` and `meta` fixtures, and add hosts to a local `Set` where a test needs them. Each test stubs the global `fetch` with `vi.stubGlobal('fetch', vi.fn(async (input) => …))` (`safeFetch` defaults to it):
  - `an over-cap protected-resource document fails discovery as ResponseTooLargeError, not as missing metadata`: the resource URL `https://mcp.example.com/mcp` answers `new Response(null, { status: 401 })`; any URL containing `/.well-known/oauth-protected-resource` answers 200 with `content-length: String(CAP + 1)` and an over-cap body. Then `discover({ resourceUrl, allowedHosts: new Set(['mcp.example.com']), resolver })` rejects `toMatchObject({ name: 'ResponseTooLargeError' })`. This is the throw that `fetchWithCorsRetry` would swallow if it were a `TypeError`.
  - `an over-cap token response fails redeemCode`: 200 with a streamed `counted(4 * CAP, 4096)` body and no length → `redeemCode({...as in the existing 'returns the token response's id_token' test})` rejects `toMatchObject({ name: 'ResponseTooLargeError' })`; `stats.pulled <= CAP / 4096 + 2`.
  - `an over-cap token error body fails redeemCode`: status 400 with the same streamed body (the SDK's `parseErrorResponse` reads `.text()`) → rejects `toMatchObject({ name: 'ResponseTooLargeError' })`.
  - `a token response one byte under 64 KiB still redeems`: `JSON.stringify({ access_token: 'a'.repeat(n), token_type: 'Bearer' })`, with `n` chosen so its byte length is `CAP - 1` → resolves, with `access_token.length === n`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/mcp-oauth exec vitest run src/__tests__/ssrf.test.ts src/__tests__/oauth-flow.test.ts`
  Expected: the new tests FAIL: the reads succeed, and the import of `MAX_OAUTH_RESPONSE_BYTES` is undefined. The existing tests stay green.

- [ ] **Step 3: Implement.**
  - `ssrf.ts`: `import { capResponseBody } from '@ax/core/response-cap';`. Add `export const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;` with its reason (decisions shard "Caps" row: few-KB documents, header-bounded tokens, the same limit the preview has applied to the same documents since 2026-10-01). Both `return res` sites in `safeFetch` (line 136, the 3xx without a `Location`, and line 143) become `return capResponseBody(res, MAX_OAUTH_RESPONSE_BYTES)`. Intermediate redirect hops are never read, so they are left alone.
  - Add a paragraph to `safeFetch`'s doc comment: every response it returns is capped at 64 KiB while it streams; over the cap the reader gets `ResponseTooLargeError` (deliberately not a `TypeError`, which the SDK's discovery would mistake for a CORS failure).
  - `host-discovery.ts`: import `MAX_OAUTH_RESPONSE_BYTES` with the existing `./ssrf.js` import, delete line 9, and use it at line 67. Same value, one constant.

- [ ] **Step 4: Run the tests and build.**
  Run: `pnpm --filter @ax/mcp-oauth exec vitest run src/__tests__/ssrf.test.ts src/__tests__/oauth-flow.test.ts src/__tests__/host-discovery.test.ts src/__tests__/identity.test.ts src/__tests__/resolver.test.ts src/__tests__/routes.test.ts` → PASS.
  Run: `pnpm --filter @ax/mcp-oauth build` → exit 0.

- [ ] **Step 5: Commit.**
  `git add packages/mcp-oauth/src/ssrf.ts packages/mcp-oauth/src/host-discovery.ts packages/mcp-oauth/src/__tests__/ssrf.test.ts packages/mcp-oauth/src/__tests__/oauth-flow.test.ts`
  `git commit -m "fix(mcp-oauth): stop reading an OAuth sign-in response past 64 KiB (TASK-944)"`

---

### Task 3: `@ax/llm-openrouter` caps completions at 4 MiB and error bodies at 64 KiB [tier: sensitive]

Needs `security-checklist` (untrusted remote LLM API bodies on the host).

**Files:**
- Modify: `packages/llm-openrouter/src/plugin.ts:125-140` (constants beside `TRANSIENT_STATUSES`), `:457` (`postCompletion`), `:470-480` (`describeFailure`)
- Modify: `packages/llm-openrouter/SECURITY.md` ("Untrusted input", the paragraph that ends "we shape-check it with zod")
- Test: `packages/llm-openrouter/src/__tests__/llm-call.test.ts`

**Interfaces:**
- Consumes: `capResponseBody` (Task 1).
- Produces: `export const COMPLETION_MAX_BYTES = 4 * 1024 * 1024;` and `export const ERROR_BODY_MAX_BYTES = 64 * 1024;` from `plugin.ts`.

- [ ] **Step 1: Write the failing tests.** Add `describe('@ax/llm-openrouter response size cap')` to `llm-call.test.ts`, using the file's `boot`, `CTX` and `INPUT`. Its `fetchImpl` returns the test's `Response` and counts calls.
  - `stops reading a completion past 4 MiB, says why, and does not retry`: status 200, `counted(4 * COMPLETION_MAX_BYTES, 64 * 1024)` → `bus.call('llm:call:openrouter', CTX, INPUT)` rejects `toBeInstanceOf(PluginError)` with message exactly `'OpenRouter API call failed: the response was larger than 4 MiB, so we stopped reading it'`; fetch called once; `stats.pulled <= 66`; `stats.cancelled`.
  - `refuses a declared Content-Length over 4 MiB without reading`: the same with `content-length: String(COMPLETION_MAX_BYTES + 1)` → same message; `stats.pulled === 0`.
  - `accepts a completion one byte under 4 MiB`: the file's `completion({ choices: [{ index: 0, message: { role: 'assistant', content: 'a'.repeat(n) }, finish_reason: 'stop' }] })` serialized, with `n` chosen so `Buffer.byteLength(body) === COMPLETION_MAX_BYTES - 1` → resolves with `text.length === n`.
  - `reads at most 64 KiB of an error body, then reports the status`: status 400 with `counted(1024 * 1024, 4096)` → rejects with a message matching `/^OpenRouter API call failed: HTTP 400/`; fetch called once; `stats.pulled <= 18`; `stats.cancelled`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/llm-openrouter exec vitest run src/__tests__/llm-call.test.ts`
  Expected: the four new tests FAIL (the bodies are read whole; the constants are not exported yet).

- [ ] **Step 3: Implement.**
  - `import { capResponseBody } from '@ax/core/response-cap';`. Add the two constants with their reasons from the decisions shard.
  - `postCompletion` line 457: `fromChatCompletionsBody(await capResponseBody(res, COMPLETION_MAX_BYTES).json(), …)`. The oversize error then takes the existing path in `callWithRetry`: it has no `status`, so it is not retried, and it is wrapped as `PluginError{code:'unknown'}` with the error as `cause`.
  - `describeFailure`: `const body: unknown = await capResponseBody(res, ERROR_BODY_MAX_BYTES).json();` inside the existing `try`. Update the catch comment to "Not JSON, too big, or the stream died."
  - `SECURITY.md`: add after "we shape-check it with zod…": we also stop reading at 4 MiB for a completion and 64 KiB for an error body, counted as the bytes arrive, so a runaway or hostile response can't make the host hold it.

- [ ] **Step 4: Run the tests and build.**
  Run: `pnpm --filter @ax/llm-openrouter test` → PASS, including `models-available.test.ts` (untouched).
  Run: `pnpm --filter @ax/llm-openrouter build` → exit 0.

- [ ] **Step 5: Commit.**
  `git add packages/llm-openrouter/src/plugin.ts packages/llm-openrouter/SECURITY.md packages/llm-openrouter/src/__tests__/llm-call.test.ts`
  `git commit -m "fix(llm-openrouter): stop reading a completion past 4 MiB and an error body past 64 KiB (TASK-944)"`

---

### Task 4: Runner caps every connector MCP answer and fails the operation at once [tier: sensitive]

Needs `security-checklist` (sandbox side; untrusted third-party MCP servers; async-context and abort races).

**Files:**
- Create: `packages/agent-aisdk-runner/src/tools/connector-fetch.ts`
- Modify: `packages/agent-aisdk-runner/src/tools/connector-tools.ts` (header comment, `newConnection` :157, `reconnect` :176, `connectAndList` :201, `connectConnectorTools` :244, the tool `execute` :309-363)
- Modify: `packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts` (raw answers)
- Test: `packages/agent-aisdk-runner/src/__tests__/connector-fetch.test.ts` (new), `packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `capResponseBody`, `ResponseTooLargeError` (Task 1).
- Produces (`connector-fetch.ts`):
  ```ts
  export const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024;
  export const MAX_CONNECTOR_RESPONSE_BYTES = 2 * 1024 * 1024;
  export interface ResponseScope {
    /** Byte cap for every answer read while this scope is active. */
    readonly maxBytes: number;
    onOversize(err: ResponseTooLargeError): void;
  }
  /** Run `fn` with `scope` as the active scope (AsyncLocalStorage). */
  export function withResponseScope<T>(scope: ResponseScope, fn: () => Promise<T>): Promise<T>;
  /** Wrap `base` (undefined = the global fetch, looked up per request, as the
   *  SDK does) so every answer is capped at the active scope's maxBytes,
   *  or MAX_CONNECTOR_RESPONSE_BYTES with no scope, and an oversize answer
   *  is reported to the scope that was active when fetch was called. */
  export function capConnectorFetch(base: typeof fetch | undefined): typeof fetch;
  ```
- Produces (`mcp-test-server.ts`): option `raw?: { method: string; headers: Record<string, string>; chunks: (id: unknown) => Iterable<string | Buffer> }`. A POST whose JSON-RPC `method` matches is answered with status 200, `headers`, and the chunks (written with backpressure; it stops when the client hangs up). `McpTestServer` gains `rawBytesWritten(): number`, the bytes handed to `res.write` for raw answers.

- [ ] **Step 0: Extend `mcp-test-server.ts` first**, so the tests below fail for the right reason. Add the `raw` option and `rawBytesWritten()` from the Interfaces block. Parse the POST body for the JSON-RPC `id` and `method`, as the helper already does. Count each chunk before `res.write`. On `false`, wait for `'drain'` or `'close'`, whichever comes first, and stop once the response is destroyed. `end()` after the last chunk. Existing tests must not change behaviour: no `raw` means no change.

- [ ] **Step 1: Write the failing unit tests** in `connector-fetch.test.ts`, with a fake base fetch that returns `new Response(counted(...).stream, …)` (copy `counted` from Task 1):
  - `outside any scope an answer is cut at 2 MiB`: `counted(4 * MAX_CONNECTOR_RESPONSE_BYTES, 64 * 1024)` → `.text()` rejects `toMatchObject({ name: 'ResponseTooLargeError', limit: MAX_CONNECTOR_RESPONSE_BYTES })`; `stats.pulled <= 34`.
  - `inside a scope, the scope's cap applies and onOversize gets the reader's error`: `withResponseScope({ maxBytes: 1024, onOversize: spy }, () => capped('https://x.example/mcp'))`, then `.text()` rejects with `ResponseTooLargeError`, `limit 1024`; `spy` is called once with that same error object.
  - `the innermost scope wins`: an outer scope of 1 MiB and an inner scope of 1 KiB → the inner spy fires, the outer one does not, and `limit === 1024`.
  - `a declared Content-Length over the cap reports and throws before reading`: `content-length: String(1025)` under a 1 KiB scope → the `capped(...)` promise rejects; spy called once; `stats.pulled === 0`.
  - `an undefined base means the global fetch, looked up per request`: create `capConnectorFetch(undefined)` first, then `vi.stubGlobal('fetch', stub)`, then call it → `stub` was called. `afterEach(() => vi.unstubAllGlobals())`.

- [ ] **Step 2: Write the failing integration tests.** Add `describe('connectConnectorTools — response size cap (TASK-944)')` to `connector-tools.test.ts`, using `connect` and `testServer` from the file. `const BIG = 64 * 1024 * 1024`, and `piece = Buffer.alloc(64 * 1024, 0x61)`. An SSE body is `` `event: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"content":[{"type":"text","text":"` ``, then `BIG / piece.length` pieces, then `'"}]}}\n\n'`. A JSON body is the same without the `event:`/`data:` prefix and the trailing blank line. Each server is `testServer([{ name: 'big' }], { raw: { … } })`; only the named method gets the raw answer, so `initialize` and `tools/list` behave normally unless a test names them.
  - `an over-cap tools/call answer framed as an event stream fails at once with a plain error`: `raw: { method: 'tools/call', headers: { 'content-type': 'text/event-stream' }, chunks: sse }`, and `connect(…, { callTimeoutMs: 25_000 })` → `exec(ct, \`mcp__${NS}__big\`, {})` rejects with message exactly `"connector tool 'big' failed: the response was larger than 8 MiB, so we stopped reading it"`, in under 10,000 ms. After the rejection, `s.rawBytesWritten() < 40 * 1024 * 1024`: the server stopped well short of the 64 MiB it meant to send. The 25 s timeout and the 10 s bound are what tell "failed at once" apart from "waited out the timeout"; keep both.
  - `… framed as JSON with no Content-Length fails the same way`: `content-type: application/json`, JSON body → same message, under 10,000 ms.
  - `… gzip with a small Content-Length fails the same way`: `headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gz.length) }`, with `chunks` yielding one `gz = gzipSync(<a JSON-RPC result whose text is 16 MiB of 'a'>)` → same message.
  - `the production-shaped fetch (undici 6) is capped the same way`: the SSE case with `connect(…, { fetch: undiciFetch as unknown as typeof fetch, callTimeoutMs: 25_000 })` (`import { fetch as undiciFetch } from 'undici'`, the runner's own dependency, which is what `createProxyFetch` builds on) → same message, under 10,000 ms.
  - `an answer just under 8 MiB still works`: the normal tool handler returns `{ content: [{ type: 'text', text: 'a'.repeat(MAX_TOOL_RESULT_BYTES - 64 * 1024) }] }` → resolves to a string ending in `'[output truncated at 100 KB]'`.
  - `a tools/list page over 2 MiB drops the connector at once, with one plain log line`: `raw: { method: 'tools/list', headers: { 'content-type': 'text/event-stream' }, … }` whose event is a valid `tools/list` result with one tool, `{"name":"big","inputSchema":{"type":"object"},"description":"<8 MiB of a>"}` (so without the cap the connector would load), and `connect(…, { connectTimeoutMs: 25_000 })` → `ct.tools` is `{}`, it took under 10,000 ms, and the only log line for this server is exactly `` `${NS}: could not load this connector's tools: "the response was larger than 2 MiB, so we stopped reading it"` ``.
  - `a tools/list page just under 2 MiB loads`: 30 tools, each with a `64 * 1024 - 2048` character description → `Object.keys(ct.tools)` has length 30.

- [ ] **Step 3: Run them and see them fail.**
  Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/connector-fetch.test.ts src/__tests__/connector-tools.test.ts`
  Expected: `connector-fetch.test.ts` fails to import. The over-cap integration tests FAIL because the call resolves (the 64 MiB body is read whole), and the list test loads the connector. The two just-under tests may already pass.

- [ ] **Step 4: Implement `connector-fetch.ts`** (one module-level `AsyncLocalStorage<ResponseScope>`; read the store before awaiting `base`; pass `{ onOversize }` only when a scope is active, because of `exactOptionalPropertyTypes`).

- [ ] **Step 5: Wire it into `connector-tools.ts`.**
  - `connectConnectorTools` builds `const capped = capConnectorFetch(opts.fetch)` once, and passes `capped` wherever `opts.fetch` went today: `connectAndList`, `reconnect`, and through them `newConnection`, which now always sets the transport's `fetch`.
  - `connectAndList` and `reconnect` run their work inside `withResponseScope({ maxBytes: MAX_CONNECTOR_RESPONSE_BYTES, onOversize })`. `onOversize` aborts their existing `ac` with the error, unless the function has already returned or thrown. Set a `settled` flag in `finally`, because the server's long-lived event stream opens during connect, inherits that scope, and must not abort a finished connect. `raceAbort` then rejects with the error, and the existing log line quotes it.
  - Tool `execute`: per call, `const callAc = new AbortController()` and `signal = ctx.abortSignal !== undefined ? AbortSignal.any([ctx.abortSignal, callAc.signal]) : callAc.signal`. Pass `signal` to `callTool` instead of `ctx.abortSignal`, and keep Stop working exactly as today. `call(client)` becomes `withResponseScope(scope, () => client.callTool(…))`, where the scope's `maxBytes` is `MAX_TOOL_RESULT_BYTES` and its `onOversize` records the first error in `tooLarge` and calls `callAc.abort(err)`, unless the call has settled. In the outer `catch`, keep the Stop branch first, then `if (tooLarge !== undefined) throw new Error(\`connector tool '${toolName}' failed: ${tooLarge.message}\`)`, then the existing clipped message. The session-lost `renew` stays outside the call scope; `reconnect` sets its own.
  - Add a "Response size (TASK-944)" paragraph to the header comment: the two caps and why; that the count is of bytes as they arrive; that an over-cap answer fails its call or connect at once (the SDK would otherwise wait out the timeout on an event stream); that the result is never parsed.

- [ ] **Step 6: Run the tests and build.**
  Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/connector-fetch.test.ts src/__tests__/connector-tools.test.ts` → PASS. This includes the existing TASK-839 session-loss tests, `aborts an in-flight call on Stop`, and the two huge-error-body clipping tests.
  Run: `pnpm --filter @ax/agent-aisdk-runner test` → PASS (`node-floor.test.ts` too; `node:async_hooks` and `AbortSignal.any` predate the image's Node 24).
  Run: `pnpm --filter @ax/agent-aisdk-runner build` → exit 0.

- [ ] **Step 7: Commit.**
  `git add packages/agent-aisdk-runner/src/tools/connector-fetch.ts packages/agent-aisdk-runner/src/tools/connector-tools.ts packages/agent-aisdk-runner/src/__tests__/helpers/mcp-test-server.ts packages/agent-aisdk-runner/src/__tests__/connector-fetch.test.ts packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts`
  `git commit -m "fix(agent-aisdk-runner): cap connector MCP answers (8 MiB tools/call, 2 MiB otherwise) and fail the call at once (TASK-944)"`

---

### Task 5: Runner parses `tools/call` results without zod amplification [tier: sensitive]

Needs `security-checklist` (untrusted tool output now reaches the renderer unvalidated).

**Files:**
- Modify: `packages/agent-aisdk-runner/src/tools/connector-tools.ts` (`errText` :121, the `callTool` call :325, a `TOOL_RESULT_SCHEMA` constant)
- Modify: `packages/agent-aisdk-runner/src/tools/mcp-result.ts:15-32` (`renderPart`)
- Modify: `patches/zod@3.25.76.md` ("Not covered here", the zod 4.6.7 bullet)
- Test: `packages/agent-aisdk-runner/src/__tests__/mcp-result.test.ts`, `packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts`

**Interfaces:**
- Consumes: the `raw` test-server option (Task 4).
- Produces: nothing new outside the files.

- [ ] **Step 1: Write the failing tests.**
  - `mcp-result.test.ts`, `renders hostile part shapes without throwing`: `renderMcpResult({ content: [{ type: { toString: 1 } }, { type: 'resource', resource: { uri: { toString: 1 } } }, { type: 'resource_link', uri: 7 }, { type: 'image', mimeType: { toString: 1 } }, { type: 'text', text: 'ok' }] })` returns `'[resource omitted]\n[resource omitted]\n[image omitted]\nok'`. A part whose `type` is not a string is dropped. The existing tests keep their exact outputs.
  - `connector-tools.test.ts`, in the Task 4 `describe`:
    - `a tools/call result is not checked against the SDK content schema`: `raw: { method: 'tools/call', headers: { 'content-type': 'application/json' }, chunks: (id) => [JSON.stringify({ jsonrpc: '2.0', id, result: { content: Array(20_000).fill(0) } })] }` → `exec` resolves to `''`. (Before: it rejects with 20,000 zod issues.)
    - `a tools/list that fails validation logs a count, never zod's text`: `raw` for `tools/list`, with `result: { tools: Array(20_000).fill(0) }` → `ct.tools` is `{}`, and the one log line for this server contains `not valid MCP (20000 problems)` and does not contain `invalid_type`.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm --filter @ax/agent-aisdk-runner exec vitest run src/__tests__/mcp-result.test.ts src/__tests__/connector-tools.test.ts`
  Expected: the three new tests FAIL. The hostile-shape test throws `TypeError: Cannot convert object to primitive value`, the content test rejects, and the list log quotes zod's issue text.

- [ ] **Step 3: Implement.**
  - `connector-tools.ts`: `import { ResultSchema, type CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';` and `const TOOL_RESULT_SCHEMA = ResultSchema as unknown as typeof CallToolResultSchema;`. Comment it with the MEASURED reason: zod 4.6.7 in this SDK copy has no issue cap, so 400 KB of junk content keeps 306 MB and an 8 MiB body is a heap OOM in 1 GiB; under `ResultSchema` the same 8 MiB peaks at +40 MB; `renderMcpResult` checks every field itself. Pass it as `callTool`'s second argument. `callTool` itself stays, because it still runs the tool's output-schema check and the task-required guard.
  - `errText`: if `err` is an object with an `issues` array (any zod error, v3 or v4), return `` `the server's answer was not valid MCP (${issues.length} problems)` `` without touching `message`. zod builds `message` from every issue on first read: MEASURED 177 MB for a 2 MiB junk `tools/list` page.
  - `mcp-result.ts`: a part whose `type` is not a string renders as nothing. `text` and `resource.text` are used only when they are strings. A `uri` or `mimeType` that is not a string is left out: `[resource omitted]`, `[image omitted]`. No `String(…)` on a server-supplied value.
  - `patches/zod@3.25.76.md`, replacing the zod 4.6.7 bullet under "Not covered here": zod 4.6.7 keeps upstream behaviour. It comes in through `ai`, `@ai-sdk/*`, better-auth and the AI-SDK runner's MCP SDK. Since TASK-944, the runner validates `tools/call` results with the SDK's loose `ResultSchema` and caps every connector answer (8 MiB for `tools/call`, 2 MiB otherwise). Its `tools/list` pages still go through the SDK's schema, bounded only by that 2 MiB cap (about 376 MB of heap at worst).

- [ ] **Step 4: Run the tests and build.**
  Run: `pnpm --filter @ax/agent-aisdk-runner test` → PASS.
  Run: `pnpm --filter @ax/agent-aisdk-runner build` → exit 0.

- [ ] **Step 5: Commit.**
  `git add packages/agent-aisdk-runner/src/tools/connector-tools.ts packages/agent-aisdk-runner/src/tools/mcp-result.ts patches/zod@3.25.76.md packages/agent-aisdk-runner/src/__tests__/mcp-result.test.ts packages/agent-aisdk-runner/src/__tests__/connector-tools.test.ts`
  `git commit -m "fix(agent-aisdk-runner): parse tools/call results loosely so the byte cap bounds memory (TASK-944)"`

---

## Before the PR

- [ ] **Full gate** (the order and both flags matter; see CLAUDE.md):
  `pnpm build && pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts`, then `pnpm lint`.
  Core changed, so every package is affected and CI runs the whole suite. Name any Docker-backed suite you could not run (the `@ax/mcp-oauth` list in Global Constraints, plus any others) in the handoff; CI's postgres:16 run is the gate. A different canary timing out on a "wait for row" poll gets reported, not given a longer timeout.
- [ ] **`pnpm-lock.yaml` unchanged:** `git diff --stat origin/main -- pnpm-lock.yaml` prints nothing.
- [ ] **PR description** includes:
  - The caps table from the Design section, and each cap's reason.
  - "Departures from the card": the zod 4.6.7 finding (MEASURED numbers), the event-stream hang (MEASURED), place 2 being the host plugin, and no kind walk.
  - Residuals and follow-ups (the decisions shard's out-of-scope row).
  - Boundary review: N/A. No service or subscriber hook changed. `@ax/core/response-cap` is a function export, not a hook, and `llm:call:openrouter` throws no new error code.
  - The security note. The planner walked the `security-checklist` threat models for this design and wrote the note below. Invoke the skill again on the finished diff, and change a line only if the code departs from the plan:
    ```
    ## Security review
    - Sandbox: No new reach. No filesystem, process or env change; network destinations are unchanged (mcp-oauth's allowlist checked per hop, OpenRouter's fixed base URL, runner connectors through the credential proxy). Narrows resource reach: each remote body is cut while it streams at 64 KiB (OAuth), 4 MiB / 64 KiB (OpenRouter completion / error), 8 MiB / 2 MiB (connector tools/call / other), counting bytes after decoding so a small, absent or lying Content-Length or a gzip body cannot get past.
    - Injection: Handles untrusted bodies from OAuth servers, OpenRouter and third-party MCP connectors. Each cap fails before parsing; every oversize error is our own fixed sentence naming only the cap (no upstream bytes, URLs or tokens), and mcp-oauth still logs error names only. The runner now renders tools/call results without the SDK's content schema; renderMcpResult type-checks every field (no String() on server objects), output stays text-only and capped at 100 KB, and a zod error's message, which can quote server-chosen keys, is never built.
    - Supply chain: N/A: no dependency added or changed; the only manifest edit is a new `./response-cap` entry in @ax/core's `exports`, pnpm-lock.yaml is untouched, and the runner uses node:async_hooks (built in) and the already-pinned MCP SDK 1.32.1's ResultSchema.
    ```
- [ ] **Memory:** append build decisions to `.claude/memory/decisions/2026-10-25-TASK-944.md`. If the scoped abort or the zod-message trap cost you time, add a patterns shard (`scripts/memory-write-target.sh --shard patterns TASK-944`).
