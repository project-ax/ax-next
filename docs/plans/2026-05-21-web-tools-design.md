# `@ax/web-tools` — design

**Date:** 2026-05-21
**Status:** Design approved; implementation plan pending.
**Author:** Vinay (with Claude)

## Goal

Give every agent two capabilities it lacks today:

- **`web_search`** — search the live web for a query and get back result hits.
- **`web_extract`** — turn a specific URL into readable text.

Both are exposed to the agent as tools. The agent never makes a network
request itself — the sandbox egress lock stays fully intact.

## Why not just re-enable the SDK built-ins

The Claude Agent SDK surfaces `WebSearch` / `WebFetch` as **client-side**
built-in tools. The runner deliberately lists them in `DISABLED_BUILTINS`
(`packages/agent-claude-sdk-runner/src/tool-names.ts`) because they egress
*from the locked sandbox*, bypassing the credential-proxy and the egress
policy. Re-enabling them would break invariant #5 (capabilities explicit and
minimized) and the whole "we're the secure one" posture. Not an option.

## Chosen approach: host-executed tools backed by Anthropic's *server-side* web tools

Two distinct mechanisms share the names "web search / web fetch":

1. The Agent SDK's **client-side** `WebSearch` / `WebFetch` built-ins —
   execute in the runner sandbox, egress directly. **Disabled.**
2. Anthropic's **server-side** `web_search` / `web_fetch` Messages-API tools —
   passed in the `tools` array of an `@anthropic-ai/sdk` call; Anthropic
   performs the search/fetch on its own infrastructure and streams results
   back. The client makes **zero** web requests.

The Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.2.119) exposes no clean knob
to inject the server-side tools into the agent's own `query()` loop, so we use
them the documented way: the **host** makes its own Messages call with the
tools enabled. That is exactly the existing host-executed-tool shape
(`executesIn: 'host'` → `tool.execute-host` IPC → `tool:execute:<name>`
service hook).

### Why this is the secure *and* simple pick

- **Zero SSRF surface for us.** Anthropic does all fetching. The host only
  ever POSTs to `api.anthropic.com` — already the trusted, allowlisted
  endpoint. No private-IP guards, no DNS-rebind defense, no HTML-extraction
  library to own and keep current.
- **No third-party dependency, no new credential.** Reuses the global host
  Anthropic key the system already manages (same source as `@ax/llm-anthropic`).
- **Exfil isolation.** The fetch runs in a *separate, minimal-context* host
  call whose context is only "fetch this URL" — never the agent's transcript
  or any secret. Anthropic's documented web_fetch exfil guardrail (only
  in-context URLs) stacks on top.
- **Stays inside existing machinery.** Reuses host-tool dispatch + the
  `tool.pre-call` permission/audit path. No new sandbox egress surface, no
  NetworkPolicy holes, no skill-install ceremony.

### Honest costs

- Web search bills **$10 / 1,000 searches** to the global account; web fetch
  has no per-fetch fee (token cost only).
- Each tool call is an extra host-side Messages round-trip (latency + a small
  amount of inner-call tokens).
- web_fetch cannot render JavaScript pages; supports text + PDF only.
- An org admin must enable web search once in the Claude Console.

## Architecture & data flow

```
agent (sandbox) → SDK tool call: web_search / web_extract
  → ax-host-tools MCP server → POST /tool.execute-host (host)
    → bus.call('tool:execute:web_search', ctx, input)        [@ax/web-tools]
      → @anthropic-ai/sdk messages.create({
            model, max_tokens,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
            messages: [{ role: 'user', content: <directive + query> }]
          })
        → Anthropic performs the search SERVER-SIDE
      ← harvest web_search_tool_result block
    ← { query, results: [{ title, url, age? }], summary? }
  ← tool output returns to the agent as UNTRUSTED text
```

