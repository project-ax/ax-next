# @ax/embeddings — security notes

This package is the first thing in `packages/` that sends user memory off the cluster.
That deserves a page of its own rather than a bullet in a PR.

## What leaves, when remote mode is on

Two destinations, both fixed, both HTTPS:

| Destination | What we send | How often |
|---|---|---|
| `us-central1-aiplatform.googleapis.com` (embeddings) | every statement as it is stored, and every recall query | every write, every query-shaped recall |
| `api.cohere.com` (rerank) | the top 40 fused candidates plus the query | every query-shaped recall |

That is the honest version. It is not "some derived signal" or "just vectors" — the
*text* goes out, because that is what an embedding API takes. If your deployment can't
accept that, local mode exists and the README states what it costs.

With remote mode off — the default — this package opens no sockets at all.

## The hosts are a table, not a setting

There is no configurable base URL, and that is on purpose. A `baseUrl` field is a
`fetch`-to-anywhere primitive wearing a config's clothes: one compromised settings row
and memory flows to somebody else's endpoint. Instead, `endpoints.ts` holds a frozen
table and a deployment picks a **key** from it. Adding a region is a code change with a
review, which is exactly the friction we want on "where does everyone's memory go".

Two values *are* deployment-supplied and *do* reach the URL — the model id and the GCP
project id. Both are checked against a strict grammar before anything is interpolated.
"Deployment-supplied" is not the same as "trusted": a model id of `../../../somewhere`
is a path-traversal primitive against an API URL, and it would have worked.

## Credentials come from the credential store. Only.

No `process.env` read anywhere in this package, no key in config, no fallback chain
that ends at an environment variable. The token is fetched per call via
`credentials:get`, scoped by the calling user, used to build one `Authorization`
header, and never logged, never returned, never put in an error message.

If no credential resolves, we **do not dial out**. The call answers "nothing", the
memory engine reports a degraded channel, and someone notices. We are not sending
memory to a third party on an unauthenticated request to find out what happens.

### The gap we are not going to pretend isn't there

The design called for this traffic to be "routed through the existing egress lock".
There isn't one to route through. `@ax/credential-proxy` — the thing we call the egress
lock — gates **the sandbox**: it MITMs HTTPS for runner subprocesses and enforces a
per-session host allow-list. Host-side plugins like this one, `@ax/llm-anthropic` and
`@ax/web-tools` dial out directly, with no proxy in front of them.

So what we have built is the enforceable half: a closed host table, credential-store
credentials, and no env-var path. What we have *not* built is a host-side egress
allow-list, because it does not exist yet for anyone. That is a real gap, it applies to
three packages and not just this one, and it is filed rather than papered over.

## Untrusted in both directions

**Going out:** the text we send is model and user output. It is only ever a JSON string
field in a request body — never a URL segment, never a header, never a shell argument.

**Coming back:** the provider's response crosses a trust boundary inward, and we treat
it that way. Arity, vector width and finiteness are all checked, and anything that
fails becomes "no answer" rather than an exception. This is not hypothetical
tidiness — the consumer awaits the embed call *outside* its store transaction, so a
`TypeError` escaping from here once turned a single misconfigured provider into a
deployment-wide write outage. Nothing from a provider response ever reaches a prompt:
embeddings are floats and rerank scores are numbers, and we refuse anything that isn't.

## Supply chain

No new dependencies. Not pinned-carefully, not vetted-and-added — **none**. The only
runtime dependency is `@ax/core`, and the HTTP calls use the platform's `fetch`.

That is a deliberate deletion, not an accident: the reference implementation pulled in
`google-auth-library` and its transitive tree to mint a token. The endpoint takes a
plain bearer token, so a credential-store value plus `fetch` does the same job with
nothing to audit. There is no reranker SDK either, for the same reason.
