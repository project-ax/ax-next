import type { AuthClient } from "google-auth-library";
import type { EmbeddingFn, EmbeddingTask } from "../types.js";
import { EMBEDDING_DIMENSIONS } from "../db/memory-repository.js";

export { EMBEDDING_DIMENSIONS };

export const DEFAULT_VERTEX_REGION = "us-central1";
export const DEFAULT_VERTEX_EMBEDDING_MODEL = "text-embedding-005";
export const MAX_INSTANCES_PER_VERTEX_CALL = 5;

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function assertDimensions(vector: number[], source: string): number[] {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `${source} produced a ${vector.length}-dimensional embedding; the vector index requires ${EMBEDDING_DIMENSIONS}`,
    );
  }
  return vector;
}

export interface VertexEmbedderOptions {
  projectId?: string;
  region?: string;
  model?: string;
  accessToken?: string;
  outputDimensionality?: number;
}

const TASK_TYPES: Record<EmbeddingTask, string> = {
  document: "RETRIEVAL_DOCUMENT",
  query: "RETRIEVAL_QUERY",
};

interface VertexPrediction {
  embeddings?: { values?: number[] };
}

export function createVertexEmbedder(options: VertexEmbedderOptions = {}): EmbeddingFn {
  const region = options.region ?? process.env.DEM_VERTEX_REGION ?? DEFAULT_VERTEX_REGION;
  const model = options.model ?? process.env.DEM_VERTEX_EMBED_MODEL ?? DEFAULT_VERTEX_EMBEDDING_MODEL;
  const outputDimensionality = options.outputDimensionality ?? EMBEDDING_DIMENSIONS;

  interface VertexCredentials {
    explicitToken?: string;
    projectId: string;
    client?: AuthClient;
  }

  let credentialsPromise: Promise<VertexCredentials> | null = null;

  const loadCredentials = (): Promise<VertexCredentials> => {
    if (credentialsPromise === null) {
      const explicitToken = options.accessToken ?? process.env.DEM_VERTEX_ACCESS_TOKEN;
      const explicitProject =
        options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? "";
      if (explicitToken) {
        credentialsPromise = Promise.resolve({
          explicitToken,
          projectId: explicitProject,
        });
      } else {
        credentialsPromise = (async () => {
          const { GoogleAuth } = await import("google-auth-library");
          const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
          const projectId = explicitProject || (await auth.getProjectId());
          const client = await auth.getClient();
          return { projectId, client };
        })();
      }
    }
    return credentialsPromise;
  };

  return async (texts, task = "document") => {
    if (texts.length === 0) return [];
    const credentials = await loadCredentials();

    let token: string;
    if (credentials.explicitToken) {
      token = credentials.explicitToken;
    } else if (credentials.client) {
      const access = await credentials.client.getAccessToken();
      token = access.token ?? "";
    } else {
      throw new Error("Vertex AI credentials were not initialized");
    }
    if (!token) throw new Error("Failed to obtain a Vertex AI access token");
    if (!credentials.projectId) {
      throw new Error(
        "Vertex AI project id is required (set GOOGLE_CLOUD_PROJECT or options.projectId)",
      );
    }

    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${credentials.projectId}/locations/${region}/publishers/google/models/${model}:predict`;
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += MAX_INSTANCES_PER_VERTEX_CALL) {
      const batch = texts.slice(start, start + MAX_INSTANCES_PER_VERTEX_CALL);
      let lastError: unknown;
      let payload: { predictions?: VertexPrediction[] } | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              instances: batch.map((text) => ({
                content: text,
                task_type: TASK_TYPES[task],
              })),
              parameters: { outputDimensionality },
            }),
          });
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(
              `Vertex AI embedding request failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
            continue;
          }
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Vertex AI embedding request failed (${response.status}): ${detail}`);
          }
          payload = (await response.json()) as { predictions?: VertexPrediction[] };
          break;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Vertex AI embedding request failed") &&
            !error.message.startsWith("Vertex AI embedding request failed (429") &&
            !error.message.startsWith("Vertex AI embedding request failed (5")
          ) {
            throw error;
          }
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      if (payload === null) {
        throw lastError instanceof Error ? lastError : new Error("Vertex AI embedding request failed");
      }
      const predictions = payload.predictions ?? [];
      if (predictions.length !== batch.length) {
        throw new Error(
          `Vertex AI returned ${predictions.length} predictions for ${batch.length} instance(s)`,
        );
      }
      for (const prediction of predictions) {
        const values = prediction.embeddings?.values;
        if (!values) throw new Error("Vertex AI prediction is missing embeddings.values");
        vectors.push(assertDimensions(values, `vertex embedder ${model}`));
      }
    }

    return vectors;
  };
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function hashEmbedder(dimensions: number = EMBEDDING_DIMENSIONS): EmbeddingFn {
  return async (texts) =>
    texts.map((text) => {
      const buckets = new Map<number, number>();
      const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      for (const token of tokens) {
        const hash = fnv1a(token);
        const index = hash % dimensions;
        const sign = (hash >>> 31) === 1 ? -1 : 1;
        buckets.set(index, (buckets.get(index) ?? 0) + sign);
      }
      const vector = new Array<number>(dimensions).fill(0);
      for (const [index, value] of buckets) vector[index] = value;
      const norm = Math.hypot(...vector);
      return assertDimensions(
        vector.map((value) => (norm === 0 ? 0 : value / norm)),
        "hash embedder",
      );
    });
}
