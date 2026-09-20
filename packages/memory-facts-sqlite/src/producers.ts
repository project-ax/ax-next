// The embedder / reranker seam (TASK-434 T4).
//
// Both are injected as a HOOK NAME plus an optional model, never as a function
// handed in through plugin config. That is the in-repo precedent twice over —
// `presets/k8s` hands `@ax/memory-strata` `orchestrator: { hook, model }`, and
// `@ax/llm-anthropic` declares `credentials:get` under `optionalCalls` and
// falls back cleanly when nothing registers it — and it is what keeps this
// read-path embedder and §3.3's write-path (slot-normalization) one the SAME
// seam: one hook, one provider plugin, one credential, one egress host.
// Handing in a closure instead would have produced the "two embedder seams,
// two layers" the 2026-09-20 handoff §1 warned about.
//
// NOTHING REGISTERS THESE YET, and that is the designed state rather than
// half-wired code: with no producer the dense and rerank channels are absent
// and `recall` reports `degraded: ['semantic', 'ranking']` — §4.4's
// observable degraded mode. `bootstrap.ts`'s `verifyCalls` deliberately skips
// `optionalCalls`, so an absent producer is non-fatal at boot. A real provider
// needs credential-store keys, egress-lock allowlisting and a
// `PROVIDER_ENDPOINTS` entry, which is its own card with its own security
// review.

import type { AgentContext, HookBus } from '@ax/core';

