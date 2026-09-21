// `@ax/embeddings` — the producer for `embeddings:embed` and
// `embeddings:rerank`.
//
// `@ax/memory-facts-sqlite` has called these two hooks since TASK-434 and
// nothing registered them, so every deployment ran with `degraded:
// ['semantic', 'ranking']`. This plugin is the other half of that seam: one
// hook, one provider plugin — so the read-path embedder and the write-path
// one stay the SAME seam rather than growing a second layer.
//
// T1 was local-only. T2 adds the two remote drivers (`remote.ts`) behind the
// same two `embedWith`/`rerankWith` seams, plus per-call credential
// resolution through `credentials:get`. Everything network lives in
// `remote.ts`; everything "which host may we talk to" lives in
// `endpoints.ts`; this file only decides WHICH MODE a hook is in and hands
// over a validated token.

import { PluginError, type AgentContext, type HookBus, type Plugin } from '@ax/core';
import { localEmbed, localRerank } from './local.js';
import {
  GCP_PROJECT_RE,
  MODEL_RE,
  embedEndpointFor,
  rerankEndpointFor,
  type EmbedEndpoint,
  type RerankEndpoint,
} from './endpoints.js';
import { cohereRerank, vertexEmbed, type RemoteDeps } from './remote.js';
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

/**
 * Default upstream deadline. Comfortably ABOVE the consumer's own 1.5s/2.0s
 * budgets on purpose: the consumer's race is the deadline that matters, and
 * this one is only a backstop so a hung socket cannot pin a request forever
 * after the caller has walked away.
 */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** The credential-store hook we call, when a remote driver is configured. */
const CREDENTIALS_HOOK = 'credentials:get';

// Locally-declared `credentials:get` shape (Invariant 2 — no cross-plugin
// imports; the hook bus is the contract, and we name only what we call). The
// same declaration lives in `@ax/llm-anthropic`, for the same reason.
interface CredentialsGetInput {
  ref: string;
  userId: string;
}

export interface RemoteEmbedConfig {
  provider: 'vertex';
  /** Credential-store ref holding the bearer token. */
  credentialRef: string;
  projectId: string;
  model?: string;
}

export interface RemoteRerankConfig {
  provider: 'cohere';
  credentialRef: string;
  model?: string;
}

export interface EmbeddingsConfig {
  /** Vector width every embedding must have. Default 384 — the fact store's vec0 column width. */
  dimensions?: number;
  /** Omit for local-only mode on this hook. */
  embed?: RemoteEmbedConfig;
  rerank?: RemoteRerankConfig;
  /** Upstream request timeout. Default 5000. */
  timeoutMs?: number;
  /** Test seam. Production callers leave this unset. */
  fetchImpl?: typeof fetch;
}

function invalidConfig(message: string): PluginError {
  return new PluginError({ code: 'invalid-config', plugin: PLUGIN_NAME, message });
}

/**
 * MODE IS DECIDED BY CONFIG, NEVER BY WHETHER A CREDENTIAL HAPPENED TO
 * RESOLVE. No `embed` key ⇒ local embed. An `embed` key ⇒ remote embed, and a
 * missing credential at call time returns `undefined` so the caller degrades
 * visibly — it does NOT quietly fall back to the hash embedder.
 *
 * The number is why. On the n=30 recall smoke, local scores 56.7% against the
 * remote stack's 80.0%. A silent fallback loses 23 points of recall while
 * every log line, every health check and every `degraded` flag still says the
 * system is fine — which is indistinguishable from working right up until
 * someone measures it. An honest `undefined` costs the same recall and says so.
 */
function resolveModel(payloadModel: string | undefined, configured: string): string | undefined {
  // A payload model WINS over the config default — the deployment that filled
  // it knows which model its stored vectors came from — but only after passing
  // the URL grammar. A payload model that fails it degrades rather than
  // throwing: it is not the caller's typo worth a write outage over, and
  // `endpoints.ts` explains what the grammar is actually stopping.
  if (payloadModel !== undefined) return MODEL_RE.test(payloadModel) ? payloadModel : undefined;
  return configured;
}

