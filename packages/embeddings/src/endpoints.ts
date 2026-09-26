// The closed, frozen table of hosts this plugin is allowed to talk to, plus
// the grammar that guards the only caller-influenced piece of the request.
//
// A HOST IS NEVER CALLER-DERIVED. A deployment picks a table KEY
// (`'openrouter'`), not a URL — so no config value, and certainly no hook
// payload, can point the egress at a host of its choosing. That is Invariant
// 5 applied to network reach: the plugin's whole allowance is ONE hostname,
// `openrouter.ai`, visible in one file, greppable by anyone writing an egress
// policy. Adding a provider is a deliberate edit here with a review attached,
// not a config string.
//
// TASK-523 replaced the Vertex embed driver and the Cohere rerank driver with
// OpenRouter equivalents, on the theory that the memory preset should run on
// ONE long-lived credential (`provider:openrouter`) instead of two. The old
// two-host table (`us-central1-aiplatform.googleapis.com` +
// `api.cohere.com`) is gone, not merely unused — see the Half-Wired Code
// Policy in CLAUDE.md.

/** An OpenRouter-shaped embedding endpoint. */
export interface EmbedEndpoint {
  id: 'openrouter';
  host: string;
  path: string;
  defaultModel: string;
  /** Most `input` entries one call may carry; the driver chunks at this. OpenRouter documents no per-call cap; this is our own choice, well under its MAX_ITEMS (256). */
  maxInputsPerCall: number;
}

/** An OpenRouter-shaped rerank endpoint. */
export interface RerankEndpoint {
  id: 'openrouter';
  host: string;
  path: string;
  defaultModel: string;
}

export const EMBED_ENDPOINTS: Readonly<Record<string, EmbedEndpoint>> = Object.freeze({
  openrouter: Object.freeze({
    id: 'openrouter',
    host: 'openrouter.ai',
    path: '/api/v1/embeddings',
    defaultModel: 'google/gemini-embedding-001:nitro',
    // OpenRouter's OpenAPI spec documents no per-call input cap (MAX_ITEMS on
    // the hook is 256). 64 is our own chunk size, chosen so a maximum 256-text
    // batch is 4 sequential requests rather than 1 — see `plugin.ts`'s
    // `DEFAULT_TIMEOUT_MS` comment for the arithmetic that depends on it.
    maxInputsPerCall: 64,
  }),
});

export const RERANK_ENDPOINTS: Readonly<Record<string, RerankEndpoint>> = Object.freeze({
  openrouter: Object.freeze({
    id: 'openrouter',
    host: 'openrouter.ai',
    path: '/api/v1/rerank',
    defaultModel: 'voyageai/rerank-2.5:nitro',
  }),
});

// Own-property lookups, not plain property access — the same reasoning as
// `packages/core/src/providers.ts`'s `providerEndpointFor`: the id reaching
// here is deployment config, and a value like `constructor` or `__proto__`
// resolves THROUGH `Object.prototype` to a function or the prototype object
// rather than to `undefined`. Every caller treats a non-`undefined` result as
// a real endpoint, so a plain lookup turns a typo'd provider id into a truthy
// non-endpoint instead of a clean boot failure.

/** Look up an embed endpoint by table key. Unknown key ⇒ `undefined`. */
export function embedEndpointFor(id: string): EmbedEndpoint | undefined {
  return Object.prototype.hasOwnProperty.call(EMBED_ENDPOINTS, id) ? EMBED_ENDPOINTS[id] : undefined;
}

/** Look up a rerank endpoint by table key. Unknown key ⇒ `undefined`. */
export function rerankEndpointFor(id: string): RerankEndpoint | undefined {
  return Object.prototype.hasOwnProperty.call(RERANK_ENDPOINTS, id)
    ? RERANK_ENDPOINTS[id]
    : undefined;
}

// ---------------------------------------------------------------------------
// Model grammar
// ---------------------------------------------------------------------------
//
// Unlike the Vertex driver this replaced, the model no longer lands in the
// request URL — OpenRouter takes it in the JSON BODY (`{ model, ... }`). That
// removes the path-traversal risk a URL-interpolated model carried, but the
// grammar check stays anyway, as DEFENSE IN DEPTH: a `model` is still
// deployment- or payload-supplied, still crosses a trust boundary either way
// (see `plugin.ts`'s model resolution), and a strict allow-list costs nothing
// to keep. A payload model failing the grammar degrades to `undefined`, same
// as before; a CONFIG model failing it is a boot-time `invalid-config`.
//
// OpenRouter model ids are `vendor/model[:variant]` — `google/gemini-
// embedding-001:nitro`, `voyageai/rerank-2.5:nitro`, `openai/text-embedding-
// 3-small` — which is why this is a different shape from the old
// `MODEL_RE` (Vertex/Cohere native ids never carried `/`). Lowercase,
// bounded, one slash, at most one colon-prefixed variant.
export const OPENROUTER_MODEL_RE =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}(?::[a-z0-9_-]{1,32})?$/;
