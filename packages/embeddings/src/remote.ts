// The two remote drivers: OpenRouter for embeddings, OpenRouter for
// reranking. (Two hooks, one provider, one credential — that is the whole
// point of TASK-523.)
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

import type { EmbedEndpoint, RerankEndpoint } from './endpoints.js';
import type { EmbeddingTask } from './wire.js';
import { validateScores, validateVectors } from './validate.js';

export interface RemoteDeps {
  /** Injected so tests never dial out. Production passes the global `fetch`. */
  fetchImpl: typeof fetch;
  /** Per-request deadline, enforced with an `AbortController`. */
  timeoutMs: number;
}

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

export interface OpenRouterEmbedArgs {
  texts: string[];
  model: string;
  token: string;
  dimensions: number;
  task: EmbeddingTask;
}

/**
 * Wire vocabulary OpenRouter expects for its Google/Gemini route.
 * `Record<EmbeddingTask, string>` rather than a switch with a `default`: a
 * third `EmbeddingTask` value added later fails this object literal at
 * compile time instead of silently falling through to a guessed default.
 */
const INPUT_TYPE_OF: Record<EmbeddingTask, string> = {
  document: 'search_document',
  query: 'search_query',
};

/**
 * Embed `texts` through OpenRouter's `/api/v1/embeddings`, placing each
 * vector BY the `index` its `data[]` entry carries — never by iteration
 * order. OpenRouter's spec does not promise the response preserves input
 * order (and the sibling Cohere-shaped rerank driver this package used to
 * carry proved that assumption wrong once already), so this is full-coverage
 * placement, the same logic `cohereRerank` used: every index in `0..n-1`
 * exactly once, or `undefined`.
 *
 * WE SEND `input_type` EXPLICITLY FOR BOTH TASKS. Walk TASK-589 measured, on
 * kind against live OpenRouter (`google/gemini-embedding-001:nitro` @ 384),
 * that OpenRouter passes `input_type` through to Gemini's task type: a bogus
 * value gets Google's 400 back on `task_type`, `search_document` yields a
 * measurably different vector from `search_query` (cosine 0.94 against the
 * query vector), and OMITTING the field is equivalent to `search_query`
 * (cosine 1.0). `task: 'document'` maps to `input_type: 'search_document'`
 * and `task: 'query'` maps to `input_type: 'search_query'` — see
 * `INPUT_TYPE_OF` above. We send it explicitly for both rather than relying
 * on the omitted default for `query`, because relying on that default is
 * exactly how TASK-523 shipped with every stored fact embedded as a query
 * (TASK-590). `remote-embed.test.ts` pins both call shapes by deep-equal.
 *
 * `model` MUST already have passed `OPENROUTER_MODEL_RE` — `plugin.ts`
 * validates both the configured model at construction and the payload-
 * supplied model on every call, even though the model now travels in the
 * body rather than the URL. See `endpoints.ts`'s grammar comment for why that
 * check is kept anyway.
 *
 * `endpoint.maxInputsPerCall` caps a single call, so a batch is chunked and
 * the chunks concatenated. IF ANY CHUNK FAILS THE WHOLE CALL ANSWERS
 * `undefined`: a partially-embedded batch is not a smaller answer, it is a
 * misaligned one — the consumer zips vectors against texts by position, so
 * text 7 would silently carry text 12's embedding.
 */
export async function openrouterEmbed(
  deps: RemoteDeps,
  endpoint: EmbedEndpoint,
  args: OpenRouterEmbedArgs,
): Promise<number[][] | undefined> {
  if (args.texts.length === 0) return [];

  const url = `https://${endpoint.host}${endpoint.path}`;

  const vectors: number[][] = [];
  for (let start = 0; start < args.texts.length; start += endpoint.maxInputsPerCall) {
    const batch = args.texts.slice(start, start + endpoint.maxInputsPerCall);
    const body = await postJson(deps, url, args.token, {
      model: args.model,
      input: batch,
      dimensions: args.dimensions,
      encoding_format: 'float',
      input_type: INPUT_TYPE_OF[args.task],
    });

    const data = fieldOf(body, 'data');
    if (!Array.isArray(data)) return undefined;
    if (data.length !== batch.length) return undefined;

    const placed = new Array<number[]>(batch.length);
    const seen = new Set<number>();
    for (const entry of data) {
      const index = fieldOf(entry, 'index');
      if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
      if (index < 0 || index >= batch.length) return undefined;
      if (seen.has(index)) return undefined;
      seen.add(index);
      // `embedding` must be an ARRAY of numbers. OpenRouter's spec allows a
      // base64-encoded string embedding for some providers; we never asked
      // for that shape (`encoding_format: 'float'`) and refuse it outright
      // rather than try to decode attacker/provider-influenced base64.
      placed[index] = fieldOf(entry, 'embedding') as number[];
    }
    const chunk = validateVectors(placed, batch.length, args.dimensions);
    if (chunk === undefined) return undefined;
    vectors.push(...chunk);
  }
  return vectors;
}

export interface OpenRouterRerankArgs {
  query: string;
  documents: string[];
  model: string;
  token: string;
}

/**
 * Score `documents` against `query` through OpenRouter's `/api/v1/rerank`,
 * returned in DOCUMENT order. The response shape is identical to the Cohere
 * one this driver replaced (`results: [{ index, relevance_score, document }]`,
 * sorted by score, each carrying its original index) — so this ports
 * `cohereRerank`'s full-coverage logic verbatim, guards and comments
 * included, under a new name.
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
export async function openrouterRerank(
  deps: RemoteDeps,
  endpoint: RerankEndpoint,
  args: OpenRouterRerankArgs,
): Promise<number[] | undefined> {
  if (args.documents.length === 0) return [];

  const body = await postJson(deps, `https://${endpoint.host}${endpoint.path}`, args.token, {
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
  // This is NOT belt-and-braces, whatever it looks like — it is the guard that
  // actually fires. The TASK-487 mutation pass deleted the arity check and the
  // `seen` check, one at a time, and the whole suite stayed green both times:
  // a short answer leaves a HOLE in this sparse array, a duplicated index
  // leaves one too (pigeonhole), and `for..of` yields `undefined` for a hole,
  // which fails the number check right here.
  //
  // So the three guards are genuinely redundant, and this is the backstop that
  // makes the other two redundant rather than the other way round. All three
  // stay — the earlier two fail fast and say which provider misbehaved, and a
  // reader deserves to know the ordering is defense in depth rather than a
  // chain where each link is load-bearing. `validate.test.ts` pins the hole
  // case on `validateScores` directly, since no through-the-bus test can tell
  // the three apart.
  return validateScores(scores, args.documents.length);
}
