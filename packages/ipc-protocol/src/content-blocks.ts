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
 * else text mention — see `formatAttachmentMention`). This block is the
 * *intended* canonical shape for a user-attached file (I4 — single source of
 * truth); the Anthropic shape is derived per LLM call.
 *
 * NOTE (runner-owned-sessions): the runner's translation is what the SDK
 * actually persists to its native jsonl transcript, so a reopened chat's
 * `attachment` block is reconstructed from the stored text-mention on the
 * read path (`@ax/conversations` getConversation) — see
 * `parseAttachmentMention`. The block below is still the canonical *render*
 * shape the rest of the system consumes.
 *
 * `path` is workspace-relative (e.g. ".ax/uploads/<conv>/<turn>/file.pdf"),
 * not sandbox-absolute. Resolution: workspace:read(path) at current HEAD.
 */
/**
 * `path` is workspace-relative — defense-in-depth refusal of absolute
 * paths, `..` traversal segments, Windows drive roots, and NUL bytes at
 * the wire boundary so a malformed value can't reach storage or
 * `attachments:download` and bypass the path-scope ACL.
 */
export function isWorkspaceRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (value.includes('\0')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  for (const seg of value.split(/[\\/]/)) {
    if (seg === '..') return false;
  }
  return true;
}

export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  path: z
    .string()
    .min(1)
    .refine(
      isWorkspaceRelativePath,
      'path must be workspace-relative (no leading slash, no "..", no drive root, no NUL)',
    ),
  displayName: z.string().min(1),
  mediaType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;

// ---------------------------------------------------------------------------
// Attachment text-mention — the lossy, model-facing form of an attachment.
//
// When the runner can't (or shouldn't) inline an attachment's bytes for the
// model — a PDF without document-block support, an oversized text file, an
// unrecognized binary — it emits this one-line mention instead of the
// `attachment` block. Under runner-owned-sessions the SDK persists *this*
// (not the `attachment` block) to its jsonl transcript, so the read path has
// to turn it back into an `attachment` block to render the chip.
//
// `formatAttachmentMention` is the SINGLE producer of the string (the runner's
// `attachment-translation.ts` calls it); `parseAttachmentMention` is the
// SINGLE consumer (the conversations read path calls it). Co-locating the
// pair here means the two ends can never drift.
// ---------------------------------------------------------------------------

export interface AttachmentMentionFields {
  displayName: string;
  /** Workspace-relative path, e.g. ".ax/uploads/<conv>/<turn>/<file>". */
  path: string;
  mediaType: string;
}

/** Render the canonical one-line attachment mention. */
export function formatAttachmentMention(att: AttachmentMentionFields): string {
  return `User attached '${att.displayName}' at ${att.path} (${att.mediaType})`;
}

const ATTACHMENT_MENTION_RE = /^User attached '(.*?)' at (.+) \(([^)]+)\)$/;

/**
 * Parse a one-line attachment mention produced by `formatAttachmentMention`,
 * or `null` if `text` isn't exactly one such mention.
 *
 * Anchoring relies on one fact the producer guarantees: the mention is a
 * single line. `^…$` (no `s` flag) refuses any text with embedded newlines,
 * so a merged "user-text\nmention" block is split by the caller before
 * reaching here.
 *
 * `displayName` is matched non-greedily up to the first ` at `; the path is
 * greedy and may contain spaces (workspace-relative paths are allowed to —
 * see `isWorkspaceRelativePath`), backtracking to the final ` (<mediaType>)`
 * which the `[^)]+` end-anchor pins. The reconstructed block is re-validated
 * against `AttachmentBlockSchema` by the caller, so a path that slips through
 * here but isn't workspace-relative is still rejected downstream.
 */
export function parseAttachmentMention(
  text: string,
): AttachmentMentionFields | null {
  const m = text.match(ATTACHMENT_MENTION_RE);
  if (m === null) return null;
  const [, displayName, path, mediaType] = m;
  if (
    displayName === undefined ||
    path === undefined ||
    mediaType === undefined
  ) {
    return null;
  }
  if (displayName.length === 0 || mediaType.length === 0) return null;
  return { displayName, path, mediaType };
}

// ---------------------------------------------------------------------------
// Inlined-attachment text block — the model-facing form when the runner CAN
// inline an attachment's bytes (a small text/json/yaml/csv file). The model
// gets the content directly in the prompt (weak-model accommodation), but the
// FIRST line is the canonical `formatAttachmentMention` line so the read path
// can (a) reconstruct the download chip from the embedded path and (b) strip
// the entire model-view block (preamble + content) instead of leaking it into
// the user-visible transcript.
//
// `formatAttachmentInline` is the SINGLE producer (the runner's
// `attachment-translation.ts` inline branch). The read path
// (`@ax/conversations` reconstructAttachmentBlocks) is the SINGLE consumer: it
// keys off `parseAttachmentMention` matching the FIRST line of a user-turn
// text block. Co-locating the pair here keeps the two ends from drifting —
// the same posture as the mention pair above. The blank line between the
// mention and the content makes the boundary visually obvious to the model
// and keeps the mention strictly single-line (so `parseAttachmentMention`'s
// `^…$` anchor matches it).
// ---------------------------------------------------------------------------

/**
 * Render an inlined-attachment text block: the canonical path-bearing mention
 * on the first line, a blank separator, then the file content.
 */
export function formatAttachmentInline(
  fields: AttachmentMentionFields,
  content: string,
): string {
  return `${formatAttachmentMention(fields)}\n\n${content}`;
}

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
