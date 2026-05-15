import { z } from 'zod';

// ---------------------------------------------------------------------------
// ContentBlock — the canonical Anthropic-compatible content-block shape.
//
// This schema is the single source of truth for content blocks across:
//   - the IPC wire (runner → host event.turn-end)
//   - storage (@ax/conversations turns.content_blocks JSONB column)
//   - replay (@ax/agent-claude-sdk-runner replays history at boot)
//
// Why @ax/ipc-protocol (and not @ax/core)?
// Content blocks travel BOTH on the wire AND across plugin boundaries. The
// runner's IPC client must not depend on kernel internals, so the canonical
// declaration lives here — the schema package both sides already share.
//
// Field-name conventions:
// `media_type`, `tool_use_id`, `is_error` keep snake_case to match
// Anthropic's wire format and `@anthropic-ai/claude-agent-sdk` emissions.
// These are wire-format names; camelCasing them would force translation on
// every hop and break round-tripping with the SDK and the LLM API.
//
// Boundary review (I1):
// Anthropic's content-block tuple IS the alternate-impl set across LLM
// providers — OpenAI / Gemini wrappers translate on their side into this
// shape. So while these names look provider-specific, they're the lingua
// franca, not a leak.
// ---------------------------------------------------------------------------

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  /** Anthropic's signed thinking-block tag, when present. */
  signature: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

/**
 * Redacted thinking block. Anthropic emits this whenever extended-thinking
 * output is flagged and the cleartext is suppressed; only the opaque `data`
 * blob round-trips. Replay (Task 15) MUST preserve it verbatim — dropping
 * the block breaks Anthropic-compatibility (J3) and leaves a hole in the
 * transcript the model can detect on a follow-up turn.
 */
export const RedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  /** tool_use_id — round-trips with tool_result.tool_use_id. */
  id: z.string(),
  /** Tool name as the model emitted it. */
  name: z.string(),
  /** Arbitrary JSON; structure depends on the tool. */
  input: z.record(z.unknown()),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({
      type: z.literal('url'),
      url: z.string().url(),
    }),
  ]),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  /** Matches ToolUseBlock.id. */
  tool_use_id: z.string(),
  content: z.union([
    z.string(),
    z.array(z.discriminatedUnion('type', [TextBlockSchema, ImageBlockSchema])),
  ]),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

/**
 * Phase 1 (attachments & artifacts, 2026-05-15). Transient reference to a
 * pending upload staged in `@ax/attachments`'s temp store.
 *
 * Lives only on the POST /api/chat/messages request body. The chat-messages
 * handler resolves `attachmentId` → workspace path via `attachments:commit`
 * and rewrites this block as an `attachment` block BEFORE the message reaches
 * conversation storage or any subscriber. Never appears in stored transcripts.
 *
 * Boundary review (I1): `attachmentId` is workspace-vocab — opaque server-
 * minted identifier, no backend leak (no `lfs_oid`, no `bucket`).
 */
export const AttachmentRefBlockSchema = z.object({
  type: z.literal('attachment_ref'),
  attachmentId: z.string().min(1),
});
export type AttachmentRefBlock = z.infer<typeof AttachmentRefBlockSchema>;

/**
 * Phase 1 (attachments & artifacts, 2026-05-15). User-attached file OR
 * agent-published artifact as it appears in a stored conversation turn.
 *
 * The runner translates this variant to Anthropic-compatible types before
 * the LLM call (image/* → `image` block; PDF → `document` if SDK supports;
 * else text mention). This block is the canonical stored form (I4 — single
 * source of truth); the Anthropic shape is derived per LLM call.
 *
 * `path` is workspace-relative (e.g. ".ax/uploads/<conv>/<turn>/file.pdf"),
 * not sandbox-absolute. Resolution: workspace:read(path) at current HEAD.
 */
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  path: z.string().min(1),
  displayName: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  AttachmentRefBlockSchema,
  AttachmentBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
