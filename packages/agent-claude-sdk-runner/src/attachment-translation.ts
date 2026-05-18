// ---------------------------------------------------------------------------
// Phase 2 — attachment-translation pass.
//
// Maps `ContentBlock[]` (the canonical stored-transcript shape) onto the
// Anthropic SDK's user-message content shape, one block at a time. Runs
// at user-message handoff to the SDK (and again on transcript replay).
//
// Translation rules per the design doc + weak-model accommodation:
//   - `text` / `tool_use` / `tool_result` / etc.: pass through unchanged.
//   - `attachment` with mediaType image/*: read bytes via injected reader,
//     emit Anthropic `image` block with base64 source.
//   - `attachment` with mediaType application/pdf AND
//     `supportsDocumentBlocks`: read bytes, emit `document` block.
//   - `attachment` with a text-ish mediaType (text/*, application/json,
//     application/xml, application/yaml) AND sizeBytes ≤ MAX_INLINE_BYTES:
//     read bytes, inline as a text block with a provenance preamble so
//     the model gets the content directly. Critical for weaker models
//     that can't reliably figure out "the file is at <path>, I should
//     call Read" — the bytes are just there in the prompt.
//   - Anything else (including missing bytes for image/pdf, oversized
//     text, unrecognized binary types): text mention
//     `"User attached '<displayName>' at <path> (<mediaType>)"`.
//
// The stored-transcript shape is NEVER modified — translation transforms
// blocks only on the way to the SDK. Web-UI download paths (Phase 3) read
// from the stored transcript and resolve the `attachment.path` via
// `attachments:download`, unaffected by what the runner did mid-turn.
//
// Byte fetch is via injected `readWorkspace` — the runner wires this to
// `client.call('workspace.read', { path })` at startup, but the
// translation function itself stays pure-function-testable.
// ---------------------------------------------------------------------------

import type { AttachmentBlock, ContentBlock } from '@ax/ipc-protocol';

// 64 KiB. Text content under this size is inlined into the SDK prompt
// directly so weaker models don't need to know about the Read tool. At
// ~25K tokens worst case for dense ASCII this stays a tiny fraction of
// any production Claude context. Files above this fall back to a text
// mention; a future "fetch_attachment" tool can serve the long tail.
export const MAX_INLINE_BYTES = 64 * 1024;

// MIME types whose bytes are safely renderable as UTF-8 text in a prompt.
// We keep the list small and explicit rather than pattern-matching every
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

export interface WorkspaceReader {
  (path: string): Promise<
    { found: true; bytesBase64: string } | { found: false }
  >;
}

export interface TranslationOptions {
  readWorkspace: WorkspaceReader;
  supportsDocumentBlocks: boolean;
}

// Anthropic SDK shape — the union we emit. Loose typing here keeps the
// runner decoupled from the pinned SDK's internal types; the SDK
// accepts any compatible shape on the `message.content` field.
type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: string; data: string };
    }
  // Pass-through for blocks we don't touch (tool_use, thinking, etc.).
  // The SDK validates these by its own schema downstream.
  | Record<string, unknown>;

function textMention(att: AttachmentBlock): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `User attached '${att.displayName}' at ${att.path} (${att.mediaType})`,
  };
}

async function translateAttachment(
  att: AttachmentBlock,
  opts: TranslationOptions,
): Promise<AnthropicUserContentBlock> {
  const isImage = att.mediaType.startsWith('image/');
  const isPdf = att.mediaType === 'application/pdf';
  const isInlineableText =
    isInlineableTextMediaType(att.mediaType) &&
    att.sizeBytes <= MAX_INLINE_BYTES;

  // Anything not in the "fetch and inline" set short-circuits to text
  // mention without paying the IPC cost.
  if (!isImage && !(isPdf && opts.supportsDocumentBlocks) && !isInlineableText) {
    return textMention(att);
  }
  // IPC failures (host down, retries exhausted, schema-drift rejection)
  // degrade to a text mention so the model still sees the attachment's
  // provenance even when bytes are unavailable. Throwing here would abort
  // the entire user-message handoff to the SDK and terminate the turn —
  // disproportionate for a single missing image.
  let read: { found: true; bytesBase64: string } | { found: false };
  try {
    read = await opts.readWorkspace(att.path);
  } catch {
    return textMention(att);
  }
  if (!read.found) {
    return textMention(att);
  }
  if (isImage) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mediaType,
        data: read.bytesBase64,
      },
    };
  }
  if (isPdf && opts.supportsDocumentBlocks) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: read.bytesBase64,
      },
    };
  }
  // Inlineable text branch. Decode permissively — invalid UTF-8 sequences
  // become U+FFFD rather than throwing, so a mis-labeled binary file
  // produces noisy output rather than a turn-fatal error. The model can
  // see the noise and infer what happened; we don't pretend it's clean
  // content. (mediaType is server-claimed; we trust the claim and let
  // the model handle any mismatch — same posture the design doc takes
  // on MIME-spoofing.)
  const content = Buffer.from(read.bytesBase64, 'base64').toString('utf8');
  return {
    type: 'text',
    text: `User attached '${att.displayName}' (${att.mediaType}, ${att.sizeBytes} bytes):\n\n${content}`,
  };
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
    // mention so we don't crash mid-turn, and log via a thrown Error
    // would be safer but turn-fatal. Trade-off: silent skip is wrong
    // (model gets nothing), text mention preserves provenance.
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
