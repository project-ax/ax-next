# Security notes — @ax/llm-anthropic

We're a thin wrapper around Anthropic's SDK. The job is one thing: register the `llm:call` service hook so the rest of the system can ask a model a question without knowing which provider answered. Any other capability we accumulate would be a sign we're doing too much.

## Capability budget

We're picky about this. If a future change needs more, it's worth a second look:

- **Filesystem reads:** none.
- **Filesystem writes:** none.
- **Network:** outbound HTTPS to `api.anthropic.com` only — that's the entire surface. The SDK opens the connection; we just hand it bytes and read bytes back.
- **Process spawn:** none.
- **Environment variables:** we read `ANTHROPIC_API_KEY` once at init (or accept it via `cfg.apiKey`). We don't log it, persist it, or hand it back through any hook payload. Treat it like the password it is.

That's it. If a later change adds `fs`, `child_process`, or a second outbound host, please push back hard or come talk to us.

## Untrusted input

The caller hands us a `messages` array. Some of those bytes started life as user input, some as model output from a prior turn, some from a system prompt the caller built. From our seat, we can't tell which is which, and we don't try to.

So the posture is: **don't attribute trust we don't have.**

- We forward the caller's `messages` content to Anthropic verbatim. We don't render it, parse it for instructions, interpret it, or strip anything.
- We hand the model's response back to the caller unmodified. We don't render it either.
- We don't try to "sanitize" the bytes — sanitization that doesn't know the rendering context creates more vulnerabilities than it prevents. The caller knows where this string is going next; we don't.

The model's output is also untrusted (model output is the canonical untrusted-content example in v2). We pass it on as bytes, with the structural fields the caller asked for (`text`, `stopReason`, `usage`). We don't promote any of it into a control field on our side.

## What we deliberately don't do

A few things we could implement here, but won't, because they belong elsewhere:

- **Retry policy beyond one attempt on transient 5xx/429.** A real backoff with jitter belongs in a wrapper plugin or the orchestrator, not in this thin layer. We retry once because going zero would surprise callers, and going further would overstep.
- **Rate limiting.** Same reason — that's a policy decision a layer above us should make.
- **Prompt logging or auditing.** The `audit-log` plugin owns this. We don't ship our own pile of logs with model content in them.
- **Streaming.** Day-1 scope is non-streaming. Streaming is a separate hook surface (when we need it), not a flag on this one.

## Why this matters

This plugin is the network egress point for "talk to a model." If it grows extra capabilities, every other plugin in the system inherits a wider attack surface — a compromised dependency here means leaked API keys and arbitrary outbound HTTPS. Keeping the budget tiny is how we make a supply-chain compromise survivable.

We're a nervous crab here on purpose. The door is locked.
