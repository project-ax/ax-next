# Security — `@ax/llm-anthropic`

This package registers the `llm:call` service hook, wrapping `@anthropic-ai/sdk` to send chat requests to `api.anthropic.com` and map the response back into the kernel's `LlmResponse` shape.

## Security review

- **Sandbox:** Network reach is HTTPS to a single destination (`api.anthropic.com`), chosen by the upstream SDK — not caller-influenced. The API key is read from `process.env.ANTHROPIC_API_KEY` exactly once at `init()`; absence fails fast with `PluginError({ code: 'init-failed', hookName: 'init' })` whose message is a static string (no key value is ever templated into an error). All errors thrown by the SDK are run through a redactor that string-replaces the in-memory key with `<redacted>` before the message lands in `PluginError.message`. Per invariant I5, there is NO test-time env-var backdoor — tests must use constructor-injected `clientFactory`. A dedicated test asserts that `AX_TEST_ANTHROPIC_FIXTURE` is NOT honored.
- **Injection:** Model output is returned as `assistantMessage` and `toolCalls[]`. The chat loop dispatches tool calls through `tool:execute` (the dispatcher validates tool names against a whitelist, invariant I8). `llm:post-call` subscribers are the designed veto / rewrite lever for model output scrubbing. This plugin does not interpolate model output into shell commands, SQL, or filesystem paths.
- **Supply chain:** `@anthropic-ai/sdk` is pinned to exact version `0.91.0` (no `^` / `~`). `npm view @anthropic-ai/sdk@0.91.0 scripts` returned only `test`, `build`, `format`, `tsn`, `lint`, `fix` — no `preinstall` / `postinstall` / `prepare` / `install` hooks that would execute code at install time. Single transitive dep: `json-schema-to-ts@3.1.1` (which brings `ts-algebra@2.0.0` — type-level helpers only, no runtime code paths exercised at request time). Transitive snapshot captured below; changes here require a new supply-chain review.

## `@anthropic-ai/sdk` pin

- Exact version: `0.91.0`
- Chosen: `2026-04-23`
- Rationale: latest at time of scaffold. `npm view` at that date confirmed no code-executing install scripts and only one direct transitive (`json-schema-to-ts`). v1 AX shipped with `0.90.0`; `0.91.0` is a single minor bump with no breaking API shift for `client.messages.create`.

## Install scripts (at pin time)

```console
$ npm view @anthropic-ai/sdk@0.91.0 scripts
{
  test: './scripts/test',
  build: './scripts/build-all',
  format: './scripts/format',
  tsn: 'ts-node -r tsconfig-paths/register',
  lint: './scripts/lint',
  fix: './scripts/format'
}
```

None of the keys in the list (`preinstall`, `install`, `postinstall`, `prepare`, `prepublishOnly`) are present — nothing runs at `pnpm install` time.

## Transitive dependencies (at pin time)

```console
$ pnpm --filter @ax/llm-anthropic list
@ax/llm-anthropic@0.0.0 /Users/vpulim/dev/ai/ax-next/packages/llm-anthropic (PRIVATE)

dependencies:
@anthropic-ai/sdk 0.91.0
@ax/core link:../core
```

`@anthropic-ai/sdk@0.91.0` `dependencies`:

```json
{ "json-schema-to-ts": "^3.1.1" }
```

`json-schema-to-ts@3.1.1` pulls in `@babel/runtime` and `ts-algebra@2.0.0` — the latter is a type-level compile-time helper (no runtime side effects), the former is a standard runtime helper library.

Resolved in `node_modules/.pnpm`:

```text
@anthropic-ai+sdk@0.91.0_zod@3.25.76
json-schema-to-ts@3.1.1
ts-algebra@2.0.0
```

(`zod` resolution in the SDK's peer scope is satisfied by the existing workspace `zod` at 3.25.76 — the SDK marks `zod` as optional peer. We do not take a direct runtime dep on zod in this plugin; the peer exists so downstream consumers can use the SDK's zod-validated `.tools` helper, which we do not use.)

## Known scope limits

- **Retry policy is minimal.** One retry on HTTP 429 / 500 / 502 / 503 / 504 with a 1-second fixed delay. No exponential backoff, no jitter, no `Retry-After` parsing. Fine for Week 4–6 where the chat loop is single-tenant; revisit for production traffic.
- **No streaming.** The initial `llm:call` surface is request/response only. Streaming will land as a separate subscriber hook so the transport concern can be swapped without touching this plugin's public surface.
- **Error classification is coarse.** Non-transient SDK errors surface as `PluginError({ code: 'unknown' })` — callers can't distinguish 401 from 400 from network loss. Acceptable given the chat loop's current behaviour (surface-and-abort); refine once we have a subscriber that wants to branch on it.

## Boundary review

- **Alternate impl this hook could have:** `@ax/llm-openai`, `@ax/llm-bedrock`, `@ax/llm-vertex`, `@ax/llm-local-ollama`. Each satisfies the same `llm:call` service hook contract with a different upstream SDK. The hook payload (`LlmRequest` / `LlmResponse`) is deliberately provider-agnostic — no `anthropic_version`, `model_id` shape assumptions, or provider-specific error codes leak upward.
- **Payload field names that might leak:** none. `messages`, `tools`, `assistantMessage`, `toolCalls` are all LLM-vendor-neutral vocabulary. This plugin converts to/from the Anthropic-specific `content` blocks internally (`type: 'text'` / `type: 'tool_use'`) and never exposes that shape on the hook surface.
- **Subscriber risk:** `llm:call` is a service hook (one producer). No cross-plugin subscribers key off its payload shape today. Future `llm:post-call` subscribers are the designed scrubbing / rewrite lever and will see only the neutral shape.
- **Wire surface:** NOT exposed as an IPC action. `llm:call` is in-process only — the plugin holds the API key, and we do not want that key crossing a sandbox boundary. Any future sandboxed LLM caller would be a separate plugin (e.g., a broker process) talking to the outside world, with this plugin left trusted in the kernel.
