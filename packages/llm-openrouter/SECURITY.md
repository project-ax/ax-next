# Security notes — @ax/llm-openrouter

We're a thin HTTP client for OpenRouter's OpenAI-compatible API. Three jobs: answer "which models can I pick?", make a model call on the host's behalf, and check an API key before we store it. Anything else we accumulate is a sign we're doing too much.

There's no provider SDK here, on purpose. Plain `fetch` and `zod`. One fewer dependency to trust, and — more to the point — nothing in the request path that can go looking for credentials in the environment behind our back.

## Capability budget

We're picky about this. If a future change needs more, it's worth a second look:

- **Filesystem reads:** none.
- **Filesystem writes:** none.
- **Network:** outbound HTTPS to `openrouter.ai` only, and only two paths on it — `POST /api/v1/chat/completions` and `GET /api/v1/key`. The base URL comes from `PROVIDER_ENDPOINTS` in `@ax/core`, the same table the host uses to decide what the sandbox's egress allow-list permits. That's not a coincidence: if we dialed anywhere else, the proxy would deny it, and the error would be baffling.
- **Process spawn:** none.
- **Environment variables:** we read `OPENROUTER_API_KEY` (or accept a key via `cfg.apiKey`, or resolve one per-call from the credential store). We don't log it, persist it, or hand it back through any hook payload. Treat it like the password it is.

That's it. If a later change adds `fs`, `child_process`, or a second outbound host, please push back hard or come talk to us.

## The key never comes back out

This is the one we're actually nervous about, because `credentials:validate:openrouter` runs on a secret an operator just pasted into a form, and the string we return renders straight into an alert on their screen.

So the validator's rule is absolute: **nothing derived from the request escapes.**

- The key bytes become a string only long enough to build one `Authorization` header.
- The response body is discarded unread. We look at the status code and nothing else.
- We catch and *drop* the error object on a transport failure rather than reporting it. That object is the one value in scope that could be carrying the key — a redirect URL, a proxy error quoting the request headers back at us. We'd rather say "we couldn't reach OpenRouter" than find out the hard way.
- The only things we're willing to say are: it worked, it didn't, or we couldn't tell.

The model-call path is nearly as tight. When OpenRouter returns an error we pull out its documented `error.message` field, cap it at 200 characters, and attach that — rather than splicing a whole provider-controlled body into a message bound for a log file. The key is never part of any of it, and there's a test that asserts exactly that by searching the serialised error for the key string.

## Untrusted input

The caller hands us a `messages` array. Some of those bytes started life as user input, some as model output from a prior turn, some from a system prompt the caller built. From our seat, we can't tell which is which, and we don't try to.

So the posture is: **don't attribute trust we don't have.**

- We forward the caller's `messages` content to OpenRouter verbatim. We don't render it, parse it for instructions, interpret it, or strip anything.
- We hand the model's response back to the caller unmodified. We don't render it either.
- We don't try to "sanitize" the bytes — sanitization that doesn't know the rendering context creates more vulnerabilities than it prevents. The caller knows where this string is going next; we don't.

The response is untrusted in the other direction too. OpenRouter proxies dozens of upstreams, so what comes back is genuinely heterogeneous — we shape-check it with zod rather than indexing into `any` and hoping. `finish_reason` is mapped through an own-property lookup, so a vendor that invents a value called `constructor` this week gets `unknown`, not a function.

## What we deliberately don't do

A few things we could implement here, but won't, because they belong elsewhere:

- **Retry policy beyond one attempt on 429/5xx.** Real backoff with jitter belongs in a wrapper plugin or the orchestrator. We retry once because going zero would surprise callers, and going further would overstep — and on a metered aggregator, an over-eager retry loop is somebody's bill.
- **Rate limiting.** Same reason — a policy decision for a layer above us.
- **A live model catalog.** We ship a small seed list of labels. OpenRouter serves 419 models and churns weekly; the operator's allow-list is the authority on what's selectable, and the picker route already handles anything our seed doesn't name. Polling their catalog at runtime would add a network dependency to a page load in exchange for prettier strings.
- **Prompt logging or auditing.** The `audit-log` plugin owns this. We don't ship our own pile of logs with model content in them.
- **Streaming.** Day-1 scope is non-streaming. Streaming is a separate hook surface (when we need it), not a flag on this one.

## Why this matters

This plugin is a network egress point for "talk to a model," and it holds a key that can spend real money across dozens of vendors. If it grows extra capabilities, every other plugin inherits a wider attack surface — a compromised dependency here means a leaked aggregator key and arbitrary outbound HTTPS. Keeping the budget tiny (and the dependency list at exactly one runtime package we didn't write) is how we make a supply-chain compromise survivable.

We're a nervous crab here on purpose. The door is locked.
