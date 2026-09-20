# @ax/embeddings

The plugin that answers two questions for the memory engine: *"turn this text into
numbers"* and *"of these forty candidates, which actually answer the question?"*

It registers two hooks:

| Hook | In | Out |
|---|---|---|
| `embeddings:embed` | `{ texts, task: 'document' \| 'query', model? }` | `{ vectors }` — one per text, in input order |
| `embeddings:rerank` | `{ query, documents, model? }` | `{ scores }` — one per document, in input order, higher is better |

`@ax/memory-facts-sqlite` has been calling both since TASK-434. Until this package
existed, nobody answered, and every recall came back flagged
`degraded: ['semantic', 'ranking']` — which is to say memory worked, but with two of
its three good ideas switched off.

## Two modes, and the difference is not small

**Local mode** is the default, and it needs nothing: no account, no API key, no
outbound network, no bill. Text is hashed into a vector, and reranking is plain word
overlap. It is a real implementation — deterministic, correctly shaped, stable across
restarts — just a much weaker one.

**Remote mode** sends the text to a real embedding model and a real cross-encoder.

Here is what that buys, measured rather than guessed. On the n=30 recall smoke:

| | recall accuracy |
|---|---|
| with the production reranker | **80.0%** |
| without it | **56.7%** |

That is a 23-point gap, and we would rather you see it as a number than discover it as
a vibe. If your install can egress, turn remote mode on. If it can't — air-gapped, a
regulated tenant, or just a "no third parties touch our data" policy — local mode is a
working system, and we would rather ship you that than nothing.

One thing we deliberately did **not** build: an automatic fallback from remote to
local. If you configure remote mode and the credential is missing, you get *no answer*
and the caller says so out loud. A silent fallback would have cost you 23 points of
accuracy while looking exactly like success, and "looks exactly like success" is our
least favourite failure mode.

## Using it

```ts
// Local mode — nothing to configure.
createEmbeddingsPlugin();

// Remote mode.
createEmbeddingsPlugin({
  embed: {
    provider: 'vertex',
    credentialRef: 'account:vertex-embeddings',  // where the bearer token lives
    projectId: 'my-gcp-project',
  },
  rerank: {
    provider: 'cohere',
    credentialRef: 'account:cohere-rerank',
  },
});
```

Mode is per-hook. Configuring a remote embedder and no reranker is fine and common —
you get real vectors and lexical reranking.

`dimensions` defaults to **384**, because that is the width of the fact store's vector
column. If you change one you must change the other, and the consumer will reject
every vector until you do (loudly, on purpose).

## Where your memory goes, and who to tell

Remote mode sends **every stored statement and every search query** to the embedding
provider, and the **top 40 candidates of every recall** to the reranker. That is
people's memory leaving your cluster. It is the whole reason this package has a
[SECURITY.md](./SECURITY.md), and the reason it is off by default.

## Not wired into a preset yet

Nothing loads this plugin today. That is deliberate and it is the last card in this
epic's job: switching the dense channel on changes what recall returns, and we are not
making an unmeasured change to retrieval quality in the same PR that introduces the
capability. The preset + canary card does it with the measurement in hand.
