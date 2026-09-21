// The two remote drivers: Vertex for embeddings, Cohere for reranking.
//
// Both are plain functions over an INJECTED `fetch`. No SDK, no client object,
// no module-level state, no `process.env`, no credential lookup — the token
// arrives as an argument, already resolved by `plugin.ts` from the credential
// store. That keeps the whole network surface of this package to the two
// `fetchImpl(...)` calls below, and makes every failure path testable without
// a network.
//
// NEITHER FUNCTION THROWS. Every way a provider can fail to answer — non-2xx,
// a socket error, a body that is not JSON, a `null` body, a missing field, the
// wrong count, a non-finite number, a wrong vector width, our own deadline —
// comes back as `undefined`. The consumer (`memory-facts-sqlite`'s
// `callProducer`) is written for exactly that shape: a nullish answer raises a
// `degraded` flag and recall carries on with one channel fewer. A throw, by
// contrast, is a much blunter instrument for "the provider had a bad minute".
//
// NOTHING FROM THE RESPONSE IS EVER LOGGED OR PUT IN AN ERROR MESSAGE, and
// neither is the token. An upstream error body is attacker-influenced content
// and routinely echoes the request back; a log line is a fine place for a
// bearer token to end up and a terrible place for it to live.

import type { EmbeddingTask } from './wire.js';
import type { EmbedEndpoint, RerankEndpoint } from './endpoints.js';
import { validateScores, validateVectors } from './validate.js';

export interface RemoteDeps {
  /** Injected so tests never dial out. Production passes the global `fetch`. */
  fetchImpl: typeof fetch;
  /** Per-request deadline, enforced with an `AbortController`. */
  timeoutMs: number;
}

/** Vertex's task-type enum. Vendor vocabulary stops here — it never reaches a hook payload. */
const VERTEX_TASK_TYPES: Record<EmbeddingTask, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

/**
 * One POST, one attempt, JSON in and JSON out. Returns the parsed body, or
 * `undefined` for every failure.
 *
 * NO RETRY, NO BACKOFF, on purpose. `dem-memory`'s Vertex embedder retries 4
 * times with `1000 * 2 ** attempt` between tries — up to ~8 seconds after the
 * first failure. Our caller abandons us at 1.5s (embed) / 2.0s (rerank) and
 * takes the degraded answer, so every one of those retries could only ever
 * answer a caller that stopped listening: we would pay for the tokens, hold
 * the socket, and hand the result to nobody. One attempt inside the budget is
 * the honest shape. If a provider needs retries to be usable, that belongs
 * behind a longer budget negotiated with the consumer, not smuggled in here.
 */
async function postJson(
  deps: RemoteDeps,
  url: string,
  token: string,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs);
  try {
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // A non-2xx is not an answer. We deliberately do NOT read `.text()` to
    // build a message: nobody would see it and it would carry upstream content.
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    // Network throw, abort, or a body that is not JSON. All the same answer.
    return undefined;
  } finally {
    // In a `finally` so a FAST response does not leave a live timer holding
    // the event loop open for `timeoutMs` — that is how a CLI that finished
    // its work still sits there for five seconds before exiting.
    clearTimeout(timer);
  }
}

/** Read one own property off an unknown value, without assuming it is an object. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

export interface VertexEmbedArgs {
  texts: string[];
  task: EmbeddingTask;
  model: string;
  projectId: string;
  token: string;
  dimensions: number;
}

/**
 * Embed `texts` through Vertex's `:predict`, in input order.
 *
 * `model` and `projectId` MUST already have passed `MODEL_RE` /
 * `GCP_PROJECT_RE` — they are interpolated into the URL. `plugin.ts` validates
 * both at construction, and the payload-supplied model on every call.
 *
 * Vertex caps a predict call at `maxInstancesPerCall` instances, so a batch is
 * chunked and the chunks concatenated. IF ANY CHUNK FAILS THE WHOLE CALL
 * ANSWERS `undefined`: a partially-embedded batch is not a smaller answer, it
 * is a misaligned one — the consumer zips vectors against texts by position,
 * so text 7 would silently carry text 12's embedding.
 */
