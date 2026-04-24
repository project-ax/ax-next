# Security — `@ax/llm-proxy-anthropic-format`

This package registers a per-session HTTP listener that speaks the Anthropic Messages API on the wire and translates calls into `llm:call` on the hook bus. Sandbox subprocesses — most notably the claude-agent-sdk runner's grandchild `claude` CLI — point `ANTHROPIC_BASE_URL` at this listener instead of `api.anthropic.com`. This note captures the `security-checklist` walk for the Week 6.5d landing.

## Security review

- **Sandbox:** The listener binds to `127.0.0.1` on an OS-chosen ephemeral port (`server.listen(0, '127.0.0.1')`) — never `0.0.0.0`, never a public interface. Reach from a sandbox with a valid session token is scoped to what `llm:call` already grants: one request out to whichever host-side `llm:*` plugin is loaded, bound to the caller's `sessionId`. No filesystem access, no process spawn, no env reads, no handles of any kind flow through this surface. Auth runs BEFORE body read: either `Authorization: Bearer <token>` or `X-Api-Key: <token>` (the `@anthropic-ai/sdk` default when it sees `ANTHROPIC_API_KEY` in env). The token is resolved via `session:resolve-token`, which additionally binds it to its originating `sessionId` — cross-session token reuse returns 403 rather than 401, so a leaked token cannot be replayed against a different session's proxy. Body size is capped at 4 MiB (`MAX_FRAME` from `@ax/core`) with a `Content-Length` fail-fast plus a streaming tripwire; oversize destroys the socket. No error response ever echoes the token, the raw body, or upstream `PluginError` messages with code `unknown` — those pass through a generic "upstream llm call failed" envelope.

- **Injection:** The wire input is untrusted by construction. It arrives from the sandbox-side claude-agent-sdk, which has already mixed model output, tool output, and user prompt into a single Messages payload. The proxy is a TRANSLATOR, not a firewall — it does NOT scrub message content, redact strings, or inspect semantics. That's deliberate. The designed rewrite / veto lever for untrusted model input is `llm:pre-call` (Week 9.5+ subscribers) and `llm:post-call` for outbound. Anyone tempted to add redaction logic HERE should add a subscriber there instead — otherwise the scrubbing lives on the Anthropic-specific translator and won't apply when the OpenAI or Bedrock proxies land. The proxy's own control-plane strings (error types, HTTP status bodies) are all static — nothing caller-influenced ends up interpolated into a shell, a file path, a SQL query, or another LLM prompt.

- **Supply chain:** No new runtime dependencies. This package pulls `@ax/core` (workspace) and `@ax/ipc-protocol` (workspace) and nothing else at runtime. `zod` is already a workspace dep used by every plugin. HTTP surface is Node stdlib (`node:http`, `node:net`). Nothing to pin here.

## Known scope limits

- **4 MiB body cap is load-bearing but unvalidated against future wire shapes.** It's fine for current Anthropic Messages requests — system prompts, tool definitions, and message history comfortably fit. A future SDK that batches uploads, attaches large images inline, or streams long transcripts could bump into it. When that happens, raise the cap intentionally; don't remove the check.
- **Zod `.passthrough()` on every layer of `AnthropicRequestSchema`.** The schema accepts unknown fields so the translator doesn't reject payloads the SDK adds in a point release. If a Zod bug ever lets a malformed well-known field through the parser, the translator returns a 400 — but that's a thinner layer than we'd like. We haven't fuzz-tested the parser; worth a revisit when adding non-trivial new fields.
- **Loopback-only audit.** Week 7–9 introduces the k8s sandbox, which means cluster-internal HTTP rather than loopback. The `sandbox:open-session` flow will have to mint a token and carry it into a pod in a way that doesn't expose it to other pods, and the proxy listener might move behind a per-session service or a mutual-TLS hop. We'll re-audit the sandbox-escape section then.

## Boundary review

- **Alternate impl this hook could have:** The proxy is the only hook producer; `session:resolve-token` is registered elsewhere (session plugin — Week 4–6). An alternate proxy would be `@ax/llm-proxy-openai-format` for a future OpenAI-flavored runner. The wire surface differs (OpenAI `/v1/chat/completions` vs. Anthropic `/v1/messages`) but the internal contract — auth gate, `session:resolve-token`, `llm:call`, translate response — is identical.
- **Payload field names that might leak:** none. `LlmCallRequest` / `LlmCallResponse` are LLM-vendor-neutral. Anthropic-specific vocabulary (`content` blocks, `tool_use`, `anthropic-version`) stays on the wire side; the hook bus sees neutral shapes only.
- **Subscriber risk:** No subscribers today. `llm:call` is a service hook (one producer). `llm:pre-call` / `llm:post-call` subscribers arrive in a future slice and will see the neutral shape.
- **Wire surface:** HTTP, not IPC. The schema lives in `anthropic-schemas.ts` inside this package — not in a central file. Binding is per-session and owned by `sandbox:open-session` (the listener is created and closed alongside the session).

## What we don't know yet

- We haven't measured whether `4 MiB` is right for every future LLM wire shape. Anthropic Messages today: fine. Future multi-modal batches: unclear.
- We haven't fuzz-tested the Zod request parser. `.passthrough()` means unknown fields survive — a parser bug that also allowed a malformed known field through would surface as a translator 400, but that's one layer of defense thinner than ideal.
- We haven't modelled the k8s-sandbox routing threat. Today's audit is loopback-only. When cluster HTTP replaces loopback, the sandbox-escape section needs a rewrite.

## Security contact

If we find a hole, we'd rather hear about it from you than read about it on Hacker News. Please email `vinay@canopyworks.com`.
