import { z } from 'zod';
import { ContentBlockSchema, type ContentBlock } from '@ax/ipc-protocol';

// ---------------------------------------------------------------------------
// Conversation / Turn shapes — mirror @ax/conversations' canonical
// `Conversation` / `Turn` types (Invariant I4, single source of truth lives
// there). We don't import from @ax/conversations because Invariant I2
// forbids cross-plugin imports in the channel-web wire surface; instead, we
// duplicate the shape here as a zod schema and rely on the type-shape
// match to be reviewed when @ax/conversations widens its type. Drift
// surfaces at test time (the round-trip JSON test will fail).
// ---------------------------------------------------------------------------

const ConversationShape = z.object({
  conversationId: z.string(),
  userId: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  activeReqId: z.string().nullable(),
  /** ISO-8601. */
  createdAt: z.string(),
  /** ISO-8601. */
  updatedAt: z.string(),
});

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
 * by the route handler to feed `agent:invoke`'s flat-string `message` field
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

// ---------------------------------------------------------------------------
// GET /api/chat/conversations — list user's conversations.
// Optional ?agentId= filter; soft-deleted rows excluded by the store.
//
// IMPORTANT: @ax/http-server lowercases query-param keys before delivering
// them to the handler. The schema's input field is `agentid` (lowercased)
// so the zod parse hits; we transform to the canonical `agentId` shape so
// callers see proper camelCase. Same posture for GetConversationQuery.
// ---------------------------------------------------------------------------

export const ListConversationsQuery = z
  .object({
    agentid: z.string().min(1).optional(),
  })
  .transform((v) => ({ agentId: v.agentid }));
export type ListConversationsQuery = z.infer<typeof ListConversationsQuery>;

export const ListConversationsResponse = z.array(ConversationShape);
export type ListConversationsResponse = z.infer<
  typeof ListConversationsResponse
>;

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id — load conversation with turns.
//
// `?includeThinking` defaults to false. When false the handler strips
// `thinking` AND `redacted_thinking` content blocks from each turn (the
// latter has no human-readable content and would otherwise be a UI noise
// source). Reserved for the Task 21 thinking-block UI toggle (Invariant J4).
// ---------------------------------------------------------------------------

export const GetConversationQuery = z
  .object({
    includethinking: z
      .union([
        z.literal('true'),
        z.literal('false'),
        z.literal('1'),
        z.literal('0'),
      ])
      .optional(),
  })
  .transform((v) => ({
    includeThinking: v.includethinking === 'true' || v.includethinking === '1',
  }));
export type GetConversationQuery = z.infer<typeof GetConversationQuery>;

const TurnShape = z.object({
  turnId: z.string(),
  turnIndex: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool']),
  contentBlocks: z.array(ContentBlockSchema),
  /** ISO-8601. */
  createdAt: z.string(),
});

export const GetConversationResponse = z.object({
  conversation: ConversationShape,
  turns: z.array(TurnShape),
});
export type GetConversationResponse = z.infer<typeof GetConversationResponse>;

// ---------------------------------------------------------------------------
// GET /api/chat/agents — list user's agents for the AgentMenu.
//
// Display-relevant subset of @ax/agents' `Agent` shape. We deliberately
// drop `systemPrompt`, `allowedTools`, `mcpConfigIds`, `model`,
// `workspaceRef`, and ownership fields: a chat-flow consumer doesn't need
// them, and surfacing them through this route would be a needless
// information-disclosure surface (Invariant I5 — capabilities minimized).
// The full agent record is still reachable via the admin API.
//
// Slug derivation note: a frontend that wants short URLs can derive
// `slug = agentId.slice(0, 8)`; the URL-routing on inbound requests should
// resolve via the full agentId (which the frontend retains in state). For
// MVP we don't include slug — Task 18's AgentMenu wiring decides the
// presentation policy.
// ---------------------------------------------------------------------------

export const ListAgentsResponse = z.array(
  z.object({
    agentId: z.string(),
    displayName: z.string(),
    visibility: z.enum(['personal', 'team']),
  }),
);
export type ListAgentsResponse = z.infer<typeof ListAgentsResponse>;
