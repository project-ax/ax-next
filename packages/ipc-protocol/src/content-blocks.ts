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
  /**
   * Host-authored activity label for the tool (TASK-271), attached by the
   * runner from its `tool.list` catalog so the transcript can render a
   * human-readable phrase instead of the wire identifier. Optional:
   * pre-phrase runners omit it and renderers fall back to the stripped name.
   * Any string parses — fencing is `sanitizeActivityPhrase` at the IPC
   * ingress, never the parser (a hostile phrase must not drop the block).
   */
  activityPhrase: z.string().optional(),
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
  /**
   * The call never ran: it is waiting on a human (TASK-270). Set by the
   * runner at publish time from its own per-turn hold record (the honest
   * source — never inferred from content downstream). Optional: rows
   * persisted before the flag existed omit it, and readers must NOT
   * string-match the result copy to reconstruct it. A boolean needs no
   * trust-boundary fencing (unlike `activityPhrase`); the ingress only
   * type-guards it.
   */
  held: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

/**
 * Phase 1 (attachments & artifacts, 2026-05-15). Transient reference to a
 * pending upload staged in `@ax/attachments`'s temp store.
 *
 * Lives only on the POST /api/chat/messages request body. The chat-messages
 * handler commits the upload via `attachments:commit` and rewrites this block
 * as an `attachment` block carrying the same id, BEFORE the message reaches
 * conversation storage or any subscriber. Never appears in stored transcripts.
 *
 * Boundary review (I1): `attachmentId` is an opaque server-minted identifier,
 * no backend leak (no `lfs_oid`, no `bucket`).
 */
export const AttachmentRefBlockSchema = z.object({
  type: z.literal('attachment_ref'),
  attachmentId: z.string().min(1),
});
export type AttachmentRefBlock = z.infer<typeof AttachmentRefBlockSchema>;

/**
 * An attachment id: a store-temp UUID for an upload, a hex id for a published
 * artifact. Opaque — nothing parses it; callers only hand it back to
 * `@ax/attachments` (download, list). The character set keeps it inert
 * anywhere it travels (URLs, logs, file names): no `/`, `\`, `.`, NUL or
 * whitespace.
 */
export const AttachmentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Longest `filename` an `attachment` block may carry (UTF-16 code units). */
export const ATTACHMENT_FILENAME_MAX = 1024;
/**
 * Longest `mediaType` an `attachment` block may carry. RFC 6838 caps a type
 * and a subtype at 127 characters each, so a bare media type fits in 255.
 */
export const ATTACHMENT_MEDIA_TYPE_MAX = 255;

/** Longest artifact title (UTF-16 code units), after normalization. */
export const ARTIFACT_TITLE_MAX = 200;

/**
 * What kind of thing an artifact is, as people see it. The one definition:
 * `@ax/attachments` derives it from the stored media type, and the wire and
 * channel-web read it from here.
 */
export const ArtifactKindSchema = z.enum(['document', 'web', 'spreadsheet', 'image', 'code', 'file']);

/**
 * The words a person (and the agent's artifact list) sees for each kind. One
 * map, so the agent's notes and channel-web never drift apart.
 */
export const ARTIFACT_KIND_LABELS = {
  document: 'Document',
  web: 'Web page',
  spreadsheet: 'Spreadsheet',
  image: 'Image',
  code: 'Code',
  file: 'File',
} as const satisfies Record<z.infer<typeof ArtifactKindSchema>, string>;

/**
 * A user-attached file OR an agent-published artifact, as it appears in a
 * stored conversation turn and on the wire (`chat:start`, `agent:invoke`,
 * `conversations:get`, `event.turn-end`).
 *
 * Addressed by id, never by path (Invariant I1): where the bytes sit — the
 * blob store on the host, a scratch copy inside the sandbox — is each side's
 * own business, so no sandbox or workspace layout reaches stored data.
 * Downloads go through `attachments:download`, which looks the id up and
 * checks it belongs to the conversation being read. `.strict()`: a block that
 * still carries a `path` is refused, not silently stripped.
 *
 * The runner translates this block per LLM call (image → `image` block, PDF →
 * `document` when supported, small text inlined, else a text mention); this
 * block stays the single canonical shape (I4).
 *
 * Stored blocks from before ids (`{ path, displayName, … }`) no longer parse.
 * `@ax/conversations` turns them into a "no longer available" text line on
 * read, so the turn around them survives.
 */
