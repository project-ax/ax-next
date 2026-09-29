# Metering and gating the model provider at the credential proxy (TASK-715)

Follow-up to the per-user spend cap (TASK-692, `docs/plans/2026-09-29-usage-limits.md`)
and the credential-to-host binding (TASK-687).

## The gap, measured

TASK-692 meters what the *runner* reports and gates the start of a turn. The
operator's provider key never enters the sandbox; a placeholder does
(`ANTHROPIC_API_KEY=ax-cred:<hex>`), and the credential proxy swaps in the real
key on requests to the provider's own host. Both runners hand that placeholder,
plus `HTTPS_PROXY` with the per-session proxy token, to the environment their
Bash tool runs in (`proxy-startup.ts` `providerEnv`; aisdk `bashEnv`).

So a `curl` in the sandbox is indistinguishable, at the proxy, from the runner:
same session token, same placeholder, same host.

Measured 2026-09-29, in-process, against the real listener (a probe in the
`listener-credential-binding.test.ts` harness, run against unmodified code; its
cases are now the first block of `listener-provider-metering.test.ts`):

1. 25 requests written by a "sandbox curl" down one keep-alive tunnel: the
   upstream received the REAL key on 25 of 25. Nothing in `ProxyAuditEntry`
   carries a token count, and `usage-limits` subscribes to
   `chat:start|chat:resume|chat:turn-end|llm:usage`, none of which this fires.
2. **A second, older bypass under the same card:** bytes written in the SAME
   TCP segment as the `CONNECT` (`head`) are substituted and written straight to
   the upstream TLS socket by `handleMITMConnect`, around the request framer
   (so also around the canary scan). Upstream saw the real key there too.
   Any gate or meter that lives in the framer is walked around by this until it
   is closed.
3. Removing the placeholder from the Bash env is not a boundary. A child with a
   fully scrubbed env read its parent's `/proc/<ppid>/environ` as the same uid in
   a stock container (alpine, uid 1000) and printed the placeholder. The runner
   itself needs the credential in the same container, and the proxy token that
   authenticates the tunnel is in the same env. There is no process-level
   separation to lean on, so the control has to sit at the proxy.

Also found while reading the byte path: the operator's key is not limited to
inference. `api.anthropic.com` accepts it for the Batch API, Managed Agents
(`/v1/agents`, `/v1/sessions`, `/v1/environments`), Files, Skills, Vaults and
Memory Stores (strings in the shipped `claude` binary). One `POST
/v1/messages/batches` is up to 100k billed requests. A per-request cost estimate
cannot bound that; not splicing the key into those requests can.

## Candidate controls, and which one bounds dollars

| Control | Bounds spend? | Why |
|---|---|---|
| (b) per-user request-rate / concurrency cap | No | One provider call costs anywhere from $0.001 to several dollars, and a legitimate agent makes ~1000 calls an hour, so any rate that spares honest users leaves an attacker choosing the expensive ones. Kept as a small concurrency cap (see below) to bound the overshoot, not as the control. |
| (c) keep the placeholder out of user code's env | No | `/proc/<ppid>/environ` (measured above) and the proxy token beside it. |
| (a) meter usage at the proxy, and stop splicing the key past a ceiling | Yes | Only the proxy sees every provider byte, and it is the only place the key is unlocked. |

So (a), with two additions that make it hold: an endpoint allowlist (the key is
only spliced into inference requests) and closing the `head` path.

## Design

### Where the key is unlocked, and only there

Substitution has exactly three sites: the Basic-auth transform and the verbatim
replace over a request head (both in `RequestFramer`), and the `head` flush in
`handleMITMConnect`. The last one goes: a non-empty `head` on the MITM path is
refused with 400 (a real client waits for the 200 before sending its
ClientHello, and the bytes were being written to the wrong socket anyway).

### Metered tunnels

`proxy:open-session` credentials gain an optional
`metered: { requests: string[] }`. The orchestrator sets it for the provider key
only, from a new `PROVIDER_ENDPOINTS[p].inferenceRequests` (same table both
sides of the wall read). The plugin turns it into a `ProviderMeter` on the
`SessionConfig`: the credential's `allowedHosts` are the metered hosts.

For a tunnel whose CONNECT target is a metered host, per request head:

1. **Endpoint allowlist.** Request line must be `METHOD /path HTTP/1.1` with an
   origin-form target whose path (query stripped) matches an entry of
   `requests`. If not, the head is forwarded with NO substitution, so the
   placeholder reaches the provider as an inert token (401 for anything that
   needs auth; unauthenticated calls such as `GET /api/hello` behave as before).
2. **Gate.** `meter.admit()` (sync). Refused: the request is not forwarded, the
   client gets a JSON 429 (`Retry-After`), the tunnel closes. Reasons: the user
   is blocked (suspended, or over the ceiling) or has too many provider calls
   in flight.
3. **Identity encoding.** `Accept-Encoding` is replaced with `identity` on the
   forwarded head so the response can be read without a decompressor. A head
   that cannot be rewritten safely (an obsolete folded header line) is never
   spliced into, so a keyed request always asks for an unencoded answer. A
   response that arrives encoded anyway is charged as unmeasured, floored by its
   size.
4. **Meter.** A passive tap on the upstream bytes frames the HTTP/1.1
   responses (Content-Length, chunked, close-delimited, interim 1xx, HEAD/204/
   304) and scans the decoded body for usage counters. Bytes are forwarded
   untouched; a tap failure can never fail a request.

