// ---------------------------------------------------------------------------
// @ax/channel-web — host-side server plugin.
//
// This file is the entrypoint for callers that want to mount the channel-
// web wire surface (SSE today, Tasks 9-13 will add /api/chat/* routes).
// It's deliberately separate from the package's frontend bundle (the
// vite-built React app under `src/`); a host that consumes channel-web
// only as the SSE consumer never imports React.
// ---------------------------------------------------------------------------

export {
  createChannelWebServerPlugin,
  type ChannelWebServerConfig,
} from './plugin.js';
export {
  createChunkBuffer,
  type ChunkBuffer,
  type ChunkBufferOptions,
} from './chunk-buffer.js';
export type { SseFrame, StreamChunk, StreamChunkKind } from './types.js';
// Re-export wire schemas/types for the chat-flow producer endpoint
// (POST /api/chat/messages) and the read+delete surface (Tasks 10-13).
// Internal handler factories stay private.
export {
  PostMessageRequest,
  PostMessageResponse,
  POST_MESSAGE_MAX_CONTENT_BLOCKS,
  ListConversationsQuery,
  ListConversationsResponse,
  GetConversationQuery,
  GetConversationResponse,
  ListAgentsResponse,
} from '../wire/chat.js';