`web_extract` is identical but uses `web_fetch_20250910` and injects the
agent-supplied URL into the inner call's user message (so it is "in context"
and web_fetch is permitted to fetch it). We harvest the `web_fetch_tool_result`
document text.

The host→`api.anthropic.com` call uses the host pod's existing 443 egress; the
credential-proxy is only for *sandbox* traffic (mirrors `@ax/llm-anthropic`).

## Components (`packages/web-tools/`)

| File | Responsibility |
| --- | --- |
| `src/plugin.ts` | `createWebToolsPlugin(cfg)` — manifest, `init()` wiring, `enabled` kill-switch. |
| `src/anthropic-client.ts` | Builds the SDK client; runs the server-tool call incl. a bounded `pause_turn` continuation loop; harvests result blocks. `clientFactory` test seam. |
| `src/tools/web-search.ts` | `WEB_SEARCH_DESCRIPTOR` + `tool:execute:web_search` executor. |
| `src/tools/web-extract.ts` | `WEB_EXTRACT_DESCRIPTOR` + `tool:execute:web_extract` executor. |
| `src/url-guard.ts` | Defense-in-depth URL validation for `web_extract`. |
| `src/*.test.ts` | Unit tests (see Testing). |

### Manifest

```ts
manifest: {
  name: '@ax/web-tools',
  version: '0.0.0',
  registers: ['tool:execute:web_search', 'tool:execute:web_extract'],
  calls: ['tool:register'],   // catalog registration at init
  subscribes: [],
}
```

No `credentials:get` — v1 uses the global host key, exactly like
`@ax/llm-anthropic`.

### Config

```ts
interface WebToolsConfig {
  /** Global Anthropic key. Falls back to process.env.ANTHROPIC_API_KEY.
   *  If `enabled` and no key resolves, init throws (footgun avoidance,
   *  mirrors @ax/llm-anthropic). */
  apiKey?: string;
  /** Inner-call model. Default 'claude-sonnet-4-6' (confirmed server-tool
   *  support; the $10/1k search fee dominates so model choice is minor). */
  model?: string;
  /** Operator kill-switch. When false, the plugin registers nothing and
   *  init never requires a key. Default true. */
  enabled?: boolean;
  /** Per-request timeout (ms) for the inner Messages call. */
  timeoutMs?: number;
  /** Cap on extracted content (web_fetch max_content_tokens). */
  maxContentTokens?: number;
  /** Test seam — stub Anthropic client. */
  clientFactory?: (apiKey: string) => Anthropic;
}
```

## Tool surfaces

### `web_search`

```jsonc
// descriptor
{ "name": "web_search", "executesIn": "host",
  "inputSchema": { "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"] } }
```

Output: `{ query: string, results: Array<{ title: string; url: string; age?: string }>, summary?: string }`.
Anthropic's `encrypted_content` (a multi-turn citation artifact) is **stripped**
— it is never exposed to the agent.

### `web_extract`

```jsonc
{ "name": "web_extract", "executesIn": "host",
  "inputSchema": { "type": "object",
    "properties": { "url": { "type": "string" } },
    "required": ["url"] } }
```

Output: `{ url: string, title?: string, text: string, truncated: boolean }`.
`truncated` is set when `maxContentTokens` clips the content. PDFs return
extracted text; JS-rendered pages are unsupported (documented limitation).

## Host-side call specifics

- **Tool versions:** GA `web_search_20250305` and `web_fetch_20250910`. The
  newer `_20260209` "dynamic filtering" versions require the code-execution
  tool to be enabled — out of scope.
- **`max_uses: 1`** per call bounds cost to one search / one fetch.
- **Directive prompt + small `max_tokens`** so the model reliably triggers
  exactly one server-tool use, then we read the structured result block rather
  than relying on the model's prose.
- **`pause_turn` handling:** continue the conversation until `end_turn` with a
  low max-iteration cap (defensive; a single search/fetch normally finishes in
  one turn).
