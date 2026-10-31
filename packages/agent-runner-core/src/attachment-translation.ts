// ---------------------------------------------------------------------------
// Attachment translation.
//
// Maps `ContentBlock[]` (the canonical stored shape) onto the Anthropic SDK's
// user-message content shape, one block at a time, when a user message is
// handed to the loop.
//
// An `attachment` block names its file by id. Its bytes come from the copy
// materializeUploads made in `<scratch>/uploads/` (`uploads`, by id):
//   - image/*: the bytes as an Anthropic `image` block.
//   - application/pdf, when the loop supports `document` blocks: a `document`.
//   - a text type (text/*, JSON, XML, YAML) of at most 64 KiB: the content,
//     inlined after a one-line mention, so a weaker model has the bytes in
//     front of it instead of having to think of opening the file.
//   - anything else: a one-line mention with the path the model can open.
//
// The copy sits in agent-writable scratch, so it is checked before it is
// trusted as the person's file. It is opened without following a symlink and
// without blocking on a pipe, must be a regular file of the listed size, and
// its bytes must hash to the listed sha256. A copy that fails any of that —
// rewritten, swapped for a link, deleted — and an id with no copy at all reach
// the model only as "User attached '<name>' (<type>), but the file could not
// be loaded." Content the agent wrote never comes back to it labelled as the
// person's upload.
//
// The stored transcript is never modified: translation shapes blocks only on
// the way to the loop. Downloads go through the host by id.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { AttachmentBlock, ContentBlock } from '@ax/ipc-protocol';
import { stripControlChars, type MaterializedUpload } from './materialize-uploads.js';

// 64 KiB. Text content under this size is inlined into the prompt directly so
// weaker models don't need to know about the Read tool. At ~25K tokens worst
// case for dense ASCII this stays a tiny fraction of any production context.
// Larger files get a mention; the model opens them itself.
export const MAX_INLINE_BYTES = 64 * 1024;

// MIME types whose bytes are safely renderable as UTF-8 text in a prompt.
// Kept small and explicit rather than pattern-matching every
// `application/*+json` variant — adding a type is a one-line change.
function isInlineableTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  return (
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/yaml' ||
    mediaType === 'application/x-yaml'
  );
}

export interface TranslationOptions {
  /** Uploads copied into the sandbox for this conversation, by attachment id. */
  uploads: ReadonlyMap<string, MaterializedUpload>;
  /** Whether the loop's provider accepts `document` content blocks. */
  supportsDocumentBlocks: boolean;
}

// ---------------------------------------------------------------------------
// The model-facing text of an attachment. Model-facing only: the display
// transcript stores the `attachment` block itself, and nothing parses these
// strings back.
// ---------------------------------------------------------------------------

export interface AttachmentMentionFields {
  /** The person's name for the file. */
  filename: string;
  /** Absolute path of the sandbox copy the model can open; null when there is none. */
  path: string | null;
  mediaType: string;
}

/**
 * The one-line mention: `User attached '<filename>' at <path> (<mediaType>)`,
 * or, with no usable copy, `User attached '<filename>' (<mediaType>), but the
 * file could not be loaded.` Control characters are dropped so it stays one line.
 */
export function formatAttachmentMention(att: AttachmentMentionFields): string {
  const filename = stripControlChars(att.filename);
  const mediaType = stripControlChars(att.mediaType);
  if (att.path === null) {
    return `User attached '${filename}' (${mediaType}), but the file could not be loaded.`;
  }
  return `User attached '${filename}' at ${stripControlChars(att.path)} (${mediaType})`;
}

/** An inlined text attachment: the mention, a blank line, then the content. */
export function formatAttachmentInline(fields: AttachmentMentionFields, content: string): string {
  return `${formatAttachmentMention(fields)}\n\n${content}`;
}

// Anthropic SDK shape — the union we emit. Loose typing keeps the runner
// decoupled from the pinned SDK's internal types; the SDK accepts any
// compatible shape on the `message.content` field.
type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  // Pass-through for blocks we don't touch (tool_use, thinking, etc.).
  // The SDK validates these by its own schema downstream.
  | Record<string, unknown>;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Check a copy is still the person's file and, when `keepBytes`, return its
 * bytes. Null for anything else: missing, a symlink (O_NOFOLLOW), not a regular
 * file (a pipe is opened O_NONBLOCK so it cannot hang us), the wrong size, or
 * bytes that do not hash to the listed sha256. The bytes returned are the
 * bytes that were hashed, read through one descriptor.
 */
async function verifiedCopy(
  upload: MaterializedUpload,
  keepBytes: boolean,
): Promise<{ bytes: Buffer | null } | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      upload.path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size !== upload.sizeBytes) return null;
    const hash = createHash('sha256');
    const kept = keepBytes ? Buffer.alloc(upload.sizeBytes) : null;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      // Grew since the stat: not the file that was listed.
      if (total + bytesRead > upload.sizeBytes) return null;
      hash.update(chunk.subarray(0, bytesRead));
      kept?.set(chunk.subarray(0, bytesRead), total);
      total += bytesRead;
    }
    if (total !== upload.sizeBytes || hash.digest('hex') !== upload.sha256) return null;
    return { bytes: kept };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {
      /* nothing left to do with it */
    });
  }
}

async function translateAttachment(
  att: AttachmentBlock,
  opts: TranslationOptions,
): Promise<AnthropicUserContentBlock> {
  const upload = opts.uploads.get(att.attachmentId);
  if (upload === undefined) {
    return {
      type: 'text',
      text: formatAttachmentMention({ filename: att.filename, path: null, mediaType: att.mediaType }),
    };
  }
  const { mediaType } = upload;
  const isImage = mediaType.startsWith('image/');
  const isDocument = mediaType === 'application/pdf' && opts.supportsDocumentBlocks;
  const isInlineText = isInlineableTextMediaType(mediaType) && upload.sizeBytes <= MAX_INLINE_BYTES;
  const fields = { filename: upload.filename, path: upload.path, mediaType };

  const copy = await verifiedCopy(upload, isImage || isDocument || isInlineText);
  if (copy === null) {
    return { type: 'text', text: formatAttachmentMention({ ...fields, path: null }) };
  }
  if (copy.bytes === null) {
    return { type: 'text', text: formatAttachmentMention(fields) };
  }
  if (isImage) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: copy.bytes.toString('base64') },
    };
  }
  if (isDocument) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: copy.bytes.toString('base64') },
    };
  }
  // Inlineable text. Decode permissively: invalid UTF-8 becomes U+FFFD rather
  // than throwing, so a mislabelled binary file produces visible noise rather
  // than a failed turn. The media type is the host's record of the upload;
  // the model sees any mismatch for itself.
  return { type: 'text', text: formatAttachmentInline(fields, copy.bytes.toString('utf8')) };
}

export async function translateContentBlocks(
  blocks: readonly ContentBlock[],
  opts: TranslationOptions,
): Promise<AnthropicUserContentBlock[]> {
  const out: AnthropicUserContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'attachment') {
      out.push(await translateAttachment(block, opts));
      continue;
    }
    // `attachment_ref` is a transit-only variant — it should never reach
    // the runner. If it does, it's a host bug; emit a defensive text
    // mention so we don't crash mid-turn (throwing would be turn-fatal, and
    // a silent skip would leave the model with nothing).
    if (block.type === 'attachment_ref') {
      out.push({
        type: 'text',
        text: `[runner: attachment_ref ${(block as { attachmentId: string }).attachmentId} not committed]`,
      });
      continue;
    }
    out.push(block as AnthropicUserContentBlock);
  }
  return out;
}
