// ---------------------------------------------------------------------------
// Phase 2 — attachment-translation pass.
//
// Maps `ContentBlock[]` (the canonical stored-transcript shape) onto the
// Anthropic SDK's user-message content shape, one block at a time. Runs
// at user-message handoff to the SDK (and again on transcript replay).
//
// Translation rules per the design doc:
//   - `text` / `tool_use` / `tool_result` / etc.: pass through unchanged.
//   - `attachment` with mediaType image/*: read bytes via injected reader,
//     emit Anthropic `image` block with base64 source.
//   - `attachment` with mediaType application/pdf AND
//     `supportsDocumentBlocks`: read bytes, emit `document` block.
//   - Anything else (including missing bytes for image/pdf): text mention
//     `"User attached '<displayName>' at <path> (<mediaType>)"`.
//
// Byte fetch is via injected `readWorkspace` — the runner wires this to
// `client.call('workspace.read', { path })` at startup, but the
// translation function itself stays pure-function-testable.
// ---------------------------------------------------------------------------

import type { AttachmentBlock, ContentBlock } from '@ax/ipc-protocol';

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
  if (!isImage && !(isPdf && opts.supportsDocumentBlocks)) {
    return textMention(att);
  }
  const read = await opts.readWorkspace(att.path);
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
  // PDF + supportsDocumentBlocks branch.
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: read.bytesBase64,
    },
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
