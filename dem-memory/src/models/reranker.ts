import type { RerankFn } from "../types.js";

export const DEFAULT_COHERE_RERANKER_MODEL = "rerank-v4.0-pro";
export const DEFAULT_COHERE_BASE_URL = "https://api.cohere.com";

export interface CohereRerankerOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface CohereRerankResult {
  index: number;
  relevance_score: number;
}

export function createCohereReranker(options: CohereRerankerOptions = {}): RerankFn {
  return async (query, documents) => {
    if (documents.length === 0) return [];
    const apiKey = options.apiKey ?? process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error("Cohere reranker requires an API key (set COHERE_API_KEY or options.apiKey)");
    }
    const model = options.model ?? process.env.DEM_COHERE_RERANK_MODEL ?? DEFAULT_COHERE_RERANKER_MODEL;
    const baseUrl = (
      options.baseUrl ?? process.env.DEM_COHERE_BASE_URL ?? DEFAULT_COHERE_BASE_URL
    ).replace(/\/$/, "");

    const response = await fetch(`${baseUrl}/v2/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Cohere rerank request failed (${response.status}): ${detail}`);
    }

    const payload = (await response.json()) as { results?: CohereRerankResult[] };
    const results = payload.results ?? [];
    const scores = new Array<number>(documents.length).fill(0);
    for (const result of results) {
      scores[result.index] = result.relevance_score;
    }
    return scores;
  };
}

export function lexicalReranker(): RerankFn {
  return async (query, documents) => {
    const queryTokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    if (queryTokens.size === 0) return documents.map(() => 0);
    return documents.map((document) => {
      const docTokens = new Set(document.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      let overlap = 0;
      for (const token of queryTokens) {
        if (docTokens.has(token)) overlap += 1;
      }
      return overlap / queryTokens.size;
    });
  };
}