/**
 * Resolve the bearer token for ONE call, mirroring `@ax/llm-anthropic`'s
 * `resolveApiKey` minus its fallbacks: no env var, no config literal, no
 * default. The credential store is the only source, so a deployment cannot
 * accidentally acquire egress credentials from the host's environment.
 *
 * Every miss — no `userId`, no producer for `credentials:get`, a throw, a
 * non-string, an empty string — is the same `undefined`, and the caller
 * degrades. The error is NEVER logged (it can carry ref/owner detail) and
 * neither is the token.
 */
async function resolveToken(
  bus: HookBus,
  ctx: AgentContext,
  credentialRef: string,
): Promise<string | undefined> {
  // `credentials:get` requires a non-empty userId; skip the lookup for a
  // userId-less ctx rather than provoke an `invalid-payload` from it.
  if (typeof ctx.userId !== 'string' || ctx.userId.length === 0) return undefined;
  if (!bus.hasService(CREDENTIALS_HOOK)) return undefined;
  try {
    const token = await bus.call<CredentialsGetInput, string>(CREDENTIALS_HOOK, ctx, {
      ref: credentialRef,
      userId: ctx.userId,
    });
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function createEmbeddingsPlugin(config: EmbeddingsConfig = {}): Plugin {
  const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
  // Fail at CONSTRUCTION, not at the first embed. A width of 0 makes
  // `hash % dimensions` NaN and a fractional one makes every index fractional;
  // both produce a vector that looks plausible and is wrong. Boot loudly
  // instead of writing garbage into a fixed-width column for a week.
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > MAX_DIMENSIONS) {
    throw invalidConfig(
      `dimensions must be a positive integer no greater than ${MAX_DIMENSIONS} (got ${String(config.dimensions)})`,
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw invalidConfig(
      `timeoutMs must be a positive integer (got ${String(config.timeoutMs)})`,
    );
  }

  // Every remote-config error is a BOOT failure, not a first-call failure. A
  // typo'd provider id or project id cannot produce a working system later, so
  // there is nothing to gain by finding out at 3am under load instead of at
  // startup — and unlike a failed call, this one is not something the consumer
  // can degrade around.
  let embedEndpoint: EmbedEndpoint | undefined;
  if (config.embed !== undefined) {
    embedEndpoint = embedEndpointFor(config.embed.provider);
    if (embedEndpoint === undefined) {
      throw invalidConfig(`unknown embed provider '${String(config.embed.provider)}'`);
    }
    if (typeof config.embed.credentialRef !== 'string' || config.embed.credentialRef.length === 0) {
      throw invalidConfig('embed.credentialRef must be a non-empty string');
    }
    if (typeof config.embed.projectId !== 'string' || !GCP_PROJECT_RE.test(config.embed.projectId)) {
      throw invalidConfig(`embed.projectId is not a valid project id (got ${String(config.embed.projectId)})`);
    }
    if (config.embed.model !== undefined && !MODEL_RE.test(config.embed.model)) {
      throw invalidConfig(`embed.model is not a valid model id (got ${String(config.embed.model)})`);
    }
  }

  let rerankEndpoint: RerankEndpoint | undefined;
  if (config.rerank !== undefined) {
    rerankEndpoint = rerankEndpointFor(config.rerank.provider);
    if (rerankEndpoint === undefined) {
      throw invalidConfig(`unknown rerank provider '${String(config.rerank.provider)}'`);
    }
    if (
      typeof config.rerank.credentialRef !== 'string' ||
      config.rerank.credentialRef.length === 0
    ) {
      throw invalidConfig('rerank.credentialRef must be a non-empty string');
    }
    if (config.rerank.model !== undefined && !MODEL_RE.test(config.rerank.model)) {
      throw invalidConfig(`rerank.model is not a valid model id (got ${String(config.rerank.model)})`);
    }
  }

  const remoteEmbed = config.embed;
  const remoteRerank = config.rerank;
  // Wrapped rather than passed bare: a detached reference to the global
  // `fetch` is an unbound method, and the wrapper costs nothing.
  const fetchImpl: typeof fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const deps: RemoteDeps = { fetchImpl, timeoutMs };

  const degradations: string[] = [];
  if (remoteEmbed !== undefined) {
    degradations.push(
      `embeddings:embed answers undefined (the dense channel goes dark and the caller reports degraded: ['semantic']) — it does NOT fall back to the local hash embedder, which would quietly cost ~23 points of recall`,
    );
  }
  if (remoteRerank !== undefined) {
    degradations.push(
      `embeddings:rerank answers undefined (the caller keeps its fused order and reports degraded: ['ranking'])`,
    );
  }

  /** Embed: remote when configured, local otherwise. Decided by CONFIG — see `resolveModel`. */
  async function embedWith(
    bus: HookBus,
    ctx: AgentContext,
    input: EmbedInput,
  ): Promise<EmbedOutput | undefined> {
    if (remoteEmbed === undefined || embedEndpoint === undefined) {
      return { vectors: localEmbed(input.texts, dimensions) };
    }
    // Nothing to embed is a complete answer, and not one worth a credential
    // lookup or a round trip.
    if (input.texts.length === 0) return { vectors: [] };
    const model = resolveModel(input.model, remoteEmbed.model ?? embedEndpoint.defaultModel);
    if (model === undefined) return undefined;
    const token = await resolveToken(bus, ctx, remoteEmbed.credentialRef);
    if (token === undefined) return undefined;
    const vectors = await vertexEmbed(deps, embedEndpoint, {
      texts: input.texts,
      task: input.task,
      model,
      projectId: remoteEmbed.projectId,
      token,
      dimensions,
    });
    return vectors === undefined ? undefined : { vectors };
  }

  /** Rerank: remote when configured, local otherwise. Per-hook, independent of `embed`. */
  async function rerankWith(
    bus: HookBus,
    ctx: AgentContext,
    input: RerankInput,
  ): Promise<RerankOutput | undefined> {
    if (remoteRerank === undefined || rerankEndpoint === undefined) {
      return { scores: localRerank(input.query, input.documents) };
    }
    if (input.documents.length === 0) return { scores: [] };
    const model = resolveModel(input.model, remoteRerank.model ?? rerankEndpoint.defaultModel);
    if (model === undefined) return undefined;
    const token = await resolveToken(bus, ctx, remoteRerank.credentialRef);
    if (token === undefined) return undefined;
    const scores = await cohereRerank(deps, rerankEndpoint, {
      query: input.query,
      documents: input.documents,
      model,
      token,
    });
    return scores === undefined ? undefined : { scores };
  }

  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: [EMBED_HOOK, RERANK_HOOK],
      calls: [],
      // No `optionalCalls` KEY at all in local-only mode — the local drivers
      // need nothing from anybody, and `{ optionalCalls: undefined }` is a
      // different manifest from one without the key once it crosses a zod
      // parse. Conditional spread, exactly as `@ax/llm-anthropic` does it.
      ...(degradations.length > 0
        ? {
            optionalCalls: [
              {
                hook: CREDENTIALS_HOOK,
                degradation: `without a credential store: ${degradations.join('; ')}`,
              },
            ],
          }
        : {}),
      subscribes: [],
    },

    init({ bus }) {
      // No `timeoutMs` override on the registration: the CALLER already
      // enforces the budget that matters (`producers.ts` races every producer
      // against its own 1.5s/2s deadline) and the drivers enforce their own
      // socket deadline. A third ceiling here would just be a number to keep
      // in sync.
      //
      // The output type is widened to `| undefined` because that is the whole
      // remote contract: a malformed INPUT payload still throws
      // `invalid-payload` loudly (it is the caller's bug, and a caller sending
      // garbage should find out now), while every failure DOWNSTREAM of that —
      // no credential, a 500, a timeout, a wrong-shaped body — answers
      // `undefined`, which is the nullish "no answer" the consumer's `== null`
      // check is built to degrade on.
      bus.registerService<EmbedInput, EmbedOutput | undefined>(
        EMBED_HOOK,
        PLUGIN_NAME,
        async (ctx, input) => embedWith(bus, ctx, parseEmbedInput(input)),
      );

      bus.registerService<RerankInput, RerankOutput | undefined>(
        RERANK_HOOK,
        PLUGIN_NAME,
        async (ctx, input) => rerankWith(bus, ctx, parseRerankInput(input)),
      );
    },
  };
}
