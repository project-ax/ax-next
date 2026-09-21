export {
  createEmbeddingsPlugin,
  type EmbeddingsConfig,
  type RemoteEmbedConfig,
  type RemoteRerankConfig,
} from './plugin.js';
export { EMBED_HOOK, RERANK_HOOK } from './wire.js';
export type { EmbedInput, EmbedOutput, RerankInput, RerankOutput, EmbeddingTask } from './wire.js';
