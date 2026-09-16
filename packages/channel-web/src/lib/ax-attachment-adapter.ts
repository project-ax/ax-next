import type {
  AttachmentAdapter,
  PendingAttachment,
  CompleteAttachment,
} from '@assistant-ui/react';
import {
  ATTACHMENT_ACCEPT,
  AX_ATTACHMENT_URL_PREFIX,
  uploadAttachment,
} from './attachment-upload';

/**
 * AxAttachmentAdapter — assistant-ui AttachmentAdapter implementation that
 * speaks the AX `/api/attachments` upload endpoint.
 *
 * Phase 3 (2026-05-18). Replaces the previous "no adapter, attach button
 * hidden" posture documented in lib/runtime.tsx.
 *
 * Flow:
 *   add(file)
 *     → POST /api/attachments multipart
 *     → yield PendingAttachment(running:uploading, progress 0..1)
 *     → on success: yield PendingAttachment(requires-action:composer-send)
 *           with id = server-minted attachmentId.
 *   send(pending)
 *     → return CompleteAttachment with a `file` content part carrying
 *       `data: ax://attachment/<attachmentId>`. The transport's
 *       toContentBlocks() converts this to an `attachment_ref` block.
 *   remove()
 *     → no-op. Temp-store TTL (default 10 min) reclaims unsent uploads.
 *       Future: explicit DELETE /api/attachments/<id>.
 */
export class AxAttachmentAdapter implements AttachmentAdapter {
  accept = ATTACHMENT_ACCEPT;

  /**
   * assistant-ui identifies attachments by `id` — if `add()` yields two states
   * with different ids, the runtime treats them as two separate attachments
   * and renders both. So we keep the same `tempId` across both yields and
   * stash the server-minted attachmentId in this side map; `send()` reads it
   * back when constructing the wire URL.
   */
  private readonly serverIds = new Map<string, string>();

  async *add({
    file,
  }: {
    file: File;
  }): AsyncGenerator<PendingAttachment> {
    const tempId = crypto.randomUUID();
    yield {
      id: tempId,
      type: typeForMime(file.type),
      name: file.name,
      contentType: file.type || 'application/octet-stream',
      file,
      status: { type: 'running', reason: 'uploading', progress: 0 },
    };

    let lastProgress = 0;
    const result = await uploadAttachment(file, {
      onProgress: (progress) => {
        lastProgress = progress;
      },
    });
    void lastProgress; // observed via the promise's progress callback above

    this.serverIds.set(tempId, result.attachmentId);

    yield {
      id: tempId,
      type: typeForMime(result.mediaType),
      name: result.displayName,
      contentType: result.mediaType,
      file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(pending: PendingAttachment): Promise<CompleteAttachment> {
    const serverId = this.serverIds.get(pending.id) ?? pending.id;
    this.serverIds.delete(pending.id);
    return {
      id: pending.id,
      type: pending.type,
      name: pending.name,
      contentType: pending.contentType,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: `${AX_ATTACHMENT_URL_PREFIX}${serverId}`,
          mimeType: pending.contentType ?? 'application/octet-stream',
          filename: pending.name,
        },
      ],
    };
  }

  async remove(attachment?: { id?: string }): Promise<void> {
    if (attachment && typeof attachment.id === 'string') {
      this.serverIds.delete(attachment.id);
    }
    // Server-side TTL janitor reaps the unsent temp upload.
  }
}

function typeForMime(mime: string): PendingAttachment['type'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}