export async function vertexEmbed(
  deps: RemoteDeps,
  endpoint: EmbedEndpoint,
  args: VertexEmbedArgs,
): Promise<number[][] | undefined> {
  if (args.texts.length === 0) return [];

  const url =
    `https://${endpoint.host}/v1/projects/${args.projectId}` +
    `/locations/${endpoint.region}/publishers/google/models/${args.model}:predict`;
  const taskType = VERTEX_TASK_TYPES[args.task];

  const vectors: number[][] = [];
  for (let start = 0; start < args.texts.length; start += endpoint.maxInstancesPerCall) {
    const batch = args.texts.slice(start, start + endpoint.maxInstancesPerCall);
    const body = await postJson(deps, url, args.token, {
      instances: batch.map((content) => ({ content, task_type: taskType })),
      parameters: { outputDimensionality: args.dimensions },
    });

    const predictions = fieldOf(body, 'predictions');
    if (!Array.isArray(predictions)) return undefined;
    // Unwrap `{ embeddings: { values } }` per prediction, then let
    // `validateVectors` decide whether what came out is an answer. A missing
    // `embeddings` yields `undefined` in that slot and fails the check there.
    const values = predictions.map((prediction) => fieldOf(fieldOf(prediction, 'embeddings'), 'values'));
    const chunk = validateVectors(values, batch.length, args.dimensions);
    if (chunk === undefined) return undefined;
    vectors.push(...chunk);
  }
  return vectors;
}

export interface CohereRerankArgs {
  query: string;
  documents: string[];
  model: string;
  token: string;
}

/**
 * Score `documents` against `query` through Cohere's `/v2/rerank`, returned in
 * DOCUMENT order (Cohere returns them sorted by score, carrying the original
 * index on each result — so we place by `index`, never by iteration order).
 *
 * `top_n` is sent explicitly and FULL COVERAGE is required: every index in
 * `0..n-1` exactly once, each with a finite score. Anything else ⇒ `undefined`.
 *
 * WE DO NOT PAD WITH ZEROS the way `dem-memory/src/models/reranker.ts` does
 * (`new Array(documents.length).fill(0)` then assign what came back). Padding
 * silently reorders the pool on invented zeros: the documents the provider
 * declined to score sink to the bottom as though it had judged them
 * irrelevant, which is a strictly worse ranking than the fused order the
 * caller already had. The consumer refuses that trade explicitly — see
 * `rerankDocuments`'s docblock, "a short answer is rejected outright rather
 * than padded" — but all it can see is ARITY, and a padded array has perfect
 * arity. So the check has to live here, where the holes are still visible.
 */
export async function cohereRerank(
  deps: RemoteDeps,
  endpoint: RerankEndpoint,
  args: CohereRerankArgs,
): Promise<number[] | undefined> {
  if (args.documents.length === 0) return [];

  const body = await postJson(deps, `https://${endpoint.host}/v2/rerank`, args.token, {
    model: args.model,
    query: args.query,
    documents: args.documents,
    top_n: args.documents.length,
  });

  const results = fieldOf(body, 'results');
  if (!Array.isArray(results)) return undefined;
  if (results.length !== args.documents.length) return undefined;

  const scores = new Array<number>(args.documents.length);
  const seen = new Set<number>();
  for (const result of results) {
    const index = fieldOf(result, 'index');
    if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
    if (index < 0 || index >= args.documents.length) return undefined;
    if (seen.has(index)) return undefined;
    seen.add(index);
    const score = fieldOf(result, 'relevance_score');
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
    scores[index] = score;
  }
  // Belt and braces: `seen` already proves full, distinct coverage, so this
  // can only fire if the loop above stops doing what it says. It costs one
  // pass and it is the last thing between a hole and the ranking channel.
  return validateScores(scores, args.documents.length);
}
