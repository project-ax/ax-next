// `@ax/embeddings` — the producer for `embeddings:embed` and
// `embeddings:rerank`.
//
// `@ax/memory-facts-sqlite` has called these two hooks since TASK-434 and
// nothing registered them, so every deployment ran with `degraded:
// ['semantic', 'ranking']`. This plugin is the other half of that seam: one
// hook, one provider plugin — so the read-path embedder and the write-path
// one stay the SAME seam rather than growing a second layer.
//
// T1 is LOCAL-ONLY: no network, no credentials, no `process.env`, no `fetch`.
// That is a complete, shippable mode rather than a placeholder — see
// `local.ts` for what it costs. The remote drivers are T2, and they slot in
// behind the two `embedWith`/`rerankWith` functions below without moving
// anything else.

import { PluginError, type Plugin } from '@ax/core';
import { localEmbed, localRerank } from './local.js';
import {
  EMBED_HOOK,
  PLUGIN_NAME,
  RERANK_HOOK,
  parseEmbedInput,
  parseRerankInput,
  type EmbedInput,
  type EmbedOutput,
  type RerankInput,
  type RerankOutput,
} from './wire.js';

const PLUGIN_VERSION = '0.0.0';

/**
 * Default vector width. 384 because that is the width of the fact store's
 * vector column — a mismatch is rejected by the consumer and silently costs
 * the whole dense channel.
 */
export const DEFAULT_DIMENSIONS = 384;

/**
 * Ceiling on `dimensions`. Not a limit any model imposes; a guard on the
 * memory a single call can be asked to allocate (`texts.length × dimensions`
 * floats, and `texts.length` is already capped at 256).
 */
export const MAX_DIMENSIONS = 4096;

export interface EmbeddingsConfig {
  /** Vector width every embedding must have. Default 384 — the fact store's vec0 column width. */
  dimensions?: number;
}

/** The local mode's embed. T2 adds a remote branch here, and only here. */
function embedWith(input: EmbedInput, dimensions: number): EmbedOutput {
  return { vectors: localEmbed(input.texts, dimensions) };
}

/** The local mode's rerank. T2 adds a remote branch here, and only here. */
function rerankWith(input: RerankInput): RerankOutput {
  return { scores: localRerank(input.query, input.documents) };
}

export function createEmbeddingsPlugin(config: EmbeddingsConfig = {}): Plugin {
  const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
  // Fail at CONSTRUCTION, not at the first embed. A width of 0 makes
  // `hash % dimensions` NaN and a fractional one makes every index fractional;
  // both produce a vector that looks plausible and is wrong. Boot loudly
  // instead of writing garbage into a fixed-width column for a week.
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > MAX_DIMENSIONS) {
    throw new PluginError({
      code: 'invalid-config',
      plugin: PLUGIN_NAME,
      message: `dimensions must be a positive integer no greater than ${MAX_DIMENSIONS} (got ${String(config.dimensions)})`,
    });
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [EMBED_HOOK, RERANK_HOOK],
      calls: [],
      // No `optionalCalls` KEY at all in local-only mode — the local drivers
      // need nothing from anybody. T2 adds it conditionally, when a remote
      // driver is configured and needs a credential.
      subscribes: [],
    },

    init({ bus }) {
      // No `timeoutMs` override: the local handlers are synchronous and the
      // bus default is a hang backstop, not a latency SLA. The CALLER already
      // enforces the budget that matters (`producers.ts` races every producer
      // against its own 1.5s/2s deadline), and a second, different ceiling
      // here would just be a number to keep in sync.
      bus.registerService<EmbedInput, EmbedOutput>(EMBED_HOOK, PLUGIN_NAME, async (_ctx, input) => {
        // A malformed payload is a CALLER bug and is thrown loudly. In T1 the
        // handler cannot fail after this line.
        return embedWith(parseEmbedInput(input), dimensions);
      });

      bus.registerService<RerankInput, RerankOutput>(RERANK_HOOK, PLUGIN_NAME, async (_ctx, input) => {
        return rerankWith(parseRerankInput(input));
      });
    },
  };
}
