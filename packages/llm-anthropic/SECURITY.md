# Security notes — @ax/llm-anthropic

We're a thin wrapper around Anthropic's SDK. We register `llm:call:anthropic` and the model-list hooks so the rest of the system can use this provider through the hook bus.

## Capability budget

We're picky about this. If a future change needs more, it's worth a second look:

- **Filesystem reads:** none.
- **Filesystem writes:** none.
- **Network:** model-list requests use `api.anthropic.com`. Completions use the SDK's configured endpoint, which defaults to `https://api.anthropic.com`; the SDK also accepts the operator's `ANTHROPIC_BASE_URL`. Callers cannot supply an endpoint through the hook payload. We cap completion/error bodies before the SDK reads them.
- **Process spawn:** none.
- **Environment variables:** we resolve `ANTHROPIC_API_KEY` at init, or per call in credential-resolution mode, with explicit config and stored-credential precedence. The SDK also reads its own configuration environment. We don't log the resolved key, persist it here, or hand it back through any hook payload.

That's it. If a later change adds `fs`, `child_process`, or a second outbound host, please push back hard or come talk to us.

## Untrusted input

Completion bodies are capped before the SDK buffers or parses them: 4 MiB
for successful responses and 64 KiB for error bodies, matching the host
OpenRouter budgets. The shared core cap counts decompressed streamed bytes,
so missing or misleading Content-Length headers cannot disable it. Over-limit
reads are cancelled. The completion API remains non-streaming.

The caller hands us a `messages` array. Some of those bytes started life as user input, some as model output from a prior turn, some from a system prompt the caller built. From our seat, we can't tell which is which, and we don't try to.

So the posture is: **don't attribute trust we don't have.**

- We forward the caller's `messages` content to Anthropic verbatim. We don't render it, parse it for instructions, interpret it, or strip anything.
- We extract text, stop reason and usage from the model's response and return those fields. We don't render the text.
- We don't try to "sanitize" the bytes — sanitization that doesn't know the rendering context creates more vulnerabilities than it prevents. The caller knows where this string is going next; we don't.

The model's output is also untrusted (model output is the canonical untrusted-content example in v2). We pass it on as bytes, with the structural fields the caller asked for (`text`, `stopReason`, `usage`). We don't promote any of it into a control field on our side.

## What we deliberately don't do

A few things we could implement here, but won't, because they belong elsewhere:

- **Broader retry coordination.** The plugin retries once on transient 5xx/429. The underlying SDK has its own retry policy, so this is not a bound on HTTP attempts. Coordinated backoff belongs in a wrapper plugin or the orchestrator.
- **Rate limiting.** Same reason — that's a policy decision a layer above us should make.
- **Prompt logging or auditing.** The `audit-log` plugin owns this. We don't ship our own pile of logs with model content in them.
- **Streaming.** Day-1 scope is non-streaming. Streaming is a separate hook surface (when we need it), not a flag on this one.

## Why this matters

This plugin is the network egress point for "talk to a model." If it grows extra capabilities, every other plugin in the system inherits a wider attack surface — a compromised dependency here means leaked API keys and arbitrary outbound HTTPS. Keeping the budget tiny is how we make a supply-chain compromise survivable.

We're a nervous crab here on purpose. The door is locked.