- **Errors:** map Anthropic's in-body error blocks
  (`web_search_tool_result_error`, `web_fetch_tool_error` with codes like
  `max_uses_exceeded`, `url_not_accessible`, `unsupported_content_type`) to a
  clean tool error returned to the agent.

## Security

This plugin handles untrusted content (web pages), opens a network connection
(host → Anthropic), and uses a caller-provided URL — so the `security-checklist`
skill is run at PR time and its structured note attached. Summary of the three
threat models:

- **Prompt injection (primary).** Fetched web content is untrusted and flows
  into the agent's context. This is inherent to *any* web capability; the agent
  already treats tool output as untrusted and we never interpret it host-side.
  The inner call is isolated — its context is only the fetch directive, never
  the agent transcript or secrets — which contains Anthropic's documented
  web_fetch data-exfiltration risk.
- **SSRF / internal-URL.** Anthropic fetches server-side and cannot reach our
  cluster, but `url-guard` still rejects non-`http(s)` schemes and
  loopback / private / link-local / metadata (`169.254.169.254`) hosts before
  the call, as defense-in-depth.
- **Supply chain.** One dependency, `@anthropic-ai/sdk`, already present in the
  repo. No new third-party code.

## Availability

Registered in the catalog and available to **all agents by default**, subject
to the existing `tool.pre-call` permission gate and any per-agent `allowedTools`
restriction. The `enabled: false` config flag is a global operator kill-switch.

## Wiring & half-wired window

Per invariant #3 and the project's half-wired-window pattern, `@ax/web-tools`
is loaded in **both** the CLI preset and the k8s preset in the **same PR** as a
canary acceptance test that:

- asserts both tools appear in `tool.list`, and
- asserts `tool.execute-host` routes to each executor (Anthropic client stubbed
  via `clientFactory`, returning canned server-tool result blocks).

Real-API end-to-end verification is a `deploy/MANUAL-ACCEPTANCE.md` walk
(requires the Console web-search enablement). The PR description states the
half-wired window is CLOSED on merge.

## Boundary review

- **Alternate impl this hook could have:** the `tool:execute:web_search` /
  `tool:execute:web_extract` executors could instead be backed by a third-party
  provider (Tavily/Exa) or a self-hosted fetch+extract — the descriptor-in /
  JSON-out contract is backend-agnostic.
- **Payload field names that might leak:** none. Output fields (`results`,
  `url`, `title`, `text`, `summary`) are backend-neutral; the Anthropic-specific
  `encrypted_content` is stripped before return.
- **Subscriber risk:** none — these are request/response executor hooks with no
  subscribers keying off backend-specific fields.
- **New hook signatures:** none. Reuses the established `tool:register` +
  `tool:execute:<name>` convention; no boundary-review-triggering hook is added.

## Testing

Unit tests (Anthropic client stubbed via `clientFactory`):

- harvest `web_search_tool_result` → expected `results` shape; `encrypted_content` stripped.
- harvest `web_fetch_tool_result` document text → `text` + `truncated`.
- error-block mapping (`max_uses_exceeded`, `url_not_accessible`, etc.) → clean tool error.
- `pause_turn` continuation loop terminates and caps iterations.
- `url-guard` rejects `file:`/`http://localhost`/private/link-local/metadata; accepts public https.
- `enabled: false` registers neither descriptor nor executor.
- `enabled: true` with no resolvable key → init throws.

Plus the cross-plugin canary acceptance test in the wiring section.

## Out of scope (YAGNI)

- Per-user / per-agent key billing (v1 uses the global host key, like other
  host-side LLM features such as the memory observer and auto-titling).
- `allowed_domains` / `blocked_domains` policy knobs.
- Dynamic-filtering tool versions (would require enabling the code-execution tool).
- JavaScript rendering.
- Usage / cost metering events. (Could be added later as a subscriber hook if
  operators need per-agent search-spend visibility.)
