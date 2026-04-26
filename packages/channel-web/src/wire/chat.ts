import { z } from 'zod';
import { ContentBlockSchema, type ContentBlock } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// @ax/channel-web wire schemas — `/api/chat/messages`
//
// These zod schemas describe the JSON shape the browser sends/receives on
// the chat-flow producer endpoint. The handler validates inbound bodies
// against `PostMessageRequest` and serializes outbound payloads through
// `PostMessageResponse`.
//
// Boundary review (I1):
//   - Field names — `conversationId`, `agentId`, `reqId`, `contentBlocks` —
//     are LLM-API vocabulary, not transport/storage vocabulary. A future
//     GraphQL or RPC variant would register the same shapes verbatim.
//   - `contentBlocks` is the canonical Anthropic-compatible shape from
//     @ax/ipc-protocol; it's already the lingua franca across LLM providers
//     (OpenAI / Gemini wrappers translate INTO this shape).
//
// Why a separate `wire/` directory:
//   - The pattern matches Week 9.5's admin-routes split (@ax/agents,
//     @ax/auth-oidc) where the on-the-wire shape is locked away from the
//     internal handler factory. A consumer that only needs the request /
//     response Zod schemas (e.g. a browser fetch helper) imports this file
//     without dragging in @ax/core or http-server adapters.
// ---------------------------------------------------------------------------

/**
 * Cap on the number of content blocks per outgoing user message. A single
 * text turn is the common case; multi-block uploads (image + caption) are
 * a small N. 20 is comfortably above the realistic ceiling and tightens
 * the http-server's 1 MiB body cap further at the schema layer.
 */
export const POST_MESSAGE_MAX_CONTENT_BLOCKS = 20;

export const PostMessageRequest = z.object({
  /** `null` means "create a new conversation". */
  conversationId: z.string().nullable(),
  /**
   * Required for new conversations; verified-equal to the existing row's
   * frozen agentId for existing conversations (Invariant I10 — session-
   * agent immutability).
   */
  agentId: z.string().min(1),
  /** User's outgoing message. Usually a single text block. */
  contentBlocks: z
    .array(ContentBlockSchema)
    .min(1, 'contentBlocks must have at least one block')
    .max(
      POST_MESSAGE_MAX_CONTENT_BLOCKS,
      `contentBlocks must have at most ${POST_MESSAGE_MAX_CONTENT_BLOCKS} blocks`,
    ),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const PostMessageResponse = z.object({
  conversationId: z.string(),
  /**
   * Server-minted (J9). The browser uses this to subscribe to
   * `GET /api/chat/stream/:reqId` for streaming output. NEVER accepted
   * from the client side — any client-supplied reqId in the request body
   * would be ignored anyway because the schema doesn't carry one.
   */
  reqId: z.string(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

/**
 * Pull the first text block's `text` out of a content-blocks array. Used
 * by the route handler to feed `chat:run`'s flat-string `message` field
 * for the SDK's first turn. Non-text blocks (images, tool results) are
 * preserved verbatim in the conversation row and replayed in Task 15.
 *
 * Returns a placeholder string when no text block is present so the SDK
 * still has something to feed the model — better than crashing when a
 * user sends only an image. (The conversation row is the source of truth;
 * the runner's history-replay sees the full block list.)
 */
export function extractText(blocks: ContentBlock[]): string {
  for (const block of blocks) {
    if (block.type === 'text') return block.text;
  }
  return '[non-text content]';
}
