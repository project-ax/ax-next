// The closed, frozen table of hosts this plugin is allowed to talk to, plus
// the two grammars that guard the only caller-influenced pieces of the URL.
//
// A HOST IS NEVER CALLER-DERIVED. A deployment picks a table KEY (`'vertex'`,
// `'cohere'`), not a URL — so no config value, and certainly no hook payload,
// can point the egress at a host of its choosing. That is Invariant 5 applied
// to network reach: the plugin's whole allowance is two hostnames, visible in
// one file, greppable by anyone writing an egress policy. Adding a provider is
// a deliberate edit here with a review attached, not a config string.

/** A Vertex-shaped embedding endpoint. */
export interface EmbedEndpoint {
  id: 'vertex';
  host: string;
  region: string;
  defaultModel: string;
  /** Most `instances` one predict call may carry; the driver chunks at this. */
  maxInstancesPerCall: number;
}

/** A Cohere-shaped rerank endpoint. */
export interface RerankEndpoint {
  id: 'cohere';
  host: string;
  defaultModel: string;
}

export const EMBED_ENDPOINTS: Readonly<Record<string, EmbedEndpoint>> = Object.freeze({
  vertex: Object.freeze({
    id: 'vertex',
    host: 'us-central1-aiplatform.googleapis.com',
    region: 'us-central1',
    defaultModel: 'text-embedding-005',
    // Vertex rejects a predict call carrying more than 5 instances. Ported
    // from `dem-memory/src/models/embeddings.ts`'s MAX_INSTANCES_PER_VERTEX_CALL.
    maxInstancesPerCall: 5,
  }),
});

export const RERANK_ENDPOINTS: Readonly<Record<string, RerankEndpoint>> = Object.freeze({
  cohere: Object.freeze({
    id: 'cohere',
    host: 'api.cohere.com',
    defaultModel: 'rerank-v4.0-pro',
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
// Grammars
// ---------------------------------------------------------------------------
//
// Both values below are INTERPOLATED INTO A REQUEST URL, so both are checked
// against a strict allow-list grammar before they get there. "Deployment-
// supplied" is not the same as "trusted": a `model` of `../../../elsewhere` is
// a path-traversal primitive against an API URL — it walks off the
// `publishers/google/models/` path and sends a bearer token, plus a batch of
// somebody's memory, to whatever sits at the other end. Same for a `?` or `#`
// that reinterprets the rest of the URL as a query or a fragment.
//
// `@` IS allowed, deliberately: Vertex pins model versions with it
// (`text-embedding-005@002`), and inside a path segment it is inert — userinfo
// only exists in an authority, which needs a `//` the grammar forbids. What
// the grammar actually stops is `/` (without which there is no traversal at
// all), a leading `.`, `?`, `#`, `%`, whitespace and everything non-ASCII.
//
// The `model` in the HOOK PAYLOAD lands on this same path — the consumer fills
// it from its own config, and a hook payload crosses a trust boundary either
// way — so it is validated identically. See `plugin.ts`'s model resolution.

/** Lowercase provider-native model ids: `text-embedding-005`, `rerank-v4.0-pro`. */
export const MODEL_RE = /^[a-z0-9][a-z0-9.@_-]{0,63}$/;

/** GCP project ids: 5–30 chars, lowercase letter first, then letters/digits/hyphens. */
export const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,29}$/;