export const AttachmentBlockSchema = z
  .object({
    type: z.literal('attachment'),
    attachmentId: AttachmentIdSchema,
    filename: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
    mediaType: z.string().min(1).max(ATTACHMENT_MEDIA_TYPE_MAX),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;

/**
 * The download chip for an `artifact_publish` tool result. Maps the result
 * object `{ artifactId, displayName, mediaType, sizeBytes, … }` to an
 * `attachment` block, or returns `null` when any field is missing or fails the
 * block schema. The result rides a tool_result (model-adjacent data), so every
 * field is re-validated here; its `path` is deliberately dropped.
 */
export function attachmentBlockFromArtifact(value: unknown): AttachmentBlock | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const parsed = AttachmentBlockSchema.safeParse({
    type: 'attachment',
    attachmentId: v['artifactId'],
    filename: v['displayName'],
    mediaType: v['mediaType'],
    sizeBytes: v['sizeBytes'],
  });
  return parsed.success ? parsed.data : null;
}

/** Longest key an `agent_file` block may carry (UTF-16 code units). */
export const AGENT_FILE_PATH_MAX = 4096;

/** Longest single name in a key: what `safePath` keeps of one segment. */
const AGENT_FILE_SEGMENT_MAX = 255;
const LEADING_SPACE = /^\s/;
const TRAILING_SPACE_OR_DOT = /[\s.]$/;

/**
 * Whether `key` is a key the Files tab can address, so a runner never
 * attaches a chip that can only fail to download.
 *
 * Mirrors channel-web's `workspaceFilePath` (the path check on the agent
 * files routes), which runs v1's `safePath` and refuses anything it would
 * have to change: no NUL; split on `/`, every
 * segment is 1–255 UTF-16 units, contains no `\`, `:` or `..`, does not
 * start with whitespace, and does not end in whitespace or a dot (a leading
 * dot is fine: `.gitignore`). That function needs `node:path` and this
 * package must stay browser-safe, so the rules are restated here, and a
 * parity test in channel-web keeps the two from drifting.
 *
 * Two rules are this protocol's own: a key is at most `AGENT_FILE_PATH_MAX`
 * units, and it must survive `encodeURIComponent` — the chip's URL builder
 * would throw on a lone surrogate.
 *
 * Prefer loosening. Stored transcripts are re-checked when they are read.
 * Since TASK-1017 a block that fails `AgentFileBlockSchema` is shown as
 * `<name> (this file is no longer available)` (conversations'
 * `degradeInvalidAgentFileBlocks`). So tightening the rule costs every stored
 * chip it stops accepting its download, but never its turn. The parity test
 * pins the rule to `safePath`, so the two change together.
 */
export function isAgentFilePath(key: string): boolean {
  if (key.length === 0 || key.length > AGENT_FILE_PATH_MAX) return false;
  if (key.includes('\u0000')) return false;
  try {
    encodeURIComponent(key);
  } catch {
    return false;
  }
  for (const segment of key.split('/')) {
    if (segment.length === 0 || segment.length > AGENT_FILE_SEGMENT_MAX) return false;
    if (segment.includes('\\') || segment.includes(':') || segment.includes('..')) return false;
    if (LEADING_SPACE.test(segment) || TRAILING_SPACE_OR_DOT.test(segment)) return false;
  }
  return true;
}

/** An `agent_file` key; the rules are `isAgentFilePath`'s. */
export const AgentFilePathSchema = z
  .string()
  .min(1)
  .max(AGENT_FILE_PATH_MAX)
  .refine(isAgentFilePath, { message: 'not a key the Files tab can address' });

/**
 * A file the agent created in its files during a turn, attached by
 * reference (TASK-1012). The chip downloads the file itself, live, by its
 * key: nothing is copied into the blob store, so the file is charged once.
 *
 * `path` is the file's key relative to the agent's files root: the same key,
 * under the same field name, that the Files tab lists it by
 * (`UserFileEntry.path`). It is never a sandbox path, never starts at a
 * mount point, and names no export or bucket (Invariant I1). The provider
 * behind the agent files may be a mount, a bucket, or a table. Unlike
 * `attachment`, whose bytes are a copy addressed by id, this block names
 * the one place the bytes live (I4).
 *
 * The block names no agent: the host derives it from the conversation the
 * turn belongs to, never from the block or the client. It has no `filename`
 * either: the host derives the label from the key's last segment, so a chip
 * cannot show one name and download another. `.strict()` refuses a block
 * that carries either, rather than stripping it. `mediaType` and
 * `sizeBytes` describe the file as the turn left it, for display.
 *
 * Only a runner's `event.turn-end` may carry one. `POST /api/chat/messages`
 * refuses a browser-sent block.
 */
export const AgentFileBlockSchema = z
  .object({
    type: z.literal('agent_file'),
    path: AgentFilePathSchema,
    mediaType: z.string().min(1).max(ATTACHMENT_MEDIA_TYPE_MAX),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type AgentFileBlock = z.infer<typeof AgentFileBlockSchema>;

/**
 * The `agent_file` block for these fields, or `null` when any of them fails
 * the block schema. A name the Files tab cannot address is one such case,
 * so a caller can say so instead of attaching a chip that always fails.
 */
export function agentFileBlock(v: {
  path: unknown;
  mediaType: unknown;
  sizeBytes: unknown;
}): AgentFileBlock | null {
  const parsed = AgentFileBlockSchema.safeParse({
    type: 'agent_file',
    path: v.path,
    mediaType: v.mediaType,
    sizeBytes: v.sizeBytes,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The most content blocks one `event.turn-end`, or one `AgentMessage`, may
 * carry on the IPC wire (TASK-945). Runner data is untrusted. An array over
 * its `.max()` is refused right after its size issue, before any element is
 * parsed.
 *
 * Sized so real traffic never reaches it: a refused turn-end loses that
 * turn's whole display frame. One turn-end carries a whole multi-step turn:
 * every assistant block, or every tool result plus one chip per file the
 * turn created (up to 10,000). The aisdk runner stops at 100 steps; the
 * claude-sdk runner emits one block per SDK block and is bounded by time.
 *
 * The same limit applies to `session.next-message`, whose messages the host
 * re-checks before sending (a failure there is a 500; after three retries
 * the runner's message pull throws and the runner exits). Nothing queues
 * that many: chat caps a user message at 20 blocks
 * (`PostMessageRequest`), and the orchestrator queues it as-is. A producer
 * that could approach this limit must refuse at the queue, not on the wire.
 *
 * Not applied to `tool_result.content`: this schema also re-parses stored
 * transcripts, and the conversations read path drops a turn that fails it.
 */
export const CONTENT_BLOCKS_MAX = 50_000;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
  AttachmentRefBlockSchema,
  AttachmentBlockSchema,
  AgentFileBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