`meter.settle()` is called exactly once per admitted request, when its response
completes or the tunnel ends first. A response that yields no usage figure is
charged from the request size. A 4xx/5xx costs nothing; `count_tokens` costs
nothing. Unknown is never free.

The counters are the LAST thing in a response, so "read every token, hang up
before the bill arrives" must not be free either: a response that ended early,
or that arrived whole but could not be read (encoded, or no counter in it),
carries how many body bytes arrived (`partial: { bytes, streamed }`; encoded
bytes count 4x), and the
ledger floors the output at `bytes / 8` for an event stream (`bytes / 3`
otherwise). The divisors are low on purpose, so the floor over-counts a client
that hung up honestly (the Stop button) rather than under-counting one that did
it to dodge the meter. A complete response is charged exactly what it reported.

The usage scanner takes, per field, the MAX over the whole response (Anthropic
streams report cumulative counts; `message_delta` repeats them), for
`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` and the OpenAI-compatible `prompt_tokens`,
`completion_tokens`, `prompt_tokens_details.cached_tokens` /
`cache_write_tokens`. Keys preceded by a backslash are ignored, so model text
that quotes a usage object (escaped inside SSE `data:`) cannot forge one.
Inflating your own count only hurts you.

### Per-user state in the proxy plugin

`provider-meter.ts`: per user (not per session, so N sessions do not multiply
anything), an in-memory `{ blocked, inFlight, lastCheckedAt }`.
`admit()` is refused when `blocked` or `inFlight >= 8`. It is seeded by an
awaited `usage:provider-status` at `proxy:open-session`, refreshed at most every
15 s while the user is active (5 s while blocked, so a lifted block clears
quickly), and updated by the verdict every `settle()` gets back from
`usage:provider-record`. A failed status check blocks (fail closed, same as
`chat:start`); the resulting 429 is retried by both SDKs, so a database blip
heals itself.

### usage-limits

Two service hooks (the only new hook surface):

- `usage:provider-status` `{}` -> `{ blocked: false } | { blocked: true, reason }`
- `usage:provider-record` `{ model?, usage | null, requestBytes | null }` -> same verdict

Both act for `ctx.userId`. `usage:provider-record` also takes an optional
`partial: { bytes, streamed }` (see above). `reason` is `usage-suspended | usage-limit-daily |
usage-check-unavailable`. Blocked means: suspended, or estimated spend over
`PROVIDER_CEILING_MULTIPLE` (2) x the daily limit. A turn is admitted at 1x
(`chat:start`); a turn already under way may run to 2x before the sandbox loses
the key, so an honest turn that crosses the line is not cut mid-flight but a
loop of direct calls is.

Storage: buckets gain `provider_cost_micros` (what the proxy measured, the
runner's calls and any direct ones together) and `helper_cost_micros` (host
helper calls, moved out of `cost_micros`). Estimated spend is

    GREATEST(SUM(cost_micros), SUM(provider_cost_micros)) + SUM(helper_cost_micros)

per user over the rolling 24 h: the larger of two independent measurements of
the same traffic (runner-reported and proxy-measured), so nothing is
double-counted, a proxy parse miss falls back to today's behaviour, and a direct
call shows up as the excess. The admin view and `chat:start` use the same figure.

## What stays unmetered or unbounded, said plainly

- The overshoot is bounded, not zero: up to 8 calls in flight per user when the
  block lands, each up to the model's maximum output, plus the ~15 s the
  suspend button takes to reach a user who was not otherwise blocked.
- The cap is per user. Open signup plus many accounts is not addressed here (the
  fleet-wide cap is still a follow-up).
- The usage ledger is now on the critical path of every sandbox model call. The
  gate fails closed and caches its answer for about 15 s, so a usage-database
  outage longer than that pauses model calls from the sandbox (the runner's
  included, not just new turns) until it recovers; both SDKs retry the 429.
- The block also covers the key's read-only and free calls (`GET /v1/models`,
  `count_tokens`): they are spliced-into requests, so a blocked user gets the same
  429 for them. Fail closed, on purpose.
- Server-side tool charges (web search per request) and Anthropic's
  `usage.iterations` compaction extras are not in the price table.
- State is per host process. With more than one host replica the in-flight cap
  and the block flag are per replica; the DB spend figure is shared.
- Two-hop and out-of-band routes are out of scope: this covers the provider
  credential the orchestrator marks `metered`. The dev CLI stub path (explicit
  agent-row credentials) is unmetered, as is any deployment without
  `@ax/usage-limits`.
- A human-approved deferred tool call replayed on the host after a suspension
  (TASK-692 residual) is not touched.

## Tasks (YAGNI pass: all load-bearing)

1. `@ax/core` `ProviderEndpoint.inferenceRequests`; orchestrator marks the
   provider credential `metered`. (Without it nothing is engaged.)
2. `credential-proxy`: usage scanner + response tap. (The meter.)
3. `usage-limits`: two columns, spend formula, the two hooks, unmeasured
   estimate. (The ledger and the verdict.)
4. `credential-proxy`: framer policy (allowlist, gate, identity), refuse `head`,
   listener wiring, metered tunnel bookkeeping. (The gate.)
5. `credential-proxy` plugin: `provider-meter.ts`, open/close wiring, manifest.
   (The per-user state.)
6. Canary on the real chain (proxy plugin + usage-limits + Postgres): a
   sandbox-originated provider call is counted, then refused past the ceiling,
   and the runner-shaped call is unaffected. Docs, memory, stale-line fixes.