/** A configured producer: which hook to route through, and optionally which model. */
export interface ProducerRef {
  hook: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------
//
// VENDOR-NEUTRAL, and that is a hard constraint rather than a preference
// (Invariant 1; design Appendix B's "`RRF`, `vec0`, `FTS5`, `cosine` do not
// appear in any payload"). No `cosine`, no dimension count, no provider or
// model-family name, no `instances`/`RETRIEVAL_DOCUMENT`-style vendor enum: a
// Vertex-shaped, a Cohere-shaped and an on-cluster producer all have to be
// able to satisfy these without the caller knowing which it got.
//
// These interfaces describe a hook this plugin CALLS, so the schema of record
// belongs to whichever plugin eventually registers it (the follow-up provider
// card). They are declared here, structurally, because there is no producer
// to own them yet — and a plugin cannot import another plugin's types anyway
// (Invariant 2).

/**
 * `task` is the one field that looks like it might leak and does not: "am I
 * embedding a stored document or a search query" is a property of the CALLER's
 * intent, not of any backend, and every embedding API worth using distinguishes
 * them (asymmetric models score noticeably worse when the two are conflated).
 * A producer whose model has no such distinction ignores it.
 */
export interface EmbedInput {
  texts: string[];
  task: 'document' | 'query';
  /** Producer-native model id, when the deployment pinned one. */
  model?: string;
}

export interface EmbedOutput {
  /** One vector per input text, in input order. */
  vectors: number[][];
}

export interface RerankInput {
  query: string;
  documents: string[];
  model?: string;
}

export interface RerankOutput {
  /** One relevance score per input document, in input order. Higher is better. */
  scores: number[];
}

// ---------------------------------------------------------------------------
// Budgets (design §4.4, provisional until measured)
// ---------------------------------------------------------------------------

/** Embed budget. Past it the dense channel is skipped and `'semantic'` is raised. */
export const EMBED_TIMEOUT_MS = 1_500;

/** Rerank budget. Past it the fused order stands and `'ranking'` is raised. */
export const RERANK_TIMEOUT_MS = 2_000;

/**
 * Call an optional producer under a hard budget, returning `undefined` for
 * EVERY way it can fail to answer — no hook configured, no producer
 * registered, a throw, or the budget expiring.
 *
 * Collapsing those into one `undefined` is the §4.4 contract, not laziness: a
 * recall whose embedder timed out and a recall with no embedder at all are the
 * same answer built the same way, and both are reported as one `degraded`
 * flag. What is NOT collapsed into it is a STORE failure — that is thrown from
 * elsewhere in the handler and surfaces as `store-unavailable`, because "we
 * could not read your memory" and "we read your memory with one channel
 * fewer" are different answers and only one of them is safe to render as
 * facts.
 *
 * The timeout is enforced here rather than relying on `HookBus`'s own service
 * timeout: that one is a whole-bus default measured in tens of seconds, and by
 * the time it fires the recall this call was serving is long past useful.
 *
 * The losing promise is deliberately given a no-op `catch`. Once the race is
 * decided nothing awaits it, and a producer that rejects a second later would
 * otherwise take the process down with an unhandled rejection.
 */
export async function callProducer<I, O>(
  bus: HookBus,
  ctx: AgentContext,
  ref: ProducerRef | undefined,
  input: I,
  budgetMs: number,
): Promise<O | undefined> {
  if (ref === undefined || ref.hook.length === 0) return undefined;
  if (!bus.hasService(ref.hook)) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = bus.call<I, O>(ref.hook, ctx, input);
    pending.catch(() => {});
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    });
    return await Promise.race([pending, budget]);
  } catch {
    // A producer that threw is a producer that did not answer. See the
    // docblock: the caller raises the flag and carries on.
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Embed `texts`, or return `undefined` if the producer could not.
 *
 * The shape checks are not paranoia about a hostile producer so much as about
 * a misconfigured one: a hook name pointing at the wrong service returns
 * something with no `vectors`, and a provider configured for the wrong model
 * returns the right count at the wrong dimensionality.
 *
 * A wrong-shaped ANSWER degrades rather than throwing, and that division is
 * the point. A producer response crosses a trust boundary (Invariant 5), so it
 * is validated here and a bad one is simply "the producer did not answer" —
 * one misconfigured provider must not take down every `memory:facts:record`
 * in the deployment. `vectorToBlob`'s throw stays underneath it as an
 * assertion about OUR code: if a vector reaches the store at the wrong
 * dimensionality, the check that should have caught it is this one, and a
 * silent write into a fixed-width `vec0` column would compare distances over
 * the wrong number of floats forever.
 */
export async function embedTexts(
  bus: HookBus,
  ctx: AgentContext,
  ref: ProducerRef | undefined,
  texts: string[],
  task: EmbedInput['task'],
  dimensions: number,
): Promise<number[][] | undefined> {
  if (texts.length === 0) return [];
  const out = await callProducer<EmbedInput, EmbedOutput>(
    bus,
    ctx,
    ref,
    { texts, task, ...(ref?.model !== undefined ? { model: ref.model } : {}) },
    EMBED_TIMEOUT_MS,
  );
  // `== null`, NOT `=== undefined`. `HookBus.call` returns a handler's raw
  // value when the hook declares no `returns` schema, and no realistic provider
  // will declare one — so a handler resolving to `null` arrives here intact. A
  // strict `=== undefined` is `false` for it, control falls through to
  // `out.vectors`, and the TypeError escapes from OUTSIDE `inStore`: one
  // misconfigured provider becomes a deployment-wide write outage. Loose `==`
  // is deliberate and covers both nullish values.
  if (out == null || !Array.isArray(out.vectors)) return undefined;
  if (out.vectors.length !== texts.length) return undefined;
  const wellFormed = out.vectors.every(
    (vector) =>
      Array.isArray(vector) &&
      vector.length === dimensions &&
      vector.every((v) => typeof v === 'number' && Number.isFinite(v)),
  );
  return wellFormed ? out.vectors : undefined;
}

/**
 * Score `documents` against `query`, or return `undefined` if the producer
 * could not. A short answer is rejected outright rather than padded: a
 * partially-scored pool reorders on invented zeros, which is a worse answer
 * than the fused order the caller already has.
 */
export async function rerankDocuments(
  bus: HookBus,
  ctx: AgentContext,
  ref: ProducerRef | undefined,
  query: string,
  documents: string[],
): Promise<number[] | undefined> {
  if (documents.length === 0) return undefined;
  const out = await callProducer<RerankInput, RerankOutput>(
    bus,
    ctx,
    ref,
    { query, documents, ...(ref?.model !== undefined ? { model: ref.model } : {}) },
    RERANK_TIMEOUT_MS,
  );
  // `== null` for the same reason as `embedTexts` above — see that comment.
  if (out == null || !Array.isArray(out.scores)) return undefined;
  if (out.scores.length !== documents.length) return undefined;
  if (out.scores.some((s) => typeof s !== 'number' || !Number.isFinite(s))) return undefined;
  return out.scores;
}
